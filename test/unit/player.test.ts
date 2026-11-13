import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import type { PlaybackPlan, ReportEvent } from '../../src/main/sources/MediaSource'
import { SourceError } from '../../src/main/sources/MediaSource'
import { MockPlayer } from '../../src/main/player/MockPlayer'
import { PlaybackSession } from '../../src/main/player/PlaybackSession'
import { MpvTransport } from '../../src/main/player/mpv/MpvTransport'
import { MpvProcess, findMpv } from '../../src/main/player/mpv/MpvProcess'
import { MpvController } from '../../src/main/player/MpvController'
import { FakeMpv } from '../fixtures/fake-mpv'
import { until } from './helpers'

afterEach(() => vi.useRealTimers())
async function planFor(source: FixtureSource): Promise<PlaybackPlan> {
  const item = (await source.rows()).latest.find((i) => i.type === 'movie')!
  return source.playback(item.id, { resume: false })
}

describe('MpvTransport', () => {
  it('matches out-of-order request ids, observes events and rejects pending calls on close, then reconnects', async () => {
    const server = new FakeMpv(); await server.start()
    const transport = new MpvTransport(server.path)
    try {
      await Promise.all([transport.connect(), transport.connect()])
      server.autoReply = false
      const first = transport.request(['get_property', 'a'])
      const second = transport.request(['get_property', 'b'])
      await until(() => server.commands.length === 2)
      const [a, b] = server.commands
      expect(a?.request_id).not.toBe(b?.request_id)
      server.reply(b!.request_id, 'second'); server.reply(a!.request_id, 'first')
      expect(await first).toBe('first'); expect(await second).toBe('second')
      const event = vi.fn(); transport.onEvent(event); server.autoReply = true
      await transport.observe('time-pos', 1)
      await until(() => event.mock.calls.length > 0)
      expect(event).toHaveBeenCalledWith(expect.objectContaining({ event: 'property-change', name: 'time-pos' }))
      const pending = transport.request(['silence'])
      const rejected = expect(pending).rejects.toThrow('closed')
      server.disconnect(); await rejected
      await transport.connect()
      expect(await transport.request(['get_property', 'duration'])).toBe(120)
    } finally { transport.dispose(); await server.dispose() }
  })
  it('times out unanswered requests with injectable timers', async () => {
    const server = new FakeMpv(); await server.start()
    const transport = new MpvTransport(server.path, { timeoutMs: 80 })
    try {
      await transport.connect(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = transport.request(['silence'])
      const rejected = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(80); await rejected
    } finally { transport.dispose(); await server.dispose() }
  })
})

describe('PlaybackSession and MockPlayer', () => {
  it('serialises rapid replacement requests and leaves no timers after disposal', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), plan = await planFor(source)
    const player = new MockPlayer()
    await Promise.all([player.play(plan, source), player.play({ ...plan, startSec: 50 }, source)])
    await vi.advanceTimersByTimeAsync(300)
    expect(player.state()).toMatchObject({ positionSec: 50, status: 'playing' })
    await player.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('simulates loading, real-time progress, pause, seeking, tracks and final stopped reports without timer leaks', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), plan = await planFor(source)
    const reports: ReportEvent[] = []
    vi.spyOn(source, 'report').mockImplementation(async (_h, e) => { reports.push(e) })
    const player = new MockPlayer()
    try {
      await player.play(plan, source); expect(player.state().status).toBe('loading')
      await player.command({ kind: 'setAudio', index: 2 })
      await vi.advanceTimersByTimeAsync(300); expect(player.state().status).toBe('playing')
      expect(player.state().audioTracks).toHaveLength(2)
      expect(player.state().audioTracks[1]?.selected).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(player.state().positionSec).toBe(10)
      expect(reports.map((r) => r.state)).toEqual(['start', 'progress'])
      await player.command({ kind: 'togglePause' }); await vi.advanceTimersByTimeAsync(15_000)
      expect(player.state().positionSec).toBe(10); expect(reports.at(-1)?.state).toBe('paused')
      await player.command({ kind: 'seekTo', seconds: 42 })
      await player.command({ kind: 'seekRelative', seconds: -2 })
      expect(player.state().positionSec).toBe(40)
      await player.command({ kind: 'setSubtitle', index: 2 })
      expect(player.state().subtitleTracks[1]?.selected).toBe(true)
      await player.command({ kind: 'setSubtitle', index: null })
      expect(player.state().subtitleTracks.some((t) => t.selected)).toBe(false)
      await player.command({ kind: 'togglePause' }); await vi.advanceTimersByTimeAsync(1125)
      await player.stop()
      expect(reports.at(-1)).toEqual({ state: 'stopped', positionSec: 41.125 })
      expect(reports.filter((r) => r.state === 'start')).toHaveLength(1)
    } finally { await player.dispose(); source.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('shows up next, cancels auto play and ends; auto play loads the following episode when enabled', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), plan = await planFor(source)
    const next = { ...plan.item, id: 'next', key: 'demo~next' }
    const short = { ...plan, durationSec: 12, next }
    const player = new MockPlayer({ autoPlayNext: () => true })
    const playback = vi.spyOn(source, 'playback').mockResolvedValue({ ...plan, item: next })
    try {
      await player.play(short, source); await vi.advanceTimersByTimeAsync(2300)
      expect(player.state().upNext?.id).toBe('next')
      await player.command({ kind: 'cancelUpNext' }); await vi.advanceTimersByTimeAsync(10_000)
      expect(player.state().status).toBe('ended'); expect(playback).not.toHaveBeenCalled()
      await player.play(short, source); await vi.advanceTimersByTimeAsync(12_600)
      expect(playback).toHaveBeenCalledWith('next', { resume: false })
      expect(player.state().item?.id).toBe('next'); expect(player.state().status).toBe('playing')
    } finally { await player.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not stop playback when reporting fails and fetches a fallback only once', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), plan = await planFor(source)
    vi.spyOn(source, 'report').mockRejectedValue(new Error('offline'))
    const fallback = vi.fn().mockResolvedValue({ ...plan, method: 'transcode' })
    const load = vi.fn().mockResolvedValue(undefined), upNext = vi.fn(), playNext = vi.fn()
    const session = new PlaybackSession({ ...plan, fallback }, source, { load, upNext, playNext })
    try {
      expect(await session.end('error')).toBe('fallback')
      expect(fallback).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1)
      session.playing(); await vi.advanceTimersByTimeAsync(10_000)
      session.update(55); session.paused(); await session.stop()
      expect(source.report).toHaveBeenLastCalledWith(plan.report, { state: 'stopped', positionSec: 55 })
      expect(await session.end('error')).toBe('ended'); expect(fallback).toHaveBeenCalledTimes(1)
    } finally { await session.dispose() }
  })
})

