import type { BrowseQuery, ImageKind, Library, MediaItem, MediaItemDetail, Page, SourceInfo } from '@shared/media-types'
import { SourceError, type ImageRequest, type MediaSource, type PlaybackPlan, type PlayOptions,
  type ReportEvent, type ReportHandle } from '../MediaSource'
import { PlexClient, PlexHttpError, connectionUrl, type Query } from './PlexClient'
import { PlexTv, type PlexIdentity, type PlexServer } from './PlexTv'
import { raceConnections, savedConnection, type Connection } from './connections'
import { array, container, number, object, readItem, records, type PlexItem } from './guards'
import { artwork, artworkPath, mapDetail, mapItem, mapLibrary, type Artwork } from './mappers'
import { Lru } from '../jellyfin/cache'
import { runtime } from '../../core/runtime'
import { playbackPlan } from './playback'

export interface PlexOptions extends PlexIdentity {
  id: string; name: string; serverId: string; userId: string; userName?: string
  url?: string; token?: string; accountToken?: string; onConnection?: (url: string) => void
}
const segment = encodeURIComponent
export class PlexSource implements MediaSource {
  readonly id: string
  readonly kind = 'plex' as const
  readonly name: string
  private signedOut: boolean
  private client?: PlexClient
  private current?: string
  private tv: PlexTv
  private controller = new AbortController()
  private finding?: Promise<PlexClient>
  private refinding?: Promise<Connection | undefined>
  private lastRefind = -Infinity
  private art = new Lru<Artwork>(5000)
  private libraryKinds = new Map<string, Library['kind']>()
  constructor(private opts: PlexOptions) {
    this.id = opts.id; this.name = opts.name; this.signedOut = !opts.token
    this.current = opts.url ? connectionUrl(opts.url) : undefined
    this.tv = new PlexTv(this.identity())
  }
  private identity(): PlexIdentity & { signal: AbortSignal } {
    const { clientId, deviceName, appVersion, fetch, clock, logger } = this.opts
    return { clientId, deviceName, appVersion, fetch, clock, logger, signal: this.controller.signal }
  }
  info(): SourceInfo {
    return { id: this.id, kind: this.kind, name: this.name, serverName: this.name, userName: this.opts.userName,
      url: this.current, status: this.signedOut ? 'signed-out' : 'ok',
      ...(this.signedOut ? { message: `Sign in to ${this.name} again in Settings.` } : {}) }
  }
  private guard(): void {
    if (this.signedOut) throw new SourceError(`Sign in to ${this.name} again in Settings.`, 'auth')
    if (this.controller.signal.aborted) throw this.offline()
  }
  private offline(): SourceError { return new SourceError(`Can't reach ${this.name}. Check the server is switched on.`, 'offline') }
  private use(connection: Connection): PlexClient {
    this.guard()
    this.client?.dispose()
    const changed = connection.url !== this.current
    this.current = connection.url
    this.client = new PlexClient({ ...this.identity(), url: connection.url, name: this.name, token: this.opts.token,
      onAuthError: () => { this.signedOut = true } })
    if (changed) {
      try { this.opts.onConnection?.(connection.url) } catch { this.opts.logger?.warn('Plex connection could not be saved') }
    }
    return this.client
  }
  private async discover(): Promise<Connection | undefined> {
    if (!this.opts.accountToken) return undefined
    let servers: PlexServer[]
    try { servers = await this.tv.servers(this.opts.accountToken) } catch (error) {
      if (error instanceof SourceError && error.code === 'auth') { this.signedOut = true; throw error }
      return undefined
    }
    this.guard()
    const server = servers.find((s) => s.clientIdentifier === this.opts.serverId)
    return server ? raceConnections(server, this.identity()) : undefined
  }
  private async connected(): Promise<PlexClient> {
    this.guard()
    if (this.client) return this.client
    if (!this.finding) {
      this.finding = (async () => {
        const saved = this.current ? await savedConnection(this.current, this.opts.serverId, this.identity()) : undefined
        const found = saved ?? await this.discover()
        if (!found) throw this.offline()
        return this.use(found)
      })().finally(() => { this.finding = undefined })
    }
    return this.finding
  }
  private async request(path: string, query: Query = {}, method = 'GET', headers?: Record<string, string>): Promise<unknown> {
    const client = await this.connected()
    try { return await client.request(path, query, method, { headers }) } catch (error) {
      if (!(error instanceof SourceError) || !['offline', 'timeout'].includes(error.code)) throw error
      this.guard()
      const now = (this.opts.clock ?? runtime).now()
      if (!this.refinding && now - this.lastRefind >= 60_000) {
        this.lastRefind = now
        this.refinding = this.discover().catch((failure: unknown) => {
          if (failure instanceof SourceError && failure.code === 'auth') { this.signedOut = true; throw failure }
          return undefined
        }).finally(() => { this.refinding = undefined })
      }
      const found = await this.refinding
      const current = this.client
      if ((found && found.url !== client.base) || (current && current !== client)) {
        const next = current && current !== client ? current : this.use(found!)
        return next.request(path, query, method, { headers })
      }
      throw error
    }
  }
  private map(value: unknown): MediaItem | undefined {
    const item = mapItem(this.id, value), raw = readItem(value)
    if (item && raw) this.art.set(item.id, artwork(raw))
    return item
  }
  private mapped(values: unknown): MediaItem[] {
    return (array(values) ?? []).flatMap((v) => this.map(v) ?? [])
  }
  private async list(path: string, query: Query = {}): Promise<{ items: MediaItem[]; total: number }> {
    const reply = container(await this.request(path, { includeGuids: 1, ...query }), this.name)
    const items = this.mapped(reply.Metadata)
    return { items, total: number(reply.totalSize) ?? number(reply.size) ?? items.length }
  }
  async rows(): Promise<{ resume: MediaItem[]; nextUp: MediaItem[]; latest: MediaItem[] }> {
    const continuing = this.list('/hubs/continueWatching/items').catch((e: unknown) => {
      if (e instanceof PlexHttpError && e.status === 404) return this.list('/library/onDeck')
      throw e
    })
    const [watching, recent] = await Promise.all([continuing, this.list('/library/recentlyAdded', {
      'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 60,
    })])
    const ordered = new Map<string, MediaItem | undefined>()
    const newestAdded = new Map<string, string>()
    for (const item of recent.items) {
      const id = item.type === 'season' || item.type === 'episode' ? item.seriesId : item.id
      if (id && ['movie', 'show', 'season', 'episode'].includes(item.type)) {
        if (!ordered.has(id)) ordered.set(id, ['movie', 'show'].includes(item.type) ? item : undefined)
        if (item.addedAt && item.addedAt > (newestAdded.get(id) ?? '')) newestAdded.set(id, item.addedAt)
      }
    }
    const ids = [...ordered].filter(([, item]) => !item).map(([id]) => id)
    if (ids.length) for (const item of (await this.list(`/library/metadata/${ids.map(segment).join(',')}`)).items) {
      if (item.type === 'show' && ordered.has(item.id)) ordered.set(item.id, item)
    }
    for (const [id, item] of ordered) {
      const addedAt = newestAdded.get(id)
      if (item?.type === 'show' && addedAt && addedAt > (item.addedAt ?? '')) ordered.set(id, { ...item, addedAt })
    }
    return { resume: watching.items.filter((i) => (i.positionSec ?? 0) > 0).slice(0, 24),
      nextUp: watching.items.filter((i) => !(i.positionSec ?? 0)).slice(0, 24),
      latest: [...ordered.values()].flatMap((i) => i ?? []).slice(0, 24) }
  }
  async libraries(): Promise<Library[]> {
    const raw = container(await this.request('/library/sections'), this.name)
    const libs = records(raw.Directory).flatMap((r) => mapLibrary(this.id, r) ?? [])
    this.libraryKinds.clear()
    libs.forEach((lib) => this.libraryKinds.set(lib.id, lib.kind))
    return libs
  }
  async browse(libraryId: string, q: BrowseQuery): Promise<Page<MediaItem>> {
    this.guard()
    if (q.filter === 'favourites') return { items: [], total: 0, offset: q.offset }
    if (!this.libraryKinds.has(libraryId)) await this.libraries()
    const sorts = { title: 'titleSort', added: 'addedAt', year: 'year', rating: 'audienceRating' }
    return { ...await this.list(`/library/sections/${segment(libraryId)}/all`, {
      type: this.libraryKinds.get(libraryId) === 'shows' ? 2 : 1, sort: `${sorts[q.sort]}${q.descending ? ':desc' : ''}`,
      unwatched: q.filter === 'unwatched' ? 1 : undefined, 'X-Plex-Container-Start': q.offset, 'X-Plex-Container-Size': q.limit,
    }), offset: q.offset }
  }
  private async raw(id: string, onDeck = false): Promise<PlexItem> {
    const raw = container(await this.request(`/library/metadata/${segment(id)}`, {
      includeGuids: 1, includeOnDeck: onDeck ? 1 : undefined,
    }), this.name)
    const item = readItem(array(raw.Metadata)?.[0])
    if (!item) throw new SourceError(`That's no longer on ${this.name}.`, 'notFound')
    return item
  }
  async item(id: string): Promise<MediaItemDetail> {
    const raw = await this.raw(id, true), item = this.map(raw.raw)
    if (!item) throw new SourceError(`That's no longer on ${this.name}.`, 'notFound')
    const detail = mapDetail(item, raw)
    if (item.type === 'show') {
      detail.seasons = (await this.children(id)).filter((s) => s.type === 'season')
      detail.nextEpisode = this.mapped(object(raw.raw.OnDeck)?.Metadata).find((i) => i.type === 'episode') ??
        (detail.seasons[0] ? (await this.children(detail.seasons[0].id)).find((i) => i.type === 'episode') : undefined)
    }
    return detail
  }
  async children(id: string): Promise<MediaItem[]> {
    this.guard()
    let type = this.art.get(id)?.type
    if (!type) {
      const raw = await this.raw(id)
      this.map(raw.raw); type = raw.type
    }
    if (type !== 'show' && type !== 'season') return []
    return (await this.list(`/library/metadata/${segment(id)}/children`)).items.filter((i) =>
      i.type === (type === 'show' ? 'season' : 'episode'))
  }
  async search(text: string): Promise<MediaItem[]> {
    this.guard()
    if (!text.trim()) return []
    const raw = container(await this.request('/hubs/search', { query: text, limit: 20, includeGuids: 1 }), this.name)
    return records(raw.Hub).filter((h) => typeof h.type === 'string' && ['movie', 'show', 'episode'].includes(h.type))
      .flatMap((h) => this.mapped(h.Metadata)).slice(0, 50)
  }
  image(id: string, kind: ImageKind, w: number, h: number): ImageRequest {
    this.guard()
    if (!this.client) return { kind: 'none' }
    const art = this.art.get(id)
    const path = art ? artworkPath(art, kind) : kind === 'logo' ? undefined :
      `/library/metadata/${segment(id)}/${kind === 'backdrop' ? 'art' : 'thumb'}`
    if (!path) return { kind: 'none' }
    try {
      const safe = this.client.deliveryUrl(path)
      const target = /^https?:\/\//i.test(path) ? safe : path
      return { kind: 'http', url: this.client.url('/photo/:/transcode', { url: target, width: w, height: h, minSize: 1, upscale: 1 }),
        headers: { ...this.client.headers, Accept: 'image/*' }, authOrigin: new URL(this.client.base).origin }
    } catch { return { kind: 'none' } }
  }
  async setWatched(id: string, watched: boolean): Promise<void> {
    await this.request(watched ? '/:/scrobble' : '/:/unscrobble', { identifier: 'com.plexapp.plugins.library', key: id })
  }
  async setFavourite(_id: string, _fav: boolean): Promise<void> {
    this.guard()
    throw new SourceError("Plex doesn't have favourites, so this can't be saved.", 'unsupported')
  }
  async playback(id: string, opts: PlayOptions): Promise<PlaybackPlan> {
    const raw = await this.raw(id), item = this.map(raw.raw)
    if (!item) throw this.client!.failure('unsupported')
    let next: MediaItem | undefined
    if (item.type === 'episode' && item.seasonId) {
      const episodes = await this.children(item.seasonId), index = episodes.findIndex((i) => i.id === item.id)
      if (index >= 0) next = episodes[index + 1]
    }
    return playbackPlan({ client: () => this.client!, request: (path, query, method) => this.request(path, query, method) },
      raw, item, opts, next, this.opts.logger)
  }
  async report(handle: ReportHandle, event: ReportEvent): Promise<void> {
    const data = handle.data
    let firstError: unknown
    try {
      await this.request('/:/timeline', { ratingKey: data.ratingKey, key: `/library/metadata/${segment(handle.itemId)}`,
        state: event.state === 'start' || event.state === 'progress' ? 'playing' : event.state,
        time: Math.round(event.positionSec * 1000), duration: data.duration }, 'GET',
      { 'X-Plex-Session-Identifier': String(data.session) })
    } catch (error) { firstError = error }
    if (event.state === 'stopped' && data.method === 'transcode') {
      try { await this.client?.request('/video/:/transcode/universal/stop', { session: data.session }) }
      catch (error) { firstError ??= error }
    }
    if (firstError !== undefined) throw firstError
  }
  dispose(): void {
    this.controller.abort(); this.tv.dispose(); this.client?.dispose(); this.art.clear(); this.libraryKinds.clear()
  }
}
