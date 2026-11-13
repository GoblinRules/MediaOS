import type { MediaItem } from '@shared/media-types'
import { SourceError, type PlaybackPlan, type PlayOptions } from '../MediaSource'
import type { JellyfinClient } from './JellyfinClient'
import type { ItemDto } from './dto'
import { array, id, readMedia, reply } from './guards'
import { deviceProfile } from './device-profile'
import { mapTrack, textSubtitle, TICKS } from './mappers'

export async function playbackPlan(client: JellyfinClient, userId: string, name: string, raw: ItemDto,
  item: MediaItem, opts: PlayOptions, next?: MediaItem, transcode = false): Promise<PlaybackPlan> {
  const startSec = opts.resume ? item.positionSec ?? 0 : 0
  const info = reply(await client.request<unknown>(`/Items/${encodeURIComponent(item.id)}/PlaybackInfo`, { userId }, 'POST', {
    UserId: userId, ...(opts.resume ? { StartTimeTicks: Math.round(startSec * TICKS) } : {}),
    ...(opts.audioIdx === undefined ? {} : { AudioStreamIndex: opts.audioIdx }),
    ...(opts.subIdx === undefined ? {} : { SubtitleStreamIndex: opts.subIdx }),
    MaxStreamingBitrate: 120_000_000, EnableDirectPlay: !transcode, EnableDirectStream: !transcode,
    EnableTranscoding: true, AutoOpenLiveStream: false, DeviceProfile: deviceProfile(),
  }), name)
  const playSessionId = id(info.PlaySessionId)
  const media = array(info.MediaSources)?.flatMap((m) => readMedia(m) ?? [])[0]
  if (!media?.Id || (transcode && !media.TranscodingUrl)) {
    throw new SourceError(`${name} can't play this file on the TV.`, 'unsupported')
  }
  const streams = media.MediaStreams ?? raw.MediaSources?.[0]?.MediaStreams ?? []
  const audio = streams.filter((s) => s.Type === 'Audio')
  const subs = streams.filter((s) => s.Type === 'Subtitle')
  const external = subs.filter((s) => s.IsExternal && textSubtitle(s) && s.DeliveryUrl)
  const orderedSubs = [...subs.filter((s) => !s.IsExternal), ...external]
  const subtitles = external.map((s) => ({ url: client.deliveryUrl(s.DeliveryUrl!), lang: s.Language,
    title: mapTrack(s).label, default: s.IsDefault }))
  const selected = (list: typeof streams, index?: number): number | undefined => {
    const position = list.findIndex((s) => s.Index === index)
    return position < 0 ? undefined : position + 1
  }
  return {
    url: transcode ? client.deliveryUrl(media.TranscodingUrl!) : client.url(`/Videos/${encodeURIComponent(item.id)}/stream`, {
      static: true, mediaSourceId: media.Id, playSessionId,
    }),
    headers: { Authorization: client.authorization }, startSec, durationSec: item.runtimeSec, subtitles,
    selection: { audio: selected(audio, opts.audioIdx), subtitle: opts.subIdx === -1 ? null : selected(orderedSubs, opts.subIdx) },
    tracks: {
      audio: audio.map((s, i) => ({ index: i + 1, label: mapTrack(s).label, selected: s.IsDefault === true })),
      subtitles: orderedSubs.map((s, i) => ({ index: i + 1, label: mapTrack(s).label, selected: s.IsDefault === true })),
    },
    method: transcode ? 'transcode' : 'direct',
    fallback: transcode ? undefined : () => playbackPlan(client, userId, name, raw, item, opts, next, true),
    report: { sourceId: item.sourceId, itemId: item.id, data: { playSessionId, mediaSourceId: media.Id,
      playMethod: transcode ? 'Transcode' : 'DirectPlay', audioIdx: opts.audioIdx ?? media.DefaultAudioStreamIndex,
      subIdx: opts.subIdx ?? media.DefaultSubtitleStreamIndex } },
    next, item,
  }
}
