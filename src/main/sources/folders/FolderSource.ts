import { join, sep, dirname } from 'node:path'
import type { BrowseQuery, MediaItem, MediaItemDetail, Page, SourceInfo } from '@shared/media-types'
import type { FolderRoot } from '../../system/SystemServices'
import type { Result } from '@shared/system-types'
import { SourceError, type ImageRequest, type MediaSource, type PlaybackPlan, type PlayOptions,
  type ReportEvent, type ReportHandle, type SubtitleRef } from '../MediaSource'
import { silentLog, type Log } from '../../log/Logger'
import { MissingPath, type DirEntry, type DirLister } from './listing'
import { type ProgressEntry, type ProgressStore } from './ProgressStore'
import { fileName, isVideo, mapEntry, natural, sidecars } from './names'

interface Options {
  id: 'folders'; name: 'Folders'; roots(): Promise<FolderRoot[]>; retry(id: string): Promise<Result>
  lister: DirLister; store: ProgressStore; clock?: { now(): number }; logger?: Log
}
/** How long a browse waits for a remount before saying the share can't be opened. Exported for tests. */
export const RETRY_WAIT_MS = 5000
const notFound = () => new SourceError('That item is no longer available. Choose another item.', 'notFound')
const normal = (p: string) => p.split(sep).join('/').replace(/\/$/, '')
function idParts(id: string): string[] {
  const segments = id.split('/')
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\0') || s.includes('\\'))) throw notFound()
  return segments
}

