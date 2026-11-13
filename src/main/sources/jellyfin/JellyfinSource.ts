import type { BrowseQuery, ImageKind, Library, MediaItem, MediaItemDetail, Page, SourceInfo } from '@shared/media-types'
import { SourceError, type ImageRequest, type MediaSource, type PlaybackPlan, type PlayOptions,
  type ReportEvent, type ReportHandle } from '../MediaSource'
import { JellyfinClient, type ClientOptions, type Query } from './JellyfinClient'
import type { ItemDto } from './dto'
import { array, number, readItem, reply } from './guards'
import { mapDetail, mapItem, mapLibrary, TICKS } from './mappers'
import { Lru } from './cache'
import { playbackPlan } from './playback'

export interface JellyfinOptions extends ClientOptions { id: string; serverId: string; userId: string; userName?: string }
const fields = { Fields: 'Overview,ProviderIds,Genres,DateCreated,PremiereDate,ParentId',
  enableImageTypes: 'Primary,Backdrop,Thumb,Logo' }
const segment = encodeURIComponent
type Artwork = Pick<ItemDto, 'Type' | 'ImageTags' | 'BackdropImageTags' | 'SeriesId' | 'SeriesPrimaryImageTag' |
  'ParentBackdropItemId' | 'ParentBackdropImageTags' | 'ParentPrimaryImageItemId' | 'ParentPrimaryImageTag' |
  'ParentThumbItemId' | 'ParentThumbImageTag' | 'SeriesThumbImageTag' | 'ParentLogoItemId' | 'ParentLogoImageTag' | 'SeriesLogoImageTag'>

