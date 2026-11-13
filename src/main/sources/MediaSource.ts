// Contract every media server adapter implements (Jellyfin, Plex, Fixture). Main-process only.
import type {
  BrowseQuery, ImageKind, Library, MediaItem, MediaItemDetail, Page, SourceInfo, SourceKind,
} from '@shared/media-types'
import type { PlayerState } from '@shared/player-types'

/** How main fetches one artwork image. Tokens stay in main; the renderer only sees mediaos-img:// URLs. */
export type ImageRequest =
  | { kind: 'http'; url: string; headers: Record<string, string>;
    /** Source server origin authorised to receive headers. Missing means no headers are sent. */
    authOrigin?: string }
  /** locally generated art only; never server bytes */
  | { kind: 'inline'; mime: string; body: string | Uint8Array }
  | { kind: 'none' }

/** Opaque to everyone except the source that issued it (session ids, media source ids, play method...). */
export interface ReportHandle {
  sourceId: string
  itemId: string
  data: Record<string, string | number | boolean | undefined>
}

export interface SubtitleRef {
  url: string
  lang?: string
  title?: string
  default?: boolean
}

export interface PlaybackPlan {
  /** What mpv opens. May be http(s) or, for the fixture, an mpv `av://lavfi:` test pattern. */
  url: string
  /** Sent by mpv with every request (http-header-fields). Never logged. */
  headers: Record<string, string>
  startSec: number
  /** Media time at player position zero; omitted when player and media positions match. */
  timeBaseSec?: number
  /** Full media duration, even when a transcode starts part-way through. */
  durationSec?: number
  subtitles: SubtitleRef[]
  /** Player track ids: 1-based per-type positions, embedded first, then subtitles in the order above.
   * External positions are resolved to real ids after loading, by external-filename.
   * Missing selection keeps player defaults; subtitle null switches subtitles off. */
  selection?: { audio?: number; subtitle?: number | null }
  /** Track lists for the mock player, with player ids rather than source stream indices. */
  tracks?: { audio: PlayerState['audioTracks']; subtitles: PlayerState['subtitleTracks'] }
  method: 'direct' | 'transcode'
  /** Direct play failed: try again with a server transcode. */
  fallback?: () => Promise<PlaybackPlan>
  report: ReportHandle
  /** Next episode, for "Up next". */
  next?: MediaItem
  /** The item being played (for the player UI). */
  item: MediaItem
}

export interface PlayOptions {
  resume: boolean
  audioIdx?: number
  /** -1 = subtitles off. */
  subIdx?: number
}

export type ReportEvent = { state: 'start' | 'progress' | 'paused' | 'stopped'; positionSec: number }

/** A thrown error a user can understand. `code` lets the UI pick a specific screen. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly code: 'offline' | 'auth' | 'paywall' | 'notFound' | 'server' | 'timeout' | 'unsupported',
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

export interface MediaSource {
  readonly id: string
  readonly kind: SourceKind
  readonly name: string
  info(): SourceInfo
  rows(): Promise<{ resume: MediaItem[]; nextUp: MediaItem[]; latest: MediaItem[] }>
  libraries(): Promise<Library[]>
  /** Items in one library. `libraryId` is the source-local id (not the key). */
  browse(libraryId: string, q: BrowseQuery): Promise<Page<MediaItem>>
  /** Shows include `seasons` and `nextEpisode`. */
  item(id: string): Promise<MediaItemDetail>
  /** Show -> seasons, season -> episodes. */
  children(id: string): Promise<MediaItem[]>
  search(text: string): Promise<MediaItem[]>
  image(id: string, kind: ImageKind, w: number, h: number): ImageRequest
  playback(id: string, opts: PlayOptions): Promise<PlaybackPlan>
  report(h: ReportHandle, e: ReportEvent): Promise<void>
  setWatched(id: string, watched: boolean): Promise<void>
  setFavourite(id: string, fav: boolean): Promise<void>
  /** Stop timers, abort requests. */
  dispose(): void
}