export class FolderSource implements MediaSource {
  readonly id = 'folders'
  readonly kind = 'folders'
  readonly name = 'Folders'
  private busy = new Set<string>()
  private down = new Map<string, number>()
  private retried = new Map<string, number>()
  private known = new Map<string, FolderRoot>()
  private cache = new Map<string, { at: number; entries: DirEntry[] }>()
  private clock: { now(): number }
  private logger: Log
  constructor(private opts: Options) { this.clock = opts.clock ?? { now: Date.now }; this.logger = opts.logger ?? silentLog }
  info(): SourceInfo { return { id: this.id, kind: this.kind, name: this.name, status: 'ok' } }
  private async roots(): Promise<FolderRoot[]> {
    const roots = await this.opts.roots()
    for (const root of roots) this.known.set(root.id, root)
    return roots
  }
  async libraries() {
    const counts = new Map<string, number>()
    return (await this.roots()).map((r) => {
      const count = (counts.get(r.name) ?? 0) + 1; counts.set(r.name, count)
      return { key: `folders~${r.id}`, sourceId: this.id, id: r.id,
        title: r.name + (count > 1 ? ` (${count})` : ''), kind: 'mixed' as const }
    })
  }
  private async locate(id: string): Promise<{ root: FolderRoot; segments: string[] }> {
    const segments = idParts(id)
    const root = (await this.roots()).find((r) => r.id === segments[0])
    if (!root) {
      const old = this.known.get(segments[0]!)
      if (old?.kind === 'usb') throw new SourceError(`The USB drive ${old.name} isn't plugged in any more.`, 'notFound')
      throw notFound()
    }
    return { root, segments: segments.slice(1) }
  }
  private offline(root: FolderRoot): SourceError {
    return new SourceError(`Can't open ${root.name}. Check ${root.server ?? root.name} is switched on, then try again.`, 'offline')
  }
  private async operate<T>(id: string, fn: (root: FolderRoot, segments: string[]) => Promise<T>): Promise<T> {
    // A second browse must not wait even for another helper round-trip while this root is busy.
    const remembered = this.known.get(idParts(id)[0]!)
    if (remembered && this.busy.has(remembered.id)) {
      throw new SourceError(`Still waiting for ${remembered.name}. Try again in a moment.`, 'timeout')
    }
    const { root, segments } = await this.locate(id)
    if (this.busy.has(root.id)) throw new SourceError(`Still waiting for ${root.name}. Try again in a moment.`, 'timeout')
    if ((this.down.get(root.id) ?? -Infinity) > this.clock.now()) throw this.offline(root)
    this.busy.add(root.id)
    try {
      if (!root.available) {
        if (this.clock.now() - (this.retried.get(root.id) ?? -Infinity) >= 60_000) {
          this.retried.set(root.id, this.clock.now())
          // A remount can take half a minute. Wait a few seconds, then answer, so Home isn't held up by one asleep
          // NAS; the helper reports the share as changed once the remount finishes, and the screens reload.
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([this.opts.retry(root.id).catch(() => undefined),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, RETRY_WAIT_MS) })])
          clearTimeout(timer)
        }
        const fresh = (await this.roots()).find((r) => r.id === root.id)
        if (!fresh?.available) throw this.offline(root)
        Object.assign(root, fresh)
      }
      return await fn(root, segments)
    } catch (error) {
      if (error instanceof SourceError) throw error
      this.down.set(root.id, this.clock.now() + 60_000)
      this.logger.warn('Folder operation failed', root.id, error instanceof Error ? error.message : String(error))
      throw this.offline(root)
    } finally { this.busy.delete(root.id) }
  }
  private async contained(root: FolderRoot, segments: string[]): Promise<string> {
    const base = await this.opts.lister.realpath(root.path)
    // The root answered, so a missing path inside it was deleted or renamed: that isn't the share being down.
    const path = segments.length ? await this.opts.lister.realpath(join(root.path, ...segments)).catch((error: unknown) => {
      throw error instanceof MissingPath ? notFound() : error
    }) : base
    if (normal(path) !== normal(base) && !normal(path).startsWith(normal(base) + '/')) throw notFound()
    return path
  }
  private async listing(path: string): Promise<DirEntry[]> {
    const cached = this.cache.get(path)
    if (cached && this.clock.now() - cached.at < 30_000) return cached.entries
    const entries = await this.opts.lister.list(path)
    this.cache.set(path, { at: this.clock.now(), entries })
    // Keep the cache bounded as the owner browses a large tree.
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
    return entries
  }
  private mapped(parent: string, entries: DirEntry[], q: BrowseQuery): MediaItem[] {
    // Item keys are at most 300 characters on the way back in, so a deeper path could be shown but never opened.
    const items = entries.filter((e) => (e.type === 'dir' || isVideo(e.name)) && `folders~${parent}/${e.name}`.length <= 300)
      .map((e) => {
        const id = `${parent}/${e.name}`
        return mapEntry(id, e, this.opts.store.get(id))
      }).filter((i) => q.filter === 'unwatched' ? i.type === 'folder' || !i.watched : q.filter === 'favourites' ? i.favourite : true)
    const compare = (a: MediaItem, b: MediaItem) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      const title = natural.compare(a.title, b.title)
      const sorted = q.sort === 'added' ? (a.addedAt ?? '').localeCompare(b.addedAt ?? '') || title :
        q.sort === 'year' ? (a.year ?? 0) - (b.year ?? 0) || title : title
      return sorted * (q.descending ? -1 : 1)
    }
    return items.sort(compare)
  }
  browse(id: string, q: BrowseQuery): Promise<Page<MediaItem>> {
    return this.operate(id, async (root, segments) => {
      const entries = await this.listing(await this.contained(root, segments))
      const items = this.mapped(id, entries, q)
      return { items: items.slice(q.offset, q.offset + q.limit), total: items.length, offset: q.offset }
    })
  }
  private async details(id: string, root: FolderRoot, segments: string[]) {
    if (!segments.length) return { item: { key: `folders~${id}`, sourceId: this.id, id, type: 'folder' as const,
      title: root.name, images: {}, favourite: this.opts.store.get(id)?.favourite }, entries: [] as DirEntry[], entry: undefined,
    parentPath: root.path }
    const parentPath = await this.contained(root, segments.slice(0, -1))
    const entries = await this.listing(parentPath)
    const entry = entries.find((e) => e.name === segments.at(-1) && (e.type === 'dir' || isVideo(e.name)))
    if (!entry) throw notFound()
    return { item: mapEntry(id, entry, this.opts.store.get(id)), entries, entry, parentPath }
  }
  item(id: string): Promise<MediaItemDetail> {
    return this.operate(id, async (root, segments) => {
      const { item, entry } = await this.details(id, root, segments)
      const size = entry ? (entry.size >= 1024 ** 3 ? `${(entry.size / 1024 ** 3).toFixed(1)} GB` :
        `${(entry.size / 1024 ** 2).toFixed(1)} MB`) : undefined
      return { ...item, audioTracks: [], subtitleTracks: [],
        ...(item.type === 'video' ? { overview: `${size} · ${root.name}` } : {}) }
    })
  }
  async children(id: string): Promise<MediaItem[]> { return (await this.browse(id, { sort: 'title', offset: 0, limit: 500 })).items }
  async search(): Promise<MediaItem[]> { return [] }
  image(): ImageRequest { return { kind: 'none' } }
  async rows(): Promise<{ resume: MediaItem[]; nextUp: MediaItem[]; latest: MediaItem[] }> {
    const roots = new Set((await this.roots()).map((r) => r.id))
    return { resume: this.opts.store.entries().filter(([id, e]) => roots.has(id.split('/')[0]!) && e.type === 'video' &&
      (e.positionSec ?? 0) >= 30 && !e.watched).sort((a, b) => (b[1].lastPlayedAt ?? '').localeCompare(a[1].lastPlayedAt ?? ''))
      .slice(0, 20).map(([id, e]) => ({ key: `folders~${id}`, sourceId: this.id, id, type: 'video', title: e.title,
        subtitle: e.subtitle, images: {}, runtimeSec: e.durationSec, positionSec: e.positionSec,
        progress: e.durationSec ? Math.min(1, (e.positionSec ?? 0) / e.durationSec) : undefined,
        watched: e.watched, favourite: e.favourite, lastPlayedAt: e.lastPlayedAt })), nextUp: [], latest: [] }
  }
  playback(id: string, opts: PlayOptions): Promise<PlaybackPlan> {
    return this.operate(id, async (root, segments) => {
      const { item, entries } = await this.details(id, root, segments)
      if (item.type !== 'video') throw notFound()
      const url = await this.contained(root, segments)
      const subtitles: SubtitleRef[] = []
      // Resolve sidecars too: a replaced parent directory must not introduce an escape. A subtitle deleted since the
      // folder was listed is just left out; it mustn't stop the film playing.
      for (const subtitle of sidecars(segments.at(-1)!, entries, dirname(url))) {
        try {
          subtitle.url = await this.contained(root, [...segments.slice(0, -1), subtitle.url.split(sep).at(-1)!])
          subtitles.push(subtitle)
        } catch (error) {
          if (!(error instanceof SourceError && error.code === 'notFound')) throw error
          this.logger.info('Folder subtitle no longer there', root.id)
        }
      }
      const parent = id.slice(0, id.lastIndexOf('/'))
      const videos = this.mapped(parent, entries, { sort: 'title', offset: 0, limit: 5000 }).filter((i) => i.type === 'video')
      const index = videos.findIndex((i) => i.id === id)
      const stored = this.opts.store.get(id)
      return { url, headers: {}, startSec: opts.resume ? stored?.positionSec ?? 0 : 0, durationSec: stored?.durationSec,
        method: 'direct', subtitles, next: videos[index + 1], report: { sourceId: this.id, itemId: id, data: {} }, item }
    })
  }
  async report(h: ReportHandle, e: ReportEvent): Promise<void> {
    if (h.sourceId !== this.id || !Number.isFinite(e.positionSec) || e.positionSec < 0) return
    // Only check the id's shape: asking the helper here could lose the resume point if it's briefly busy, and the
    // store keeps entries for shares that come and go anyway.
    idParts(h.itemId)
    const old = this.opts.store.get(h.itemId)
    const parsed = fileName(h.itemId.split('/').at(-1)!)
    const durationSec = e.durationSec && Number.isFinite(e.durationSec) && e.durationSec > 0 ? e.durationSec : old?.durationSec
    const watched = durationSec && e.positionSec >= durationSec * 0.9 ? true : old?.watched
    this.opts.store.set(h.itemId, { ...old, title: old?.title ?? parsed.title, subtitle: old?.subtitle ?? parsed.subtitle,
      type: 'video', durationSec, watched, positionSec: watched || e.positionSec < 30 ? 0 : e.positionSec,
      lastPlayedAt: new Date(this.clock.now()).toISOString() })
  }
  private async updateFlag(id: string, flag: Partial<ProgressEntry>): Promise<void> {
    const item = await this.item(id)
    this.opts.store.set(id, { ...this.opts.store.get(id), title: item.title, subtitle: item.subtitle,
      type: item.type === 'folder' ? 'folder' : 'video', ...flag })
  }
  setWatched(id: string, watched: boolean): Promise<void> {
    return this.updateFlag(id, { watched, ...(watched ? { positionSec: 0 } : {}) })
  }
  setFavourite(id: string, favourite: boolean): Promise<void> { return this.updateFlag(id, { favourite }) }
  dispose(): void { this.cache.clear() }
}
