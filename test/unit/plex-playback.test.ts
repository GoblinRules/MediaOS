import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexSource } from '../../src/main/sources/plex/PlexSource'
import { PlaybackSession } from '../../src/main/player/PlaybackSession'
import { plexOptions, plexReplay, plexFixture, type PlexCatalogue } from './helpers'

const sources: PlexSource[] = []
function setup(override?: Parameters<typeof plexReplay>[0]) {
  const fake = plexReplay(override), source = new PlexSource({ ...plexOptions, fetch: fake.fetch })
  sources.push(source)
  return { source, fake }
}
afterEach(() => { sources.splice(0).forEach((s) => s.dispose()); vi.useRealTimers() })
describe('Plex playback', () => {
  it('reports media time throughout resumed HLS playback and shows Up next at the media end', async () => {
    vi.useFakeTimers()
    const { source, fake } = setup()
    const direct = await source.playback('101', { resume: true })
    const upNext = vi.fn(), next = await source.item('206')
    const session = new PlaybackSession(direct, source, { load: async () => {}, upNext, playNext: async () => {} })
    expect(await session.end('error')).toBe('fallback')
    // Supply a next item to also check the session's end-of-media comparison.
    session.plan.next = next
    session.playing()
    session.update(15.25, 6000)
    await vi.advanceTimersByTimeAsync(10_000)
    session.paused()
    session.update(5989.9, 6000)
    expect(upNext).not.toHaveBeenCalled()
    session.update(5990, 6000)
    expect(upNext).toHaveBeenCalledExactlyOnceWith(next)
    await session.stop()
    const calls = fake.calls.filter((c) => c.url.pathname === '/:/timeline')
    expect(calls.map((c) => [c.url.searchParams.get('state'), c.url.searchParams.get('time')])).toEqual([
      ['playing', '1200500'], ['playing', '1215750'], ['paused', '1215750'], ['stopped', '7190500'],
    ])
    expect(calls.every((c) => c.url.searchParams.get('duration') === '7200500')).toBe(true)
  })
  it('plans direct play, resume, ordered track ids, sidecar subtitles and the next episode', async () => {
    const { source } = setup()
    const plan = await source.playback('101', { resume: true, audioIdx: 611, subIdx: 620 })
    expect(plan).toMatchObject({ method: 'direct', startSec: 1200.5, durationSec: 7200.5,
      url: 'https://home-a.plex.direct:32400/library/parts/501/1700/file.mkv',
      headers: { 'X-Plex-Token': 'private-server-a', 'X-Plex-Client-Identifier': 'test-device' },
      selection: { audio: 2, subtitle: 2 }, subtitles: [{ lang: 'eng' }, { lang: 'fra' }],
      report: { data: { ratingKey: '101', duration: 7200500, method: 'direct' } } })
    expect([plan.url, ...plan.subtitles.map((s) => s.url)].join()).not.toMatch(/token|private-/i)
    expect((await source.playback('101', { resume: false, subIdx: -1 })).selection).toEqual({ subtitle: null })
    expect((await source.playback('101', { resume: false })).startSec).toBe(0)
    expect((await source.playback('101', { resume: false, audioIdx: 999, subIdx: 998 })).selection).toBeUndefined()
    expect((await source.playback('101', { resume: false, subIdx: 621 })).selection).toEqual({ subtitle: 1 })
    expect((await source.playback('205', { resume: false })).next?.id).toBe('206')
    expect((await source.playback('206', { resume: false })).next).toBeUndefined()
  })
  it('saves chosen streams then requests an HLS decision and produces an offset server transcode', async () => {
    const { source, fake } = setup()
    const plan = await source.playback('101', { resume: true, audioIdx: 611, subIdx: -1 })
    const fallback = await plan.fallback!()
    const put = fake.calls.find((c) => c.method === 'PUT')!
    expect(put.url.pathname).toBe('/library/parts/501')
    expect(Object.fromEntries(put.url.searchParams)).toEqual({ allParts: '1', audioStreamID: '611', subtitleStreamID: '0' })
    const url = new URL(fallback.url)
    expect(fallback).toMatchObject({ method: 'transcode', startSec: 0, subtitles: [], report: { data: {
      method: 'transcode', session: url.searchParams.get('session'),
    } } })
    expect(fallback.selection).toBeUndefined()
    expect(url.pathname).toBe('/video/:/transcode/universal/start.m3u8')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ path: '/library/metadata/101', protocol: 'hls',
      directPlay: '0', directStream: '1', fastSeek: '1', subtitles: 'burn', offset: '1200.5', mediaIndex: '0', partIndex: '0' })
    expect(url.searchParams.get('X-Plex-Client-Profile-Extra')).toContain('videoCodec=h264,hevc&audioCodec=aac,ac3,eac3')
    expect(url.searchParams.get('X-Plex-Client-Profile-Name')).toBe('Generic')
    expect(fallback.url).not.toMatch(/token|private-/i)
    const decision = fake.calls.find((c) => c.url.pathname.endsWith('/decision'))!
    expect(decision.url.search).toBe(url.search)
  })
  it('ignores a parts PUT error but explains a refused decision and missing or unsafe parts', async () => {
    const { source } = setup(({ method, url }) => method === 'PUT' ? new Response(null, { status: 500 }) :
      url.pathname.endsWith('/decision') ? { MediaContainer: { generalDecisionCode: 4000 } } : undefined)
    const plan = await source.playback('101', { resume: false, subIdx: -1 })
    await expect(plan.fallback!()).rejects.toMatchObject({ code: 'unsupported', message: "Home Plex can't play this file on the TV." })
    for (const Media of [[], [{ Part: [{ key: 'https://other.invalid/file' }] }]]) {
      const bad = setup(({ url }) => url.pathname === '/library/metadata/101' ? { MediaContainer: {
        Metadata: [{ ...plexFixture<PlexCatalogue>('catalogue').movie, Media }],
      } } : undefined)
      await expect(bad.source.playback('101', { resume: false })).rejects.toMatchObject({ code: 'unsupported' })
    }
  })
  it('re-finds the server for an offline transcode decision and uses the new connection for the HLS URL', async () => {
    const { source, fake } = setup(({ url }) => {
      if (url.pathname.endsWith('/decision') && url.hostname === 'home-a.plex.direct') throw Error('address changed')
      if (url.hostname === 'clients.plex.tv') return [{ clientIdentifier: 'server-a', name: 'Home Plex', provides: 'server',
        connections: [{ uri: 'http://192.168.1.20:32400', local: true }] }]
    })
    const direct = await source.playback('101', { resume: false }), fallback = await direct.fallback!()
    expect(new URL(fallback.url).origin).toBe('http://192.168.1.20:32400')
    expect(fake.calls.filter((c) => c.url.pathname.endsWith('/decision'))).toHaveLength(2)
  })
  it('reports timeline states in milliseconds with session headers and stops transcodes even after a timeline auth error', async () => {
    let auth = false
    const { source, fake } = setup(({ url }) => auth && url.pathname === '/:/timeline' ?
      new Response(null, { status: 401 }) : undefined)
    const direct = await source.playback('101', { resume: false })
    for (const state of ['start', 'progress', 'paused', 'stopped'] as const) {
      await source.report(direct.report, { state, positionSec: 12.3456 })
    }
    const calls = fake.calls.filter((c) => c.url.pathname === '/:/timeline')
    expect(calls.map((c) => c.url.searchParams.get('state'))).toEqual(['playing', 'playing', 'paused', 'stopped'])
    for (const c of calls) {
      expect(Object.fromEntries(c.url.searchParams)).toMatchObject({ ratingKey: '101', key: '/library/metadata/101',
        time: '12346', duration: '7200500' })
      expect(c.headers.get('X-Plex-Session-Identifier')).toBe(direct.report.data.session)
    }
    const transcode = await direct.fallback!()
    auth = true
    await expect(source.report(transcode.report, { state: 'stopped', positionSec: 30 })).rejects.toMatchObject({ code: 'auth' })
    expect(source.info().status).toBe('signed-out')
    expect(fake.calls.at(-1)!.url.pathname).toBe('/video/:/transcode/universal/stop')
    expect(fake.calls.at(-1)!.url.searchParams.get('session')).toBe(transcode.report.data.session)
  })
})
