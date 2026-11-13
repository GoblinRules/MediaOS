import { describe, expect, it } from 'vitest'
import { JellyfinSource } from '../../src/main/sources/jellyfin/JellyfinSource'
import type { PlaybackInfoDto } from '../../src/main/sources/jellyfin/dto'
import { jellyfinFixture, jellyfinReplay } from './helpers'

const options = { id: 'jf', name: 'Harbour Jellyfin', url: 'http://harbour:8096', serverId: 'server-harbour',
  userId: 'user', token: 'private-token', deviceId: 'device', deviceName: 'TV', appVersion: '0.1.0' }
describe('Jellyfin playback', () => {
  it('builds direct plans, resumes only when asked, and maps embedded then external track positions', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const plan = await source.playback('film-harbour', { resume: true, audioIdx: 3, subIdx: 5 })
    expect(plan).toMatchObject({ method: 'direct', startSec: 60.125, durationSec: 7200.25,
      selection: { audio: 2, subtitle: 3 }, report: { sourceId: 'jf', itemId: 'film-harbour',
        data: { mediaSourceId: 'media-harbour', playSessionId: 'session-harbour', playMethod: 'DirectPlay', audioIdx: 3, subIdx: 5 },
      } })
    expect(plan.url).toBe('http://harbour:8096/Videos/film-harbour/stream?' +
      'static=true&mediaSourceId=media-harbour&playSessionId=session-harbour')
    expect(plan.headers.Authorization).toContain('Token="private-token"')
    expect(plan.url).not.toContain('private-token')
    expect(plan.subtitles.map((s) => s.url)).toEqual([
      'http://harbour:8096/Videos/film-harbour/media-harbour/Subtitles/6/Stream.srt',
      'http://harbour:8096/Videos/film-harbour/media-harbour/Subtitles/5/Stream.vtt',
    ])
    expect(fake.calls.at(-1)!.body).toMatchObject({ UserId: 'user', StartTimeTicks: 601250000,
      AudioStreamIndex: 3, SubtitleStreamIndex: 5, MaxStreamingBitrate: 120000000, EnableDirectPlay: true,
      EnableDirectStream: true, EnableTranscoding: true, AutoOpenLiveStream: false,
      DeviceProfile: { DirectPlayProfiles: [{ Type: 'Video' }],
        TranscodingProfiles: [{ Container: 'ts', Protocol: 'hls', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3' }] } })
    const profile = fake.calls.at(-1)!.body.DeviceProfile as { SubtitleProfiles: { Format: string; Method: string }[] }
    expect(profile.SubtitleProfiles).toContainEqual({ Format: 'pgssub', Method: 'Embed' })
    expect(profile.SubtitleProfiles).toContainEqual({ Format: 'srt', Method: 'External' })
    const fresh = await source.playback('film-harbour', { resume: false, subIdx: -1 })
    expect(fresh.startSec).toBe(0)
    expect(fresh.selection?.subtitle).toBeNull()
    expect(fake.calls.at(-1)!.body).not.toHaveProperty('StartTimeTicks')
    expect(fake.calls.at(-1)!.body.SubtitleStreamIndex).toBe(-1)
    const embedded = await source.playback('film-harbour', { resume: false, subIdx: 4 })
    expect(embedded.selection?.subtitle).toBe(1)
    source.dispose()
  })
  it('asks again for a transcode on fallback and uses the returned session and path', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const direct = await source.playback('film-harbour', { resume: true })
    const plan = await direct.fallback!()
    expect(plan).toMatchObject({ method: 'transcode', startSec: 60.125,
      report: { data: { playMethod: 'Transcode', audioIdx: 2, subIdx: 4 } } })
    expect(plan.url).toBe('http://harbour:8096/Videos/film-harbour/master.m3u8?mediaSourceId=media-harbour&playSessionId=session-harbour')
    expect(plan.fallback).toBeUndefined()
    expect(fake.calls.at(-1)!.body).toMatchObject({ EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true })
    source.dispose()
  })
  it('uses a plain unsupported error when no transcode is returned', async () => {
    const fake = jellyfinReplay(({ url }) => {
      if (!url.pathname.endsWith('/PlaybackInfo')) return
      const info = jellyfinFixture<PlaybackInfoDto>('playback-info')
      delete info.MediaSources![0]!.TranscodingUrl
      return info
    })
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const plan = await source.playback('film-harbour', { resume: false })
    await expect(plan.fallback!()).rejects.toMatchObject({ code: 'unsupported',
      message: "Harbour Jellyfin can't play this file on the TV." })
    source.dispose()
  })
  it('includes the following episode from the series episode list', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const plan = await source.playback('episode-tides-5', { resume: false })
    expect(plan.next?.id).toBe('episode-tides-6')
    const request = fake.calls.find((r) => r.url.pathname === '/Shows/show-tides/Episodes')!
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ userId: 'user', startItemId: 'episode-tides-5', limit: '2' })
    source.dispose()
  })
  it('reports whole ticks and paused state, and only deletes active encodings for a stopped transcode', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const direct = await source.playback('film-harbour', { resume: false, audioIdx: 3, subIdx: -1 })
    const plan = await direct.fallback!()
    for (const state of ['start', 'progress', 'paused', 'stopped'] as const) {
      await source.report(plan.report, { state, positionSec: 12.12345678 })
    }
    const reports = fake.calls.filter((r) => r.url.pathname.startsWith('/Sessions/'))
    expect(reports.map((r) => [r.method, r.url.pathname])).toEqual([
      ['POST', '/Sessions/Playing'], ['POST', '/Sessions/Playing/Progress'],
      ['POST', '/Sessions/Playing/Progress'], ['POST', '/Sessions/Playing/Stopped'],
    ])
    for (const request of reports) expect(request.body).toMatchObject({ ItemId: 'film-harbour', MediaSourceId: 'media-harbour',
      PlaySessionId: 'session-harbour', PositionTicks: 121234568, PlayMethod: 'Transcode', AudioStreamIndex: 3,
      SubtitleStreamIndex: -1, CanSeek: true })
    expect(reports[1]!.body.IsPaused).toBe(false)
    expect(reports[2]!.body.IsPaused).toBe(true)
    const stop = fake.calls.at(-1)!
    expect([stop.method, stop.url.pathname]).toEqual(['DELETE', '/Videos/ActiveEncodings'])
    expect(Object.fromEntries(stop.url.searchParams)).toEqual({ deviceId: 'device', playSessionId: 'session-harbour' })
    await source.report(direct.report, { state: 'stopped', positionSec: 1 })
    expect(fake.calls.filter((r) => r.url.pathname === '/Videos/ActiveEncodings')).toHaveLength(1)
    source.dispose()
  })
  it('propagates report failures and marks a rejected playback token signed-out', async () => {
    let reject = false
    const fake = jellyfinReplay(({ url }) => reject && (url.pathname.endsWith('/PlaybackInfo') ||
      url.pathname.startsWith('/Sessions/')) ? new Response(null, { status: 401 }) : undefined)
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const plan = await source.playback('film-harbour', { resume: false })
    reject = true
    await expect(source.report(plan.report, { state: 'progress', positionSec: 1 })).rejects.toMatchObject({ code: 'auth' })
    expect(fake.calls.at(-1)?.url.pathname).toBe('/Sessions/Playing/Progress')
    expect(source.info().status).toBe('signed-out')
    const other = new JellyfinSource({ ...options, fetch: fake.fetch })
    reject = false
    const otherPlan = await other.playback('film-harbour', { resume: false })
    reject = true
    await expect(otherPlan.fallback!()).rejects.toMatchObject({ code: 'auth' })
    expect(fake.calls.at(-1)?.url.pathname).toBe('/Items/film-harbour/PlaybackInfo')
    expect(other.info().status).toBe('signed-out')
    source.dispose(); other.dispose()
  })
  it('always attempts encoding cleanup after a failed stop and preserves the first error', async () => {
    for (const status of [401, 500]) {
      const fake = jellyfinReplay(({ url }) => url.pathname === '/Sessions/Playing/Stopped' ?
        new Response(null, { status }) : url.pathname === '/Videos/ActiveEncodings' ? new Response(null, { status: 404 }) : undefined)
      const source = new JellyfinSource({ ...options, fetch: fake.fetch })
      const plan = await (await source.playback('film-harbour', { resume: false })).fallback!()
      await expect(source.report(plan.report, { state: 'stopped', positionSec: 1 })).rejects.toMatchObject({ status })
      expect(fake.calls.slice(-2).map((r) => [r.method, r.url.pathname])).toEqual([
        ['POST', '/Sessions/Playing/Stopped'], ['DELETE', '/Videos/ActiveEncodings'],
      ])
      source.dispose()
    }
  })
  it('checks playback replies and ignores wrong-typed media and stream fields', async () => {
    let response: unknown = { PlaySessionId: {}, MediaSources: [null, { Id: 'm', DefaultAudioStreamIndex: '2',
      MediaStreams: [null, { Type: 'Audio', Index: -1 }, { Type: 'Audio', Index: 1.2 },
        { Type: 'Audio', Index: 2, DisplayTitle: {}, Codec: {} },
        { Type: 'Subtitle', Index: 3, IsExternal: true, IsTextSubtitleStream: 'yes', DeliveryUrl: {} }] }] }
    const fake = jellyfinReplay(({ url }) => url.pathname.endsWith('/PlaybackInfo') ? Response.json(response) : undefined)
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const plan = await source.playback('film-harbour', { resume: false })
    expect(plan.tracks?.audio).toEqual([{ index: 1, label: 'Unknown language · ', selected: false }])
    expect(plan.subtitles).toEqual([])
    expect(plan.report.data.playSessionId).toBeUndefined()
    expect(plan.report.data.audioIdx).toBeUndefined()
    for (response of [null, 42, []]) {
      await expect(source.playback('film-harbour', { resume: false })).rejects.toMatchObject({ code: 'server' })
    }
    source.dispose()
  })
})
