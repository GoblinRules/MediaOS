import { randomUUID } from 'node:crypto'
import type { MediaItem } from '@shared/media-types'
import type { PlaybackPlan, PlayOptions } from '../MediaSource'
import type { PlexClient, Query } from './PlexClient'
import { object, number, type PlexItem } from './guards'
import { trackLabel } from './mappers'
import { silentLog, type Log } from '../../log/Logger'

const profile = 'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&' +
  'videoCodec=h264,hevc&audioCodec=aac,ac3,eac3)'

// mpv's time-pos starts at zero for a Plex HLS transcode started with `offset` (checked live, PMS 1.43.5, 2026-11-13).
const plexHlsStartsAtZero = true

interface Transport {
  client: () => PlexClient
  request: (path: string, query?: Query, method?: string) => Promise<unknown>
}
export function playbackPlan(transport: Transport, raw: PlexItem, item: MediaItem, opts: PlayOptions,
  next?: MediaItem, logger: Log = silentLog): PlaybackPlan {
  const client = transport.client()
  const part = raw.part
  if (!part?.key) throw client.failure('unsupported')
  const audio = part.streams.filter((s) => s.streamType === 2)
  const subs = part.streams.filter((s) => s.streamType === 3)
  const embedded = subs.filter((s) => !s.key), external = subs.filter((s) => s.key)
  const selection: NonNullable<PlaybackPlan['selection']> = {}
  const audioIndex = audio.findIndex((s) => s.id === opts.audioIdx)
  const subIndex = [...embedded, ...external].findIndex((s) => s.id === opts.subIdx)
  if (audioIndex >= 0) selection.audio = audioIndex + 1
  if (opts.subIdx === -1) selection.subtitle = null
  else if (subIndex >= 0) selection.subtitle = subIndex + 1
  const startSec = opts.resume ? item.positionSec ?? 0 : 0
  const duration = Math.max(0, number(raw.raw.duration) ?? 0)
  const shared = { item, next, headers: { ...client.headers }, durationSec: item.runtimeSec }
  const plan: PlaybackPlan = { ...shared, url: client.deliveryUrl(part.key), method: 'direct', startSec,
    selection: Object.keys(selection).length ? selection : undefined,
    subtitles: external.map((s) => ({ url: client.deliveryUrl(s.key!), lang: s.languageCode,
      title: trackLabel(s), default: s.default || s.selected })),
    report: { sourceId: item.sourceId, itemId: item.id,
      data: { ratingKey: item.id, duration, method: 'direct', session: randomUUID() } } }
  plan.fallback = async () => {
    if (part.id && (audioIndex >= 0 || opts.subIdx === -1 || subIndex >= 0)) {
      try {
        await transport.request(`/library/parts/${encodeURIComponent(part.id)}`, { allParts: 1,
          audioStreamID: audioIndex >= 0 ? opts.audioIdx : undefined,
          subtitleStreamID: opts.subIdx === -1 ? 0 : subIndex >= 0 ? opts.subIdx : undefined }, 'PUT')
      } catch {
        // The HTTP client records only method, path and status. Do not log a server response or native error.
        logger.warn('Plex could not save the chosen tracks')
      }
    }
    const session = randomUUID()
    const query: Query = { path: `/library/metadata/${encodeURIComponent(item.id)}`, mediaIndex: 0, partIndex: 0,
      protocol: 'hls', directPlay: 0, directStream: 1, fastSeek: 1, subtitles: 'burn', session, offset: startSec,
      // Plex has no profile for an unknown platform ("Linux") and answers 400 without a named one (checked live).
      'X-Plex-Client-Profile-Name': 'Generic', 'X-Plex-Client-Profile-Extra': profile }
    const reply = await transport.request('/video/:/transcode/universal/decision', query)
    const decision = object(object(reply)?.MediaContainer)
    if (!decision) throw client.failure('server')
    const code = number(decision.generalDecisionCode)
    if (decision.generalDecisionCode !== undefined && (code === undefined || code < 1000 || code >= 2000)) {
      throw client.failure('unsupported')
    }
    return { ...shared, url: transport.client().url('/video/:/transcode/universal/start.m3u8', query), method: 'transcode',
      startSec: 0, timeBaseSec: plexHlsStartsAtZero ? startSec : 0, subtitles: [],
      report: { sourceId: item.sourceId, itemId: item.id,
        data: { ratingKey: item.id, duration, method: 'transcode', session } } }
  }
  return plan
}
