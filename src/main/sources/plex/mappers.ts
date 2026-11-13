import { itemKey, type Library, type MediaItem, type MediaItemDetail, type Track } from '@shared/media-types'
import { identifier, number, string, records, readItem, type PlexItem, type PlexStream } from './guards'

export interface Artwork {
  type: string; thumb?: string; art?: string; grandparentThumb?: string; grandparentArt?: string; parentThumb?: string; logo?: string
}
export function artwork(item: PlexItem): Artwork {
  const r = item.raw
  return { type: item.type, thumb: string(r.thumb, 8192), art: string(r.art, 8192),
    grandparentThumb: string(r.grandparentThumb, 8192), grandparentArt: string(r.grandparentArt, 8192),
    parentThumb: string(r.parentThumb, 8192), logo: string(records(r.Image).find((i) => i.type === 'clearLogo')?.url, 8192) }
}
export function artworkPath(art: Artwork, kind: 'poster' | 'backdrop' | 'thumb' | 'logo'): string | undefined {
  if (kind === 'poster') return art.type === 'episode' ? art.grandparentThumb ?? art.thumb :
    art.thumb ?? (art.type === 'season' ? art.parentThumb : undefined)
  return kind === 'backdrop' ? art.art ?? art.grandparentArt : kind === 'thumb' ? art.thumb : art.logo
}
const iso = (value: unknown): string | undefined => {
  const n = number(value)
  if (n === undefined || Math.abs(n * 1000) > 8.64e15) return undefined
  return new Date(n * 1000).toISOString()
}
const tags = (value: unknown): string[] => records(value).flatMap((r) => string(r.tag) ?? [])
export function mapItem(sourceId: string, value: unknown): MediaItem | undefined {
  const item = readItem(value)
  if (!item) return undefined
  const types = { movie: 'movie', show: 'show', season: 'season', episode: 'episode', clip: 'video' } as const
  if (!Object.hasOwn(types, item.type)) return undefined
  const type = types[item.type as keyof typeof types]
  const r = item.raw, art = artwork(item)
  const duration = number(r.duration), offset = number(r.viewOffset)
  const leaf = number(r.leafCount), viewed = number(r.viewedLeafCount) ?? 0
  const episodic = type === 'show' || type === 'season'
  const seasonNumber = number(type === 'season' ? r.index : r.parentIndex), episodeNumber = number(r.index)
  const providerIds: NonNullable<MediaItem['providerIds']> = {}
  for (const guid of records(r.Guid)) {
    const match = /^(imdb|tmdb|tvdb):\/\/(.+)$/.exec(string(guid.id) ?? '')
    if (match) providerIds[match[1] as keyof typeof providerIds] = match[2]!
  }
  const date = string(r.originallyAvailableAt)
  return { key: itemKey(sourceId, item.ratingKey), sourceId, id: item.ratingKey, type, title: item.title,
    subtitle: type === 'episode' ? `S${seasonNumber ?? 0} · E${episodeNumber ?? 0} · ${item.title}` :
      number(r.year)?.toString(), year: number(r.year), overview: string(r.summary, 5000),
    runtimeSec: duration === undefined ? undefined : Math.max(0, duration / 1000),
    positionSec: offset === undefined ? undefined : Math.max(0, Math.min(offset, duration ?? offset) / 1000),
    progress: duration && offset !== undefined ? Math.max(0, Math.min(1, offset / duration)) : undefined,
    watched: episodic ? leaf !== undefined && leaf > 0 && viewed >= leaf : (number(r.viewCount) ?? 0) > 0,
    unwatchedCount: episodic && leaf !== undefined ? Math.max(0, leaf - viewed) : undefined,
    seriesId: identifier(type === 'episode' ? r.grandparentRatingKey : type === 'season' ? r.parentRatingKey : undefined),
    seriesTitle: type === 'episode' ? string(r.grandparentTitle) : undefined,
    seasonId: type === 'episode' ? identifier(r.parentRatingKey) : undefined,
    seasonNumber: type === 'episode' || type === 'season' ? seasonNumber : undefined,
    episodeNumber: type === 'episode' ? episodeNumber : undefined, officialRating: rating(string(r.contentRating)),
    communityRating: number(r.audienceRating) ?? number(r.rating), genres: tags(r.Genre), providerIds,
    images: Object.fromEntries((['poster', 'backdrop', 'thumb', 'logo'] as const).map((kind) => [kind, !!artworkPath(art, kind)])),
    lastPlayedAt: iso(r.lastViewedAt), addedAt: iso(r.addedAt),
    premieredAt: date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) ?
      new Date(date).toISOString() : undefined }
}
export function mapLibrary(sourceId: string, raw: Record<string, unknown>): Library | undefined {
  const id = identifier(raw.key), title = string(raw.title)
  if (!id || title === undefined || typeof raw.type !== 'string' || !['movie', 'show'].includes(raw.type)) return undefined
  return { key: itemKey(sourceId, id), sourceId, id, title, kind: raw.type === 'movie' ? 'movies' : 'shows' }
}
export function trackLabel(s: PlexStream): string {
  return s.displayTitle || s.extendedDisplayTitle || [s.language || s.languageCode,
    s.codec?.toUpperCase(), s.channels ? `${s.channels} channels` : undefined].filter(Boolean).join(' · ') || `Track ${s.id}`
}
export function mapDetail(item: MediaItem, raw: PlexItem): MediaItemDetail {
  const streams = raw.part?.streams ?? []
  const tracks = (type: number): Track[] => streams.filter((s) => s.streamType === type).map((s) => ({
    index: s.id, label: trackLabel(s), language: s.languageCode, codec: s.codec, channels: s.channels,
    default: s.default || s.selected, forced: s.forced, external: !!s.key,
  }))
  const video = streams.find((s) => s.streamType === 1), r = raw.raw
  const audioTracks = tracks(2), subtitleTracks = tracks(3)
  return { ...item, audioTracks, subtitleTracks, tagline: string(r.tagline),
    cast: records(r.Role).flatMap((p) => { const name = string(p.tag); return name ? [{ name, role: string(p.role) }] : [] }),
    directors: tags(r.Director), studios: string(r.studio) ? [string(r.studio)!] : [],
    videoInfo: [raw.videoResolution === '4k' ? '4K' : raw.videoResolution ? `${raw.videoResolution}p` : undefined,
      video?.DOVIPresent ? 'Dolby Vision' : ['smpte2084', 'arib-std-b67'].includes(video?.colorTrc ?? '') ? 'HDR' : undefined,
      raw.videoCodec?.toUpperCase()].filter(Boolean).join(' · ') || undefined,
    audioInfo: audioTracks.find((t) => t.default)?.label ?? audioTracks[0]?.label }
}

/** Plex prefixes some age ratings with a country code ("gb/12A"); the screen shows just the rating. */
function rating(value?: string): string | undefined {
  return value?.replace(/^[a-z]{2}\//i, '') || undefined
}