describe('MpvController with a real JSON IPC socket', () => {
  it('loads start and headers via IPC, maps tracks, pauses, seeks, reports every 10 seconds, and stops at the final position', async () => {
    const server = new FakeMpv(); await server.start()
    const transport = new MpvTransport(server.path)
    const source = new FixtureSource(), original = await planFor(source)
    const plan = { ...original, startSec: 7, headers: { Authorization: 'secret' }, subtitles: [{ url: 'https://test/sub', lang: 'eng' }] }
    const reports: ReportEvent[] = []
    vi.spyOn(source, 'report').mockImplementation(async (_h, e) => { reports.push(e) })
    const player = new MpvController({ transport })
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      await player.play(plan, source); await until(() => player.state().status === 'playing')
      expect(player.state().positionSec).toBe(7)
      await until(() => player.state().audioTracks.length === 2)
      expect(player.state().subtitleTracks[0]).toMatchObject({ index: 3, label: 'English SDH' })
      await until(() => server.commands.some((c) => c.command[0] === 'sub-add'))
      expect(server.properties.get('http-header-fields')).toEqual(['Authorization: secret'])
      await player.command({ kind: 'togglePause' }); await until(() => player.state().status === 'paused')
      await player.command({ kind: 'seekTo', seconds: 50 }); await until(() => player.state().positionSec === 50)
      await player.command({ kind: 'seekRelative', seconds: -5 }); await until(() => player.state().positionSec === 45)
      await player.command({ kind: 'setAudio', index: 2 }); expect(server.properties.get('aid')).toBe(2)
      await player.command({ kind: 'setSubtitle', index: null }); expect(server.properties.get('sid')).toBe('no')
      await player.command({ kind: 'togglePause' }); await until(() => player.state().status === 'playing')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(reports.filter((e) => e.state === 'progress')).toHaveLength(2)
      await player.stop(); expect(reports.at(-1)).toEqual({ state: 'stopped', positionSec: 45 })
      expect(player.state().status).toBe('idle')
    } finally { await player.dispose(); await server.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('falls back once on a load error, reaches ended, and keeps Plex paywall messages', async () => {
    const server = new FakeMpv(); server.failLoads = 1; await server.start()
    const transport = new MpvTransport(server.path)
    const source = new FixtureSource(), plan = await planFor(source)
    const fallback = vi.fn().mockResolvedValue({ ...plan, method: 'transcode' })
    const player = new MpvController({ transport })
    try {
      await player.play({ ...plan, fallback }, source)
      await until(() => player.state().status === 'playing')
      expect(fallback).toHaveBeenCalledTimes(1); expect(player.state().method).toBe('transcode')
      server.property('time-pos', 120); server.send({ event: 'end-file', reason: 'eof' })
      await until(() => player.state().status === 'ended')
      server.failLoads = 1
      await player.play({ ...plan, fallback: async () => { throw new SourceError('This server needs Plex Pass.', 'paywall') } }, source)
      await until(() => player.state().status === 'error')
      expect(player.state().error).toBe('This server needs Plex Pass.')
    } finally { await player.dispose(); await server.dispose() }
  })
  it('shows and seeks in media time for a transcode started part-way through, and saves the media time on stop', async () => {
    const server = new FakeMpv(); server.failLoads = 1; await server.start()
    const source = new FixtureSource(), plan = await planFor(source)
    const reports: ReportEvent[] = []
    vi.spyOn(source, 'report').mockImplementation(async (_h, e) => { reports.push(e) })
    const fallback = vi.fn().mockResolvedValue({ ...plan, method: 'transcode', startSec: 0, timeBaseSec: 600, durationSec: 3600 })
    const player = new MpvController({ transport: new MpvTransport(server.path) })
    try {
      await player.play({ ...plan, startSec: 600, durationSec: 3600, fallback }, source)
      await until(() => player.state().status === 'playing')
      server.property('duration', 3600); server.property('time-pos', 5)
      await until(() => player.state().positionSec === 605)
      expect(player.state().durationSec).toBe(3600)
      await player.command({ kind: 'seekTo', seconds: 900 }); await until(() => player.state().positionSec === 900)
      expect(server.commands.find((c) => c.command[0] === 'seek')?.command[1]).toBe(300)
      await player.stop(); expect(reports.at(-1)).toEqual({ state: 'stopped', positionSec: 900 })
    } finally { await player.dispose(); await server.dispose() }
  })
  it('throttles position-only changes to four events a second and handles buffering', async () => {
    const server = new FakeMpv(); await server.start()
    const player = new MpvController({ transport: new MpvTransport(server.path) })
    const source = new FixtureSource()
    try {
      await player.play(await planFor(source), source); await until(() => player.state().status === 'playing')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const events = vi.fn(); player.onState(events)
      for (let i = 0; i < 20; i++) server.property('time-pos', i)
      await until(() => player.state().positionSec === 19)
      await vi.advanceTimersByTimeAsync(250)
      expect(events.mock.calls.length).toBeLessThanOrEqual(2)
      server.property('paused-for-cache', true); await until(() => player.state().status === 'buffering')
      server.property('paused-for-cache', false); await until(() => player.state().status === 'playing')
    } finally { await player.dispose(); await server.dispose() }
  })
})

it('spawns mpv with safe argv, retries the pipe and kills it on dispose; finds a binary without executing it', async () => {
  const server = new FakeMpv(); await server.start()
  const child = new EventEmitter() as ChildProcess
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', 0)); return true })
  const spawn = vi.fn((_file: string, _args: string[]) => child)
  const process = new MpvProcess({ pipe: server.path, mpvPath: 'custom-mpv', spawn })
  try {
    const transport = await process.start(); expect(await transport.request(['get_property', 'duration'])).toBe(120)
    expect(spawn.mock.calls[0]?.[0]).toBe('custom-mpv')
    const argv = spawn.mock.calls[0]?.[1] ?? []
    expect(argv).toContain('--idle=yes'); expect(argv).toContain('--input-vo-keyboard=no')
    for (const flag of ['--force-window=yes', `--input-ipc-server=${server.path}`, '--fullscreen', '--no-terminal',
      '--keep-open=no', '--osc=no', '--input-default-bindings=no', '--hwdec=auto-safe']) expect(argv).toContain(flag)
    expect(argv.some((a: string) => a.includes('header'))).toBe(false)
    const access = vi.fn(async (path: string) => { if (!path.endsWith('mpv.exe')) throw new Error('missing') })
    expect(await findMpv('mpv.exe', { PATH: 'C:\\tools' }, access)).toContain('mpv.exe')
  } finally { await process.dispose(); await server.dispose() }
  expect(child.kill).toHaveBeenCalled()
})
