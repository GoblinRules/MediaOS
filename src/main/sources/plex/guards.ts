import { array, object, number, string, index } from '../jellyfin/guards'
import { SourceError } from '../MediaSource'
export { array, object, number, string, index } from '../jellyfin/guards'

export const identifier = (value: unknown): string | undefined => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : string(value, 201)
  return text && text.length <= 200 ? text : undefined
}
export const flag = (value: unknown): boolean => value === true || value === 1
export const records = (value: unknown): Record<string, unknown>[] => (array(value) ?? []).flatMap((v) => {
  const raw = object(v)
  return raw ? [raw] : []
})
export interface PlexStream {
  id: number; streamType: number; key?: string; languageCode?: string; language?: string; codec?: string; channels?: number
  displayTitle?: string; extendedDisplayTitle?: string; selected: boolean; default: boolean; forced: boolean
  DOVIPresent: boolean; colorTrc?: string
}
export interface PlexPart { id?: string; key?: string; streams: PlexStream[] }
export interface PlexItem {
  ratingKey: string; type: string; title: string; raw: Record<string, unknown>; part?: PlexPart
  videoResolution?: string; videoCodec?: string
}
export function readItem(value: unknown): PlexItem | undefined {
  const raw = object(value), ratingKey = identifier(raw?.ratingKey), type = string(raw?.type), title = string(raw?.title)
  if (!raw || !ratingKey || !type || title === undefined) return undefined
  const media = object(array(raw.Media)?.[0]), part = object(array(media?.Part)?.[0])
  return { ratingKey, type, title, raw, videoResolution: string(media?.videoResolution), videoCodec: string(media?.videoCodec),
    part: part ? { id: identifier(part.id), key: string(part.key, 8192), streams: records(part.Stream).flatMap((s) => {
      const id = index(s.id), streamType = number(s.streamType)
      return id === undefined || streamType === undefined ? [] : [{ id, streamType, key: string(s.key, 8192),
        languageCode: string(s.languageCode), language: string(s.language), codec: string(s.codec), channels: number(s.channels),
        displayTitle: string(s.displayTitle), extendedDisplayTitle: string(s.extendedDisplayTitle),
        selected: flag(s.selected), default: flag(s.default), forced: flag(s.forced), DOVIPresent: flag(s.DOVIPresent),
        colorTrc: string(s.colorTrc) }]
    }) } : undefined }
}
export function container(value: unknown, name: string): Record<string, unknown> {
  const result = object(object(value)?.MediaContainer)
  if (!result) throw new SourceError(`Something went wrong on ${name}. Try again in a moment.`, 'server')
  return result
}