export class JellyfinSource implements MediaSource {
  readonly id: string
  readonly kind = 'jellyfin' as const
  readonly name: string
  private signedOut: boolean
  private client: JellyfinClient
  private artwork = new Lru<Artwork>(5000)
  private parents = new Lru<{ type: string; seriesId?: string }>(256)
  private libraryKinds = new Map<string, Library['kind']>()
  constructor(private opts: JellyfinOptions) {
    this.id = opts.id; this.name = opts.name; this.signedOut = !opts.token
    this.client = new JellyfinClient({ ...opts, onAuthError: () => { this.signedOut = true } })
  }
  info(): SourceInfo {
    return { id: this.id, kind: this.kind, name: this.name, serverName: this.name, url: this.client.base,
      userName: this.opts.userName, status: this.signedOut ? 'signed-out' : 'ok',
      ...(this.signedOut ? { message: `Sign in to ${this.name} again in Settings.` } : {}) }
  }
  private guard(): void {
    if (this.signedOut) throw new SourceError(`Sign in to ${this.name} again in Settings.`, 'auth')
  }
  private request<T>(path: string, query: Query = {}, method = 'GET', body?: unknown): Promise<T> {
    this.guard()
    return this.client.request<T>(path, query, method, body)
  }
  private map(value: unknown): MediaItem | undefined {
    const raw = readItem(value)
    if (!raw) return undefined
    const item = mapItem(this.id, raw)
    if (item) {
      const { Type, ImageTags, BackdropImageTags, SeriesId, SeriesPrimaryImageTag, ParentBackdropItemId, ParentBackdropImageTags,
        ParentPrimaryImageItemId, ParentPrimaryImageTag, ParentThumbItemId, ParentThumbImageTag, SeriesThumbImageTag,
        ParentLogoItemId, ParentLogoImageTag, SeriesLogoImageTag } = raw
      this.artwork.set(raw.Id, { Type, ImageTags, BackdropImageTags, SeriesId, SeriesPrimaryImageTag, ParentBackdropItemId,
        ParentBackdropImageTags, ParentPrimaryImageItemId, ParentPrimaryImageTag, ParentThumbItemId, ParentThumbImageTag,
        SeriesThumbImageTag, ParentLogoItemId, ParentLogoImageTag, SeriesLogoImageTag })
      this.parents.set(raw.Id, { type: raw.Type, seriesId: raw.SeriesId })
    }
    return item
  }
  private async list(path: string, query: Query = {}): Promise<{ items: MediaItem[]; total: number }> {
    const raw = await this.request<unknown>(path, { userId: this.opts.userId, ...fields, ...query })
    const envelope = Array.isArray(raw) ? undefined : reply(raw, this.name)
    const list = array(raw) ?? array(envelope?.Items) ?? []
    const items = list.flatMap((r) => { const mapped = this.map(r); return mapped ? [mapped] : [] })
    return { items, total: number(envelope?.TotalRecordCount) ?? items.length }
  }
  async rows(): Promise<{ resume: MediaItem[]; nextUp: MediaItem[]; latest: MediaItem[] }> {
    const [resume, nextUp, latest] = await Promise.all([
      this.list('/UserItems/Resume', { mediaTypes: 'Video', limit: 24 }), this.list('/Shows/NextUp', { limit: 24 }),
      this.list('/Items/Latest', { limit: 24, includeItemTypes: 'Movie,Series' }),
    ])
    return { resume: resume.items, nextUp: nextUp.items, latest: latest.items }
  }
  async libraries(): Promise<Library[]> {
    const raw = reply(await this.request<unknown>('/UserViews', { userId: this.opts.userId }), this.name)
    const libraries = (array(raw.Items) ?? []).flatMap((r) => { const lib = mapLibrary(this.id, r); return lib ? [lib] : [] })
    this.libraryKinds.clear()
    for (const lib of libraries) this.libraryKinds.set(lib.id, lib.kind)
    return libraries
  }
  async browse(libraryId: string, q: BrowseQuery): Promise<Page<MediaItem>> {
    this.guard()
    if (!this.libraryKinds.has(libraryId)) await this.libraries()
    const sorts = { title: 'SortName', added: 'DateCreated,SortName', year: 'ProductionYear,SortName', rating: 'CommunityRating,SortName' }
    const result = await this.list('/Items', { ParentId: libraryId, Recursive: true,
      IncludeItemTypes: this.libraryKinds.get(libraryId) === 'mixed' ? 'Movie,Series,Video' : 'Movie,Series',
      StartIndex: q.offset, Limit: q.limit, EnableTotalRecordCount: true, SortBy: sorts[q.sort],
      SortOrder: q.descending ? 'Descending' : 'Ascending',
      Filters: q.filter === 'unwatched' ? 'IsUnplayed' : q.filter === 'favourites' ? 'IsFavorite' : undefined })
    return { ...result, offset: q.offset }
  }
  private async raw(id: string): Promise<ItemDto> {
    const raw = reply(await this.request<unknown>(`/Items/${segment(id)}`, { userId: this.opts.userId, ...fields }), this.name)
    const item = readItem(raw)
    if (!item) throw new SourceError(`Something went wrong on ${this.name}. Try again in a moment.`, 'server')
    return item
  }
  private required(raw: ItemDto): MediaItem {
    const item = this.map(raw)
    if (!item) throw new SourceError(`That's no longer on ${this.name}.`, 'notFound')
    return item
  }
  async item(id: string): Promise<MediaItemDetail> {
    const raw = await this.raw(id)
    const detail = mapDetail(this.required(raw), raw)
    if (detail.type === 'show') {
      const [seasons, next] = await Promise.all([this.children(id), this.list('/Shows/NextUp', { seriesId: id, limit: 1 })])
      detail.seasons = seasons
      detail.nextEpisode = next.items[0] ?? (seasons[0] ? (await this.children(seasons[0].id))[0] : undefined)
    }
    return detail
  }
  async children(id: string): Promise<MediaItem[]> {
    this.guard()
    let parent = this.parents.get(id)
    if (!parent) { this.required(await this.raw(id)); parent = this.parents.get(id) }
    if (parent?.type === 'Series') return (await this.list(`/Shows/${segment(id)}/Seasons`)).items
    if (parent?.type === 'Season' && parent.seriesId) {
      return (await this.list(`/Shows/${segment(parent.seriesId)}/Episodes`, { seasonId: id })).items
    }
    return []
  }
  async search(text: string): Promise<MediaItem[]> {
    this.guard()
    if (!text.trim()) return []
    return (await this.list('/Items', { searchTerm: text, IncludeItemTypes: 'Movie,Series,Episode', Recursive: true, Limit: 50 })).items
  }
  image(id: string, kind: ImageKind, w: number, h: number): ImageRequest {
    this.guard()
    const art = this.artwork.get(id)
    let target = id
    let type = kind === 'backdrop' ? 'Backdrop/0' : kind === 'logo' ? 'Logo' : kind === 'thumb' ? 'Thumb' : 'Primary'
    let tag = kind === 'backdrop' ? art?.BackdropImageTags?.[0] : art?.ImageTags?.[type]
    if (kind === 'poster' && art?.Type === 'Episode' && art.SeriesId) {
      target = art.SeriesId; tag = art.SeriesPrimaryImageTag ?? this.artwork.get(target)?.ImageTags?.Primary
    } else if (kind === 'poster' && !tag && (art?.ParentPrimaryImageItemId || art?.SeriesId)) {
      target = art.ParentPrimaryImageItemId ?? art.SeriesId!; tag = art.ParentPrimaryImageTag ?? art.SeriesPrimaryImageTag
    } else if (kind === 'backdrop' && !tag && (art?.ParentBackdropItemId || art?.SeriesId)) {
      target = art.ParentBackdropItemId ?? art.SeriesId!
      tag = art.ParentBackdropImageTags?.[0] ?? this.artwork.get(target)?.BackdropImageTags?.[0]
    } else if (kind === 'thumb' && !tag) {
      if (art?.ParentThumbItemId || (art?.SeriesId && art.SeriesThumbImageTag)) {
        target = art.ParentThumbItemId ?? art.SeriesId!; tag = art.ParentThumbImageTag ?? art.SeriesThumbImageTag
      } else {
        type = 'Primary'; tag = art?.ImageTags?.Primary
        if (!tag && (art?.ParentPrimaryImageItemId || art?.SeriesId)) {
          target = art.ParentPrimaryImageItemId ?? art.SeriesId!; tag = art.ParentPrimaryImageTag ?? art.SeriesPrimaryImageTag
        }
      }
    } else if (kind === 'logo' && !tag && (art?.ParentLogoItemId || (art?.SeriesId && art.SeriesLogoImageTag))) {
      target = art.ParentLogoItemId ?? art.SeriesId!; tag = art.ParentLogoImageTag ?? art.SeriesLogoImageTag
    }
    return { kind: 'http', url: this.client.url(`/Items/${segment(target)}/Images/${type}`, {
      fillWidth: w, fillHeight: h, quality: 90, tag,
    }), headers: { Authorization: this.client.authorization }, authOrigin: new URL(this.client.base).origin }
  }
  async setWatched(id: string, watched: boolean): Promise<void> {
    await this.request(`/UserPlayedItems/${segment(id)}`, { userId: this.opts.userId }, watched ? 'POST' : 'DELETE')
  }
  async setFavourite(id: string, fav: boolean): Promise<void> {
    await this.request(`/UserFavoriteItems/${segment(id)}`, { userId: this.opts.userId }, fav ? 'POST' : 'DELETE')
  }
  async playback(id: string, opts: PlayOptions): Promise<PlaybackPlan> {
    const raw = await this.raw(id)
    const item = this.required(raw)
    let next: MediaItem | undefined
    if (item.type === 'episode' && item.seriesId) {
      next = (await this.list(`/Shows/${segment(item.seriesId)}/Episodes`, { startItemId: id, limit: 2 })).items[1]
    }
    return playbackPlan(this.client, this.opts.userId, this.name, raw, item, opts, next)
  }
  async report(handle: ReportHandle, event: ReportEvent): Promise<void> {
    const data = handle.data
    const path = event.state === 'start' ? '/Sessions/Playing' : event.state === 'stopped' ?
      '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress'
    let firstError: unknown
    try { await this.request(path, {}, 'POST', { ItemId: handle.itemId, MediaSourceId: data.mediaSourceId,
      PlaySessionId: data.playSessionId, PositionTicks: Math.round(event.positionSec * TICKS), PlayMethod: data.playMethod,
      AudioStreamIndex: data.audioIdx, SubtitleStreamIndex: data.subIdx, CanSeek: true,
      ...(event.state === 'progress' || event.state === 'paused' ? { IsPaused: event.state === 'paused' } : {}) })
    } catch (error) { firstError = error }
    if (event.state === 'stopped' && data.playMethod === 'Transcode') {
      // Bypass the signed-out guard: a rejected stop must still attempt server-side cleanup.
      try {
        await this.client.request('/Videos/ActiveEncodings', {
          deviceId: this.opts.deviceId, playSessionId: String(data.playSessionId),
        }, 'DELETE')
      } catch (error) { firstError ??= error }
    }
    if (firstError !== undefined) throw firstError
  }
  dispose(): void { this.client.dispose(); this.artwork.clear(); this.parents.clear(); this.libraryKinds.clear() }
}
