// Shapes shared by the main process (core) and the renderer (UI).
// Pure types + tiny pure helpers only: no Node, no DOM imports.

export type SourceKind = 'jellyfin' | 'plex' | 'fixture'
export type ItemType = 'movie' | 'show' | 'season' | 'episode' | 'video'
export type ImageKind = 'poster' | 'backdrop' | 'thumb' | 'logo'

/** A playable or browsable thing from one media server. `key` is globally unique: `${sourceId}~${id}`. */
export interface MediaItem {
  key: string
  sourceId: string
  id: string
  type: ItemType
  title: string
  /** Second line under a tile, e.g. "S2 · E5 · The Long Night" or "2019". */
  subtitle?: string
  year?: number
  overview?: string
  runtimeSec?: number
  /** Resume point in seconds (0 or absent = not started). */
  positionSec?: number
  /** 0..1 watched fraction for progress bars. */
  progress?: number
  watched?: boolean
  favourite?: boolean
  /** Shows and seasons: episodes not yet watched. */
  unwatchedCount?: number
  seriesId?: string
  seriesTitle?: string
  seasonId?: string
  seasonNumber?: number
  episodeNumber?: number
  officialRating?: string
  communityRating?: number
  genres?: string[]
  /** Which artwork the server says exists, so the UI can skip broken image requests. */
  images: Partial<Record<ImageKind, boolean>>
  providerIds?: { imdb?: string; tmdb?: string; tvdb?: string }
  /** ISO timestamps. */
  lastPlayedAt?: string
  addedAt?: string
  premieredAt?: string
}

export interface Track {
  /** Index understood by the source's playback() (stream index on Jellyfin, stream id on Plex). */
  index: number
  label: string
  language?: string
  codec?: string
  channels?: number
  default?: boolean
  forced?: boolean
  external?: boolean
}

export interface Person {
  name: string
  role?: string
}

export interface MediaItemDetail extends MediaItem {
  tagline?: string
  cast?: Person[]
  directors?: string[]
  studios?: string[]
  audioTracks: Track[]
  subtitleTracks: Track[]
  /** Human summary, e.g. "4K · HDR10 · HEVC". */
  videoInfo?: string
  /** Human summary, e.g. "English · E-AC3 5.1". */
  audioInfo?: string
  /** Shows: seasons in order. */
  seasons?: MediaItem[]
  /** Shows: the episode "Play" should start (next up / resume). */
  nextEpisode?: MediaItem
}

export type LibraryKind = 'movies' | 'shows' | 'mixed'

export interface Library {
  key: string
  sourceId: string
  id: string
  title: string
  kind: LibraryKind
  itemCount?: number
}

export interface Page<T> {
  items: T[]
  total: number
  offset: number
}

export type SortKey = 'title' | 'added' | 'year' | 'rating'
export type BrowseFilter = 'all' | 'unwatched' | 'favourites'

export interface BrowseQuery {
  sort: SortKey
  descending?: boolean
  filter?: BrowseFilter
  offset: number
  limit: number
}

export type SourceStatus = 'ok' | 'connecting' | 'offline' | 'signed-out' | 'error'

export interface SourceInfo {
  id: string
  kind: SourceKind
  /** Friendly name, user-editable (defaults to the server name). */
  name: string
  serverName?: string
  url?: string
  userName?: string
  status: SourceStatus
  /** Plain-English explanation when status is not 'ok'. */
  message?: string
}

export type HomeRowKind = 'continue' | 'nextUp' | 'latest' | 'library' | 'apps'

export interface HomeRow {
  id: string
  title: string
  kind: HomeRowKind
  items: MediaItem[]
  /** For per-library rows. */
  libraryKey?: string
}

export interface HomeData {
  rows: HomeRow[]
  /** Items for the big banner at the top of Home (backdrop art). */
  hero: MediaItem[]
  sources: SourceInfo[]
  generatedAt: string
}

export function itemKey(sourceId: string, id: string): string {
  return `${sourceId}~${id}`
}

export function splitKey(key: string): { sourceId: string; id: string } {
  const i = key.indexOf('~')
  if (i <= 0 || i === key.length - 1) throw new Error(`Bad item key: ${key}`)
  return { sourceId: key.slice(0, i), id: key.slice(i + 1) }
}

/**
 * URL the renderer uses for artwork. The main process resolves it with the server's auth headers,
 * so tokens never reach the renderer. Width/height are the size the tile is drawn at.
 */
export function imageUrl(item: Pick<MediaItem, 'sourceId' | 'id'>, kind: ImageKind, w: number, h: number): string {
  return `mediaos-img://img/${encodeURIComponent(item.sourceId)}/${encodeURIComponent(item.id)}/${kind}?w=${Math.round(w)}&h=${Math.round(h)}`
}

export function formatRuntime(sec: number | undefined): string {
  if (!sec || sec <= 0) return ''
  const m = Math.round(sec / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

export function formatTimeLeft(item: Pick<MediaItem, 'runtimeSec' | 'positionSec'>): string {
  if (!item.runtimeSec || !item.positionSec) return ''
  const left = Math.max(0, item.runtimeSec - item.positionSec)
  const m = Math.max(1, Math.round(left / 60))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
