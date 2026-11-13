import type { BrowseQuery, HomeData, HomeRow, HomeRowKind, Library, MediaItem, SourceInfo } from '@shared/media-types'
import { splitKey } from '@shared/media-types'
import { SourceError, type MediaSource, type PlayOptions } from '../sources/MediaSource'
import { silentLog, type Log } from '../log/Logger'
import { runtime, type Runtime } from '../core/runtime'
import { dedupe, hasProgress, normalTitle, onePerShow } from './dedupe'

export interface HomeOptions { rows: (HomeRowKind | 'libraries')[]; hiddenRows: string[]; mergeContinue: boolean }
export interface HubOptions {
  timeoutMs?: number; homeTimeoutMs?: number; searchTimeoutMs?: number; librariesTimeoutMs?: number
  browseTimeoutMs?: number; itemTimeoutMs?: number; childrenTimeoutMs?: number; playbackTimeoutMs?: number
  setWatchedTimeoutMs?: number; setFavouriteTimeoutMs?: number; cacheMs?: number; clock?: Runtime; logger?: Log
}
interface Entry { source: MediaSource; enabled: boolean; name?: string; failure?: Pick<SourceInfo, 'status' | 'message'> }

export class MediaHub {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private cache = new Map<string, { at: number; value: HomeData }>()
  private pending = new Map<string, Promise<HomeData>>()
  private generation = 0
  private clock: Runtime
  private logger: Log

