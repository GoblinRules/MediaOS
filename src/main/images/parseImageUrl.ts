import type { ImageKind } from '@shared/media-types'

export interface ParsedImageUrl { sourceId: string; itemId: string; kind: ImageKind; w: number; h: number }

export function parseImageUrl(value: string): ParsedImageUrl {
  const url = new URL(value)
  const rawPath = /^mediaos-img:\/\/img(\/[^?#]*)/.exec(value)?.[1]
  if (rawPath !== url.pathname) throw new Error('Invalid image path')
  if (url.protocol !== 'mediaos-img:' || url.host !== 'img' || url.username || url.password || url.hash) {
    throw new Error('Invalid image URL')
  }
  const parts = url.pathname.split('/')
  if (parts.length !== 4 || parts[0] !== '') throw new Error('Invalid image path')
  const sourceId = decodeURIComponent(parts[1]!)
  const itemId = decodeURIComponent(parts[2]!)
  const kind = decodeURIComponent(parts[3]!)
  if (![sourceId, itemId].every((s) => s.length > 0 && ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) ||
    !['poster', 'backdrop', 'thumb', 'logo'].includes(kind)) throw new Error('Invalid image path')
  for (const key of url.searchParams.keys()) {
    if (!['w', 'h'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Invalid image size')
  }
  return { sourceId, itemId, kind: kind as ImageKind, w: size(url.searchParams.get('w'), 400), h: size(url.searchParams.get('h'), 600) }
}

function size(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  if (!/^-?\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw new Error('Invalid image size')
  return Math.max(40, Math.min(3840, Math.round(Math.max(16, Math.min(3840, Number(raw))) / 40) * 40))
}
