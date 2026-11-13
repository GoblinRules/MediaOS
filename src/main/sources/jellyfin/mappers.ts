import { itemKey, type ItemType, type Library, type MediaItem, type MediaItemDetail, type Track } from '@shared/media-types'
import type { MediaStream } from './dto'
import { readItem } from './guards'

export const TICKS = 10_000_000
export const seconds = (ticks: number | undefined): number | undefined =>
  ticks === undefined || !Number.isFinite(ticks) ? undefined : Math.max(0, ticks / TICKS)
const types = new Map<string, ItemType>([
  ['Movie', 'movie'], ['Series', 'show'], ['Season', 'season'], ['Episode', 'episode'], ['Video', 'video'],
])

export function mapItem(sourceId: string, value: unknown): MediaItem | undefined {
  const raw = readItem(value)
  if (!raw) return undefined
  const type = types.get(raw.Type)
  if (!type) return undefined
  const runtimeSec = seconds(raw.RunTimeTicks)
  const position = seconds(raw.UserData?.PlaybackPositionTicks)
  const positionSec = position === undefined ? undefined : Math.min(position, runtimeSec ?? position)
  const percentage = raw.UserData?.PlayedPercentage
  const progress = raw.UserData?.Played ? 1 : runtimeSec && positionSec !== undefined ? positionSec / runtimeSec :
    percentage !== undefined && Number.isFinite(percentage) ? percentage / 100 : 0
  const tags = raw.ImageTags ?? {}
  const providerIds: MediaItem['providerIds'] = {}
  for (const [key, value] of Object.entries(raw.ProviderIds ?? {})) {
    const lower = key.toLowerCase()
    if (lower === 'imdb' || lower === 'tmdb' || lower === 'tvdb') providerIds[lower] = value
  }
  return {
    key: itemKey(sourceId, raw.Id), sourceId, id: raw.Id, type, title: raw.Name,
    subtitle: type === 'episode' ? `S${raw.ParentIndexNumber ?? 1} · E${raw.IndexNumber ?? 1} · ${raw.Name}` :
      raw.ProductionYear === undefined ? undefined : String(raw.ProductionYear),
    year: raw.ProductionYear, overview: raw.Overview, runtimeSec, positionSec, progress: Math.max(0, Math.min(1, progress)),
    watched: raw.UserData?.Played, favourite: raw.UserData?.IsFavorite, unwatchedCount: raw.UserData?.UnplayedItemCount,
    seriesId: raw.SeriesId, seriesTitle: raw.SeriesName, seasonId: raw.SeasonId,
    seasonNumber: type === 'season' ? raw.IndexNumber : raw.ParentIndexNumber,
    episodeNumber: type === 'episode' ? raw.IndexNumber : undefined,
    officialRating: raw.OfficialRating, communityRating: raw.CommunityRating, genres: raw.Genres,
    images: {
      poster: type === 'episode' ? !!(raw.SeriesId && raw.SeriesPrimaryImageTag) :
        !!(tags.Primary || raw.SeriesPrimaryImageTag || raw.ParentPrimaryImageTag),
      backdrop: !!(raw.BackdropImageTags?.length || raw.ParentBackdropItemId || raw.ParentBackdropImageTags?.length || raw.SeriesId),
      thumb: !!(tags.Thumb || tags.Primary || raw.ParentThumbImageTag || raw.SeriesThumbImageTag ||
        raw.ParentPrimaryImageTag || raw.SeriesPrimaryImageTag),
      logo: !!(tags.Logo || raw.ParentLogoImageTag || raw.SeriesLogoImageTag),
    },
    providerIds, addedAt: raw.DateCreated, premieredAt: raw.PremiereDate, lastPlayedAt: raw.UserData?.LastPlayedDate,
  }
}

export function mapLibrary(sourceId: string, value: unknown): Library | undefined {
  const raw = readItem(value)
  if (!raw) return undefined
  const kind = raw.CollectionType === 'movies' ? 'movies' : raw.CollectionType === 'tvshows' ? 'shows' :
    !raw.CollectionType || raw.CollectionType === 'homevideos' ? 'mixed' : undefined
  return kind ? { key: itemKey(sourceId, raw.Id), sourceId, id: raw.Id, title: raw.Name, kind, itemCount: raw.ChildCount } : undefined
}

export const textSubtitle = (stream: MediaStream): boolean => stream.IsTextSubtitleStream ??
  ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'ttml', 'mov_text', 'text'].includes(stream.Codec?.toLowerCase() ?? '')
const codecs = new Map([['eac3', 'E-AC3'], ['ac3', 'AC3'], ['h264', 'H.264'], ['hevc', 'HEVC']])
const codecName = (codec = ''): string => codecs.get(codec) ?? codec.toUpperCase()
function languageName(language?: string): string {
  if (!language) return 'Unknown language'
  return new Map([['eng', 'English'], ['en', 'English'], ['fra', 'Français'], ['fre', 'Français'], ['fr', 'Français'],
    ['deu', 'Deutsch'], ['ger', 'Deutsch'], ['es', 'Español'], ['spa', 'Español']]).get(language) ?? language
}
export function mapTrack(stream: MediaStream): Track {
  const channels = stream.Channels === 6 ? '5.1' : stream.Channels === 8 ? '7.1' : stream.Channels === 2 ? 'Stereo' :
    stream.ChannelLayout ?? (stream.Channels ? `${stream.Channels} channels` : '')
  const label = stream.DisplayTitle || (stream.Type === 'Audio' ?
    [languageName(stream.Language), [codecName(stream.Codec), channels].filter(Boolean).join(' ')].join(' · ') :
    stream.Title || languageName(stream.Language))
  return { index: stream.Index, label, language: stream.Language, codec: stream.Codec, channels: stream.Channels,
    default: stream.IsDefault, forced: stream.IsForced, external: stream.IsExternal }
}

export function mapDetail(item: MediaItem, value: unknown): MediaItemDetail {
  const raw = readItem(value) ?? { Id: item.id, Name: item.title, Type: '' }
  const streams = raw.MediaSources?.[0]?.MediaStreams ?? []
  const video = streams.find((s) => s.Type === 'Video')
  const audioTracks = streams.filter((s) => s.Type === 'Audio').map(mapTrack)
  const resolution = video?.Width && video.Width >= 3800 ? '4K' : video?.Height ? `${video.Height}p` : undefined
  const range = video?.VideoRangeType ?? video?.VideoRange
  return {
    ...item, tagline: raw.Taglines?.[0], cast: raw.People?.filter((p) => p.Type === 'Actor').map((p) => ({ name: p.Name, role: p.Role })),
    directors: raw.People?.filter((p) => p.Type === 'Director').map((p) => p.Name), studios: raw.Studios?.map((s) => s.Name),
    audioTracks, subtitleTracks: streams.filter((s) => s.Type === 'Subtitle').map(mapTrack),
    videoInfo: video ? [resolution, range === 'SDR' ? undefined : range, codecName(video.Codec)].filter(Boolean).join(' · ') : undefined,
    audioInfo: (audioTracks.find((s) => s.default) ?? audioTracks[0])?.label,
  }
}
