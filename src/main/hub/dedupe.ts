import type { MediaItem } from '@shared/media-types'

export function normalTitle(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function same(a: MediaItem, b: MediaItem): boolean {
  if (a.key === b.key) return true
  if (a.type !== b.type) return false
  const ids = ['imdb', 'tmdb'] as const
  if (ids.some((key) => a.providerIds?.[key] && a.providerIds[key] === b.providerIds?.[key])) return true
  const aIds = ids.some((key) => a.providerIds?.[key])
  const bIds = ids.some((key) => b.providerIds?.[key])
  if (aIds && bIds) return false
  return normalTitle(a.title) === normalTitle(b.title) && a.year === b.year &&
    (a.type !== 'episode' || (normalTitle(a.seriesTitle ?? '') === normalTitle(b.seriesTitle ?? '') &&
      a.seasonNumber === b.seasonNumber && a.episodeNumber === b.episodeNumber))
}

export function hasProgress(item: MediaItem): boolean { return (item.positionSec ?? 0) > 0 || (item.progress ?? 0) > 0 }

export function dedupe(items: MediaItem[]): MediaItem[] {
  const result: MediaItem[] = []
  for (const item of items) {
    const index = result.findIndex((old) => same(old, item))
    if (index === -1) result.push(item)
    else if (!hasProgress(result[index]!) && hasProgress(item)) result[index] = item
  }
  return result
}

export function onePerShow(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.seriesId ? `show:${normalTitle(item.seriesTitle ?? `${item.sourceId}:${item.seriesId}`)}` : item.key
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