  constructor(private opts: HubOptions = {}) { this.clock = opts.clock ?? runtime; this.logger = opts.logger ?? silentLog }
  add(source: MediaSource, enabled = true): void {
    this.entries.get(source.id)?.source.dispose()
    this.entries.set(source.id, { source, enabled })
    this.invalidate()
  }
  remove(id: string): void { this.entries.get(id)?.source.dispose(); this.entries.delete(id); this.invalidate() }
  rename(id: string, name: string, invalidate = true): void {
    const entry = this.entries.get(id)
    if (!entry || (entry.name ?? entry.source.name) === name) return
    entry.name = name
    if (invalidate) this.invalidate()
  }
  setEnabled(id: string, enabled: boolean, invalidate = true): void {
    const entry = this.entries.get(id)
    if (!entry || entry.enabled === enabled) return
    entry.enabled = enabled
    if (invalidate) this.invalidate()
  }
  get(id: string): MediaSource | undefined { return this.entries.get(id)?.source }
  list(): SourceInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.source.info(), name: entry.name ?? entry.source.name, ...entry.failure }))
  }
  sourceFor(key: string): MediaSource {
    let id: string
    try { id = splitKey(key).sourceId } catch {
      throw new SourceError('That item is no longer available. Choose another item.', 'notFound')
    }
    const source = this.get(id)
    if (!source) throw new SourceError("That library isn't connected any more.", 'notFound')
    return source
  }
  private active(): Entry[] { return [...this.entries.values()].filter((e) => e.enabled) }
  onChanged(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  refresh(): void { this.generation++; this.cache.clear(); this.pending.clear() }
  invalidate(): void { this.refresh(); for (const cb of this.listeners) cb() }

  async request<T>(source: MediaSource, fn: () => Promise<T>, ms = this.opts.timeoutMs ?? 8000,
    recordTimeout = true): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = this.clock.setTimeout(() => reject(new SourceError(
        `Can't reach ${this.entries.get(source.id)?.name ?? source.name}. Check the server is switched on.`, 'timeout')), ms)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(fn), timeout])
      const entry = this.entries.get(source.id)
      if (entry) entry.failure = undefined
      return result
    } catch (error) {
      this.logger.error(`Library request failed (${source.id})`, error)
      const wrapped = error instanceof SourceError ? error : new SourceError(
        `Something went wrong talking to ${this.entries.get(source.id)?.name ?? source.name}. Try again in a moment.`, 'server')
      const entry = this.entries.get(source.id)
      if (entry && (recordTimeout || wrapped.code !== 'timeout') &&
        ['offline', 'timeout', 'auth', 'server'].includes(wrapped.code)) entry.failure = {
        status: wrapped.code === 'auth' ? 'signed-out' : ['offline', 'timeout'].includes(wrapped.code) ? 'offline' : 'error',
        message: wrapped.code === 'auth' ? source.info().message ?? wrapped.message : wrapped.message,
      }
      throw wrapped
    } finally { if (timer) this.clock.clearTimeout(timer) }
  }

  async home(opts: HomeOptions): Promise<HomeData> {
    const key = JSON.stringify(opts)
    const cached = this.cache.get(key)
    if (cached && this.clock.now() - cached.at < (this.opts.cacheMs ?? 60_000)) return structuredClone(cached.value)
    let pending = this.pending.get(key)
    if (!pending) {
      const generation = this.generation
      pending = this.buildHome(opts).then((value) => {
        if (generation === this.generation) this.cache.set(key, { at: this.clock.now(), value })
        return value
      }).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key) })
      this.pending.set(key, pending)
    }
    return structuredClone(await pending)
  }

  private async buildHome(opts: HomeOptions): Promise<HomeData> {
    const entries = this.active()
    const results = await Promise.all(entries.map(({ source }) => this.request(source, async () => {
      const [rows, libraries] = await Promise.all([source.rows(), source.libraries()])
      const libraryRows = opts.rows.some((kind) => kind === 'library' || kind === 'libraries')
        ? await Promise.all(libraries.map(async (lib): Promise<HomeRow> => ({
          id: `lib:${lib.key}`,
          title: entries.length > 1 ? `${lib.title} · ${this.entries.get(source.id)?.name ?? source.name}` : lib.title,
          kind: 'library', libraryKey: lib.key,
          items: (await source.browse(lib.id, { sort: 'added', descending: true, offset: 0, limit: 20 })).items,
        }))) : []
      return { rows, libraryRows }
    }, this.opts.homeTimeoutMs ?? this.opts.timeoutMs ?? 8000).catch(() => undefined)))
    const good = results.filter((result) => result !== undefined)
    const resume = dedupe(good.flatMap((r) => r.rows.resume)).sort(byLastPlayed)
    const next = dedupe(good.flatMap((r) => r.rows.nextUp))
    const latest = dedupe(good.flatMap((r) => r.rows.latest)).sort(byAdded)
    const rows: HomeRow[] = []
    for (const kind of opts.rows) {
      if (opts.hiddenRows.includes(kind) || (kind === 'library' && opts.hiddenRows.includes('libraries'))) continue
      if (kind === 'continue') rows.push({ id: kind, kind, title: 'Continue watching',
        items: (opts.mergeContinue ? onePerShow(dedupe([...resume, ...next]).sort(byLastPlayed)) : resume).slice(0, 20) })
      if (kind === 'nextUp' && !opts.mergeContinue) rows.push({ id: kind, kind, title: 'Next up', items: next.slice(0, 20) })
      if (kind === 'latest') rows.push({ id: kind, kind, title: 'Recently added', items: latest.slice(0, 24) })
      if (kind === 'library' || kind === 'libraries') {
        rows.push(...good.flatMap((r) => r.libraryRows).filter((r) => !opts.hiddenRows.includes(r.id)))
      }
    }
    return { rows: rows.filter((row) => row.items.length),
      hero: dedupe([...resume.filter(hasProgress), ...latest]).filter((i) => i.images.backdrop).slice(0, 6),
      sources: this.list(), generatedAt: new Date(this.clock.now()).toISOString() }
  }

  async libraries(): Promise<Library[]> {
    return (await Promise.all(this.active().map(({ source }) => this.request(source, () => source.libraries(),
      this.opts.librariesTimeoutMs ?? this.opts.timeoutMs ?? 8000)
      .catch(() => [])))).flat()
  }
  browse(key: string, query: BrowseQuery) {
    const source = this.sourceFor(key)
    return this.request(source, () => source.browse(splitKey(key).id, query), this.opts.browseTimeoutMs ?? this.opts.timeoutMs ?? 8000)
  }
  item(key: string) {
    const s = this.sourceFor(key)
    return this.request(s, () => s.item(splitKey(key).id), this.opts.itemTimeoutMs ?? this.opts.timeoutMs ?? 8000)
  }
  children(key: string) {
    const s = this.sourceFor(key)
    return this.request(s, () => s.children(splitKey(key).id), this.opts.childrenTimeoutMs ?? this.opts.timeoutMs ?? 8000)
  }
  playback(key: string, opts: PlayOptions) {
    const s = this.sourceFor(key)
    return this.request(s, () => s.playback(splitKey(key).id, opts), this.opts.playbackTimeoutMs ?? 15_000)
  }
  async setWatched(key: string, watched: boolean): Promise<void> {
    const source = this.sourceFor(key)
    await this.request(source, () => source.setWatched(splitKey(key).id, watched), this.opts.setWatchedTimeoutMs ?? 15_000)
    this.invalidate()
  }
  async setFavourite(key: string, favourite: boolean): Promise<void> {
    const source = this.sourceFor(key)
    await this.request(source, () => source.setFavourite(splitKey(key).id, favourite), this.opts.setFavouriteTimeoutMs ?? 15_000)
    this.invalidate()
  }
  async search(text: string): Promise<MediaItem[]> {
    const query = text.trim()
    if (!query) return []
    const result = (await Promise.all(this.active().map(({ source }) => this.request(source, () => source.search(query),
      this.opts.searchTimeoutMs ?? 4000, false)
      .catch(() => [])))).flat()
    const exact = (item: MediaItem) => normalTitle(item.title) === normalTitle(query) ? 0 : 1
    return dedupe(result).sort((a, b) => exact(a) - exact(b)).slice(0, 60)
  }
  dispose(): void {
    for (const { source } of this.entries.values()) source.dispose()
    this.listeners.clear(); this.refresh()
  }
}

function byLastPlayed(a: MediaItem, b: MediaItem): number { return (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') }
function byAdded(a: MediaItem, b: MediaItem): number { return (b.addedAt ?? '').localeCompare(a.addedAt ?? '') }
