import { extname, basename, join } from 'node:path'
import type { MediaItem } from '@shared/media-types'
import type { DirEntry } from './listing'
import type { SubtitleRef } from '../MediaSource'
import type { ProgressEntry } from './ProgressStore'

export const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const videos = new Set('mkv mp4 m4v avi mov wmv ts m2ts mts mpg mpeg webm flv vob ogv 3gp'.split(' '))
export const isVideo = (name: string): boolean => videos.has(extname(name).slice(1).toLowerCase())
export function fileName(name: string): Pick<MediaItem, 'title' | 'year' | 'seasonNumber' | 'episodeNumber' | 'subtitle'> {
  let title = basename(name, extname(name)).replace(/[._]/g, ' ')
    .split(/\b(?:1080p|720p|2160p|4k|x264|x265|hevc|bluray|web-dl|webrip|hdr)\b/i)[0]!.trim()
  const yearMatch = /\b((?:19|20)\d{2})\b/.exec(title)
  const year = yearMatch ? Number(yearMatch[1]) : undefined
  if (yearMatch && title !== yearMatch[1]) title = title.replace(/\(?\[?\b(?:19|20)\d{2}\b\]?\)?/, '').trim()
  const episode = /\bS(\d{1,2})E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/i.exec(title)
  const seasonNumber = episode ? Number(episode[1] ?? episode[3]) : undefined
  const episodeNumber = episode ? Number(episode[2] ?? episode[4]) : undefined
  return { title: title.replace(/\s+/g, ' ').trim() || basename(name, extname(name)), year, seasonNumber, episodeNumber,
    subtitle: episode ? `S${seasonNumber} · E${episodeNumber}` : year?.toString() }
}
export function mapEntry(id: string, entry: DirEntry, progress?: ProgressEntry): MediaItem {
  return { key: `folders~${id}`, sourceId: 'folders', id, type: entry.type === 'dir' ? 'folder' : 'video',
    ...(entry.type === 'dir' ? { title: entry.name } : fileName(entry.name)), images: {},
    addedAt: new Date(entry.mtimeMs).toISOString(),
    runtimeSec: progress?.durationSec, positionSec: progress?.positionSec, progress: progress?.durationSec ?
      Math.min(1, (progress.positionSec ?? 0) / progress.durationSec) : undefined,
    watched: progress?.watched, favourite: progress?.favourite, lastPlayedAt: progress?.lastPlayedAt }
}
export function sidecars(video: string, entries: DirEntry[], dir: string): SubtitleRef[] {
  const base = basename(video, extname(video)).toLowerCase()
  // The name must go on with a dot ("Film.en.srt"), so "Film 2.srt" isn't taken as a subtitle for "Film.mkv".
  return entries.filter((e) => e.type === 'file' && e.name.toLowerCase().startsWith(`${base}.`) &&
    /\.(srt|ass|ssa|vtt)$/i.test(e.name))
    .sort((a, b) => natural.compare(a.name, b.name)).map((entry) => {
      const lang = /[._-]([a-z]{2,3})\.(?:srt|ass|ssa|vtt)$/i.exec(entry.name)?.[1]?.toLowerCase()
      return { url: join(dir, entry.name), lang, title: lang?.toUpperCase() ?? 'External', default: false }
    })
}
