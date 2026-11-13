import type { ItemDto, MediaSourceDto, MediaStream } from './dto'
import { SourceError } from '../MediaSource'

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown> : undefined
export const string = (value: unknown, cap = 300): string | undefined =>
  typeof value === 'string' ? value.slice(0, cap) : undefined
export const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
export const boolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
export const array = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined
export const id = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
export function index(value: unknown): number | undefined {
  const finite = number(value)
  return finite !== undefined && Number.isInteger(finite) && finite >= 0 ? finite : undefined
}
const strings = (value: unknown): string[] | undefined => array(value)?.flatMap((v) => string(v) ?? [])
const stringRecord = (value: unknown): Record<string, string> | undefined => {
  const raw = object(value)
  return raw && Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    const text = string(value)
    return text === undefined ? [] : [[key, text]]
  }))
}
export function reply(value: unknown, name: string): Record<string, unknown> {
  const raw = object(value)
  if (!raw) throw new SourceError(`Something went wrong on ${name}. Try again in a moment.`, 'server')
  return raw
}

export function readStream(value: unknown): MediaStream | undefined {
  const raw = object(value)
  if (!raw) return undefined
  const Index = index(raw.Index), Type = string(raw.Type)
  if (Index === undefined || !Type) return undefined
  return { Index, Type, Codec: string(raw.Codec), Language: string(raw.Language), DisplayTitle: string(raw.DisplayTitle),
    Title: string(raw.Title), Channels: number(raw.Channels), ChannelLayout: string(raw.ChannelLayout),
    IsDefault: boolean(raw.IsDefault), IsForced: boolean(raw.IsForced), IsExternal: boolean(raw.IsExternal),
    IsTextSubtitleStream: boolean(raw.IsTextSubtitleStream), DeliveryUrl: string(raw.DeliveryUrl, 8192),
    Width: number(raw.Width), Height: number(raw.Height), VideoRange: string(raw.VideoRange), VideoRangeType: string(raw.VideoRangeType) }
}
export function readMedia(value: unknown): MediaSourceDto | undefined {
  const raw = object(value), Id = id(raw?.Id)
  if (!raw || !Id) return undefined
  return { Id, MediaStreams: array(raw.MediaStreams)?.flatMap((s) => readStream(s) ?? []),
    TranscodingUrl: string(raw.TranscodingUrl, 8192), DefaultAudioStreamIndex: index(raw.DefaultAudioStreamIndex),
    DefaultSubtitleStreamIndex: index(raw.DefaultSubtitleStreamIndex) }
}

/** Copy only checked values. The same boundary also protects artwork and parent caches. */
export function readItem(value: unknown): ItemDto | undefined {
  const raw = object(value), Id = id(raw?.Id), Type = string(raw?.Type)
  if (!raw || !Id || !Type) return undefined
  const user = object(raw.UserData)
  return {
    Id, Type, Name: string(raw.Name) ?? '', CollectionType: string(raw.CollectionType), ChildCount: number(raw.ChildCount),
    RunTimeTicks: number(raw.RunTimeTicks), ProductionYear: number(raw.ProductionYear), Overview: string(raw.Overview, 5000),
    IndexNumber: number(raw.IndexNumber), ParentIndexNumber: number(raw.ParentIndexNumber), SeriesId: id(raw.SeriesId),
    SeriesName: string(raw.SeriesName), SeasonId: id(raw.SeasonId), ParentId: id(raw.ParentId), OfficialRating: string(raw.OfficialRating),
    CommunityRating: number(raw.CommunityRating), Genres: strings(raw.Genres), ProviderIds: stringRecord(raw.ProviderIds),
    DateCreated: string(raw.DateCreated), PremiereDate: string(raw.PremiereDate), ImageTags: stringRecord(raw.ImageTags),
    BackdropImageTags: strings(raw.BackdropImageTags), ParentBackdropItemId: id(raw.ParentBackdropItemId),
    ParentBackdropImageTags: strings(raw.ParentBackdropImageTags), SeriesPrimaryImageTag: string(raw.SeriesPrimaryImageTag),
    ParentPrimaryImageTag: string(raw.ParentPrimaryImageTag), ParentPrimaryImageItemId: id(raw.ParentPrimaryImageItemId),
    ParentThumbItemId: id(raw.ParentThumbItemId), ParentThumbImageTag: string(raw.ParentThumbImageTag),
    SeriesThumbImageTag: string(raw.SeriesThumbImageTag), ParentLogoItemId: id(raw.ParentLogoItemId),
    ParentLogoImageTag: string(raw.ParentLogoImageTag), SeriesLogoImageTag: string(raw.SeriesLogoImageTag),
    UserData: user ? { PlaybackPositionTicks: number(user.PlaybackPositionTicks), PlayedPercentage: number(user.PlayedPercentage),
      Played: boolean(user.Played), IsFavorite: boolean(user.IsFavorite), UnplayedItemCount: number(user.UnplayedItemCount),
      LastPlayedDate: string(user.LastPlayedDate) } : undefined,
    MediaSources: array(raw.MediaSources)?.flatMap((m) => readMedia(m) ?? []),
    People: array(raw.People)?.flatMap((value) => {
      const person = object(value), Name = string(person?.Name)
      return Name === undefined ? [] : [{ Name, Type: string(person?.Type), Role: string(person?.Role) }]
    }),
    Taglines: strings(raw.Taglines), Studios: array(raw.Studios)?.flatMap((value) => {
      const Name = string(object(value)?.Name)
      return Name === undefined ? [] : [{ Name }]
    }),
  }
}
