import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { PlayerBase } from '../../src/main/player/PlayerBase'
import { MockPlayer } from '../../src/main/player/MockPlayer'
import { PlaybackSession } from '../../src/main/player/PlaybackSession'
import { MpvProcess } from '../../src/main/player/mpv/MpvProcess'
import { MpvTransport } from '../../src/main/player/mpv/MpvTransport'
import { MpvController } from '../../src/main/player/MpvController'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import type { PlaybackPlan } from '../../src/main/sources/MediaSource'
import { runtime } from '../../src/main/core/runtime'
import { silentLog } from '../../src/main/log/Logger'
import { FakeMpv } from '../fixtures/fake-mpv'
import { deferred, temporary, until } from './helpers'
import type { PlayerOptions } from '../../src/main/player/PlayerBase'

afterEach(() => vi.useRealTimers())
async function fixture() {
  const source = new FixtureSource()
  const movie = (await source.rows()).latest.find((i) => i.type === 'movie')!
  const plan = await source.playback(movie.id, { resume: false })
  return { source, plan, next: { ...movie, id: 'next', key: 'demo~next' } }
}
class ProbePlayer extends PlayerBase {
  load = vi.fn(async (_plan: PlaybackPlan) => undefined)
  halt = vi.fn(async (): Promise<void> => undefined)
  control = vi.fn(async (): Promise<void> => undefined)
  finish(reason: string) { return this.ended(reason) }
  disconnect(error: unknown) { this.lost(error) }
  move(position: number) { this.position(position) }
  constructor(opts: PlayerOptions = {}) { super('mock', { clock: runtime, ...opts }) }
}

describe('player race regressions', () => {
  it.each(['manual', 'automatic'])('halts after a failed %s next plan and keeps error after a later EOF', async (trigger) => {
    const { source, plan, next } = await fixture(), warn = vi.fn()
    vi.spyOn(source, 'playback').mockRejectedValue(new Error('server gone'))
    const player = new ProbePlayer({ autoPlayNext: () => true, logger: { ...silentLog, warn } })
    try {
      await player.play({ ...plan, next }, source)
      player.move(plan.durationSec! - 5)
      expect(player.state().upNext).toEqual(next)
      player.halt.mockClear()
      player.halt.mockRejectedValueOnce(new Error('mpv did not exit'))
      if (trigger === 'manual') await player.command({ kind: 'playNext' })
      else await player.finish('eof')
      expect(player.halt).toHaveBeenCalledTimes(1)
      expect(player.state()).toMatchObject({ status: 'error', upNext: undefined })
      expect(warn.mock.calls).toEqual([['The player could not be closed']])
      await player.finish('eof')
      expect(player.state().status).toBe('error')
    } finally { await player.dispose() }
  })
  it.each(['load', 'ended', 'fallback', 'lost'])('reports an error when %s teardown rejects once', async (path) => {
    const { source, plan } = await fixture(), warn = vi.fn()
    const player = new ProbePlayer({ logger: { ...silentLog, warn } })
    try {
      if (path === 'load') player.load.mockImplementationOnce(async () => {
        player.halt.mockRejectedValueOnce(new Error('mpv did not exit'))
        throw new Error('load failed')
      })
      await player.play({ ...plan, ...(path === 'fallback' ? {
        fallback: async () => { throw new Error('fallback failed') },
      } : {}) }, source)
      if (path !== 'load') {
        player.halt.mockRejectedValueOnce(new Error('mpv did not exit'))
        if (path === 'lost') {
          player.disconnect(new Error('pipe closed'))
          await until(() => player.state().status === 'error')
        } else await player.finish('error')
      }
      expect(player.state().status).toBe('error')
      expect(warn.mock.calls).toEqual([['The player could not be closed']])
    } finally { await player.dispose(); source.dispose() }
  })
  it('stays ended without an error when the player is lost after the programme finished', async () => {
    const { source, plan } = await fixture(), error = vi.fn(), gate = deferred<void>()
    const player = new ProbePlayer({ logger: { ...silentLog, error } })
    try {
      await player.play(plan, source)
      // Hold the queue so the end of the programme and the loss of the player are both waiting in it.
      player.control.mockImplementationOnce(() => gate.promise)
      const held = player.command({ kind: 'togglePause' })
      await until(() => player.control.mock.calls.length === 1)
      const finished = player.finish('eof')
      for (let n = 0; n < 20; n++) await new Promise<void>((resolve) => setImmediate(resolve))
      player.disconnect(new Error('pipe closed'))
      gate.resolve(); await held; await finished
      await until(() => player.state().status === 'ended')
      for (let n = 0; n < 20; n++) await new Promise<void>((resolve) => setImmediate(resolve))
      expect(player.state().status).toBe('ended'); expect(player.state().error).toBeUndefined()
      expect(error).not.toHaveBeenCalled()
    } finally { gate.resolve(); await player.dispose(); source.dispose() }
  })
  it.each(['manual', 'automatic'])('cancels a pending %s next plan after the player is lost, then stops to idle', async (trigger) => {
    const { source, plan, next } = await fixture(), pending = deferred<PlaybackPlan>()
    const playback = vi.spyOn(source, 'playback').mockReturnValue(pending.promise)
    const player = new ProbePlayer({ autoPlayNext: () => true })
    try {
      await player.play({ ...plan, next }, source)
      const advance = trigger === 'manual' ? player.command({ kind: 'playNext' }) : player.finish('eof')
      await until(() => playback.mock.calls.length === 1)
      player.disconnect(new Error('pipe closed'))
      await until(() => player.state().status === 'error')
      pending.resolve({ ...plan, item: next }); await advance
      expect(player.load).toHaveBeenCalledTimes(1)
      expect(player.state().status).toBe('error')
      await player.stop()
      expect(player.state().status).toBe('idle')
    } finally { pending.resolve(plan); await player.dispose(); source.dispose() }
  })
  it('keeps the player foreground during an EOF in the manual next-plan gap', async () => {
    const { source, plan, next } = await fixture(), pending = deferred<PlaybackPlan>()
    vi.spyOn(source, 'playback').mockReturnValue(pending.promise)
    const player = new ProbePlayer(), states: string[] = []
    try {
      await player.play({ ...plan, next }, source)
      player.onState((state) => states.push(state.status))
      const advance = player.command({ kind: 'playNext' })
      await until(() => vi.mocked(source.playback).mock.calls.length === 1)
      await player.finish('eof')
      pending.resolve({ ...plan, item: next }); await advance
      expect(states).toEqual(['loading'])
      expect(player.load).toHaveBeenCalledTimes(2)
      expect(player.state().item?.id).toBe('next')
    } finally { pending.resolve(plan); await player.dispose() }
  })
  it('reaches idle, reports stopped and clears listeners after teardown rejects', async () => {
    const { source, plan } = await fixture(), warn = vi.fn(), events = vi.fn()
    const report = vi.spyOn(source, 'report')
    const player = new ProbePlayer({ logger: { ...silentLog, warn } })
    await player.play(plan, source)
    player.onState(events)
    player.halt.mockRejectedValue(new Error('private teardown details'))
    await player.stop()
    expect(player.state().status).toBe('idle')
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ status: 'idle' }))
    expect(report).toHaveBeenCalledWith(plan.report, expect.objectContaining({ state: 'stopped' }))
    expect(warn.mock.calls).toEqual([['The player could not be closed']])
    await player.dispose()
    events.mockClear(); player.move(99)
    expect(events).not.toHaveBeenCalled()
  })
  it.each(['stop', 'replace', 'dispose'] as const)('lets %s win over a delayed next plan or its failure', async (action) => {
    for (const fail of [false, true]) {
      const { source, plan, next } = await fixture()
      const pending = deferred<PlaybackPlan>()
      vi.spyOn(source, 'playback').mockReturnValue(pending.promise)
      const player = new ProbePlayer()
      await player.play({ ...plan, next }, source)
      const advance = player.command({ kind: 'playNext' })
      await until(() => vi.mocked(source.playback).mock.calls.length === 1)
      if (action === 'stop') await player.stop()
      if (action === 'replace') await player.play({ ...plan, startSec: 42 }, source)
      if (action === 'dispose') await player.dispose()
      const state = player.state()
      if (fail) pending.reject(new Error('late failure'))
      else pending.resolve({ ...plan, item: next })
      await advance
      expect(player.state()).toEqual(state)
      expect(player.load).toHaveBeenCalledTimes(action === 'replace' ? 2 : 1)
      await player.dispose()
    }
  })
  it('checks the next generation inside the queue, after a Stop queued during plan resolution', async () => {
    const { source, plan, next } = await fixture(), pending = deferred<PlaybackPlan>()
    vi.spyOn(source, 'playback').mockReturnValue(pending.promise)
    const player = new ProbePlayer()
    await player.play({ ...plan, next }, source)
    const advance = player.command({ kind: 'playNext' })
    await until(() => vi.mocked(source.playback).mock.calls.length === 1)
    pending.resolve({ ...plan, item: next })
    const stop = player.stop()
    await Promise.all([advance, stop])
    expect(player.state().status).toBe('idle'); expect(player.load).toHaveBeenCalledTimes(1)
    await player.dispose()
  })
  it('starts the next episode once when manual and automatic next overlap', async () => {
    const { source, plan, next } = await fixture(), stopped = deferred<void>()
    vi.spyOn(source, 'report').mockReturnValue(stopped.promise)
    const playNext = vi.fn(async () => undefined)
    const session = new PlaybackSession({ ...plan, next }, source, {
      load: async () => undefined, upNext() {}, playNext, autoPlayNext: () => true,
    })
    const ended = session.end('eof'), manual = session.playNext()
    stopped.resolve()
    await Promise.all([ended, manual])
    expect(playNext).toHaveBeenCalledTimes(1)
  })
  it.each(['eof', 'error'])('serialises %s teardown before a queued replacement', async (reason) => {
    const { source, plan } = await fixture(), halted = deferred<void>()
    const player = new ProbePlayer()
    await player.play(plan, source)
    player.halt.mockImplementationOnce(() => halted.promise)
    const ending = player.finish(reason)
    await until(() => player.halt.mock.calls.length === 2)
    const replacing = player.play({ ...plan, startSec: 42 }, source)
    await Promise.resolve()
    expect(player.load).toHaveBeenCalledTimes(1)
    halted.resolve()
    await Promise.all([ending, replacing])
    expect(player.state()).toMatchObject({ status: 'loading', positionSec: 42 })
    await player.dispose()
  })
  it('ignores a fallback failure after replacement and serialises fallback loading behind controls', async () => {
    const { source, plan } = await fixture(), fallback = deferred<PlaybackPlan>()
    const player = new ProbePlayer()
    await player.play({ ...plan, fallback: () => fallback.promise }, source)
    const ending = player.finish('error')
    await player.play({ ...plan, startSec: 42 }, source)
    fallback.reject(new Error('late fallback failure')); await ending
    expect(player.state()).toMatchObject({ status: 'loading', positionSec: 42 })
    const replacement = deferred<PlaybackPlan>(), control = deferred<void>()
    await player.play({ ...plan, fallback: () => replacement.promise }, source)
    player.control.mockImplementationOnce(() => control.promise)
    const command = player.command({ kind: 'togglePause' })
    await until(() => player.control.mock.calls.length === 1)
    const failure = player.finish('error')
    replacement.resolve({ ...plan, method: 'transcode' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(player.load).toHaveBeenCalledTimes(3)
    const stop = player.stop()
    control.resolve(); await Promise.all([failure, command, stop])
    expect(player.state().status).toBe('idle')
    await player.dispose()
  })
  it.each(['eof', 'error'])('checks %s completion generation after entering the serial queue', async (reason) => {
    const { source, plan } = await fixture(), control = deferred<void>(), fallback = deferred<PlaybackPlan>()
    const player = new ProbePlayer()
    await player.play({ ...plan, fallback: () => fallback.promise }, source)
    player.control.mockImplementationOnce(() => control.promise)
    const command = player.command({ kind: 'togglePause' })
    await until(() => player.control.mock.calls.length === 1)
    const ending = player.finish(reason)
    const replacing = player.play({ ...plan, startSec: 42 }, source)
    if (reason === 'error') fallback.reject(new Error('failed fallback'))
    // Allow end() to enqueue its completion while the old generation still owns the player.
    for (let n = 0; n < 10; n++) await Promise.resolve()
    control.resolve(); await Promise.all([command, ending, replacing])
    expect(player.state()).toMatchObject({ status: 'loading', positionSec: 42 })
    expect(player.halt).toHaveBeenCalledTimes(2)
    await player.dispose()
  })
  it('loads an initial command-failure fallback without deadlocking its own serial job', async () => {
    const { source, plan } = await fixture(), player = new ProbePlayer()
    player.load.mockRejectedValueOnce(new Error('loadfile failed'))
    await player.play({ ...plan, fallback: async () => ({ ...plan, method: 'transcode' }) }, source)
    expect(player.load).toHaveBeenCalledTimes(2)
    expect(player.state()).toMatchObject({ status: 'loading', method: 'transcode' })
    await player.dispose()
  })
  it('limits a direct fallback to one attempt even if its plan has another direct fallback', async () => {
    const { source, plan } = await fixture()
    const fallback: () => Promise<PlaybackPlan> = vi.fn(async () => ({ ...plan, method: 'direct' as const, fallback }))
    const load = vi.fn(async () => undefined)
    const session = new PlaybackSession({ ...plan, fallback }, source, { load, upNext() {}, playNext: async () => undefined })
    expect(await session.end('error')).toBe('fallback')
    expect(await session.end('error')).toBe('ended')
    expect(fallback).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1)
  })
  it('emits four to five position events per second and a trailing final position', async () => {
    vi.useFakeTimers()
    const player = new ProbePlayer(), events = vi.fn()
    player.onState(events)
    for (let n = 0; n < 100; n++) { player.move(n); await vi.advanceTimersByTimeAsync(10) }
    expect(events.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(events.mock.calls.length).toBeLessThanOrEqual(5)
    player.move(100)
    const count = events.mock.calls.length
    await vi.advanceTimersByTimeAsync(249)
    expect(events).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toHaveBeenCalledTimes(count + 1)
    expect(events.mock.lastCall?.[0].positionSec).toBe(100)
    await player.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
})

describe('track selection', () => {
  it.each([5, -1])('maps fixture subtitle source index %s to the mock player', async (subIdx) => {
    const { source, plan } = await fixture(), player = new MockPlayer()
    try {
      const chosen = await source.playback(plan.item.id, { resume: false, subIdx, audioIdx: 2 })
      await player.play(chosen, source)
      expect(player.state().subtitleTracks.filter((t) => t.selected).map((t) => t.index)).toEqual(subIdx === 5 ? [3] : [])
      expect(player.state().subtitleTracks[2]?.label).toBe('Français')
      expect(player.state().audioTracks.find((t) => t.selected)?.index).toBe(2)
    } finally { await player.dispose() }
  })
  it('applies mpv choices after external subtitles and only logs selection failures', async () => {
    const server = new FakeMpv(); await server.start()
    const transport = new MpvTransport(server.path), warn = vi.fn()
    const { source, plan } = await fixture()
    const original = transport.request.bind(transport)
    const request = vi.spyOn(transport, 'request')
    const player = new MpvController({ transport, logger: { ...silentLog, warn } })
    try {
      request.mockImplementation((command) => command[0] === 'get_property' && command[1] === 'track-list'
        ? Promise.resolve([{ type: 'sub', id: 1 }, { type: 'sub', id: 2 },
          { type: 'sub', id: 3, external: true, 'external-filename': 'https://test/sub' }]) : original(command))
      await player.play({ ...plan, subtitles: [{ url: 'https://test/sub' }], selection: { audio: 2, subtitle: 3 } }, source)
      await until(() => server.properties.get('sid') === 3)
      expect(server.properties.get('aid')).toBe(2)
      const commands = server.commands.map((c) => c.command)
      const add = commands.findIndex((c) => c[0] === 'sub-add')
      expect(add).toBeGreaterThanOrEqual(0)
      expect(commands[add]?.[1]).toBe('https://test/sub')
      expect(commands.findIndex((c) => c[1] === 'sid')).toBeGreaterThan(add)
      await player.play({ ...plan, selection: { subtitle: null } }, source)
      await until(() => server.properties.get('sid') === 'no')
      await player.play({ ...plan, selection: undefined }, source)
      await until(() => player.state().status === 'playing')
      const sidCommands = server.commands.filter((c) => c.command[1] === 'sid')
      expect(sidCommands).toHaveLength(2)
      request.mockImplementation((command) => command[1] === 'sid' ? Promise.reject(new Error('bad track')) : original(command))
      await player.play({ ...plan, selection: { subtitle: null } }, source)
      await until(() => warn.mock.calls.length === 1)
      expect(player.state().status).toBe('playing')
    } finally { await player.dispose(); await server.dispose() }
  })
})

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', 0)); return true })
  return child
}
describe('mpv pipe loss', () => {
  it('shuts mpv down once and starts a fresh one for the next video', async () => {
    const server = new FakeMpv(); await server.start()
    const children: ChildProcess[] = []
    const spawn = vi.fn(() => { const child = childProcess(); children.push(child); return child })
    const process = new MpvProcess({ platform: 'win32', spawn, transport: () => new MpvTransport(server.path) })
    const { source, plan } = await fixture()
    const player = new MpvController({ process }), states: string[] = []
    player.onState((s) => states.push(s.status))
    try {
      await player.play(plan, source)
      await until(() => player.state().status === 'playing')
      server.disconnect()
      await until(() => children[0] !== undefined && vi.mocked(children[0].kill).mock.calls.length === 1)
      expect(player.state().status).toBe('error')
      expect(states.filter((s) => s === 'error')).toHaveLength(1)
      await player.play(plan, source)
      await until(() => player.state().status === 'playing')
      expect(spawn).toHaveBeenCalledTimes(2)
    } finally { await player.dispose(); await server.dispose() }
  })
})

describe('mpv process lifecycle', () => {
  it('recovers the stopping queue after a child never exits', async () => {
    vi.useFakeTimers()
    const hung = childProcess(), fresh = childProcess(), transport = new MpvTransport('unused')
    hung.kill = vi.fn(() => true)
    vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
    const spawn = vi.fn().mockReturnValueOnce(hung).mockReturnValue(fresh)
    const process = new MpvProcess({ platform: 'win32', spawn, transport: () => transport })
    await process.start()
    const rejected = expect(process.dispose()).rejects.toThrow('mpv did not exit')
    await vi.advanceTimersByTimeAsync(4000); await rejected
    expect(hung.kill).toHaveBeenCalledTimes(2)
    await process.start()
    expect(spawn).toHaveBeenCalledTimes(2)
    await process.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([false, true])('removes only generated Linux sockets (injected: %s)', async (injected) => {
    const temp = await temporary(), child = childProcess(), transport = new MpvTransport('unused')
    vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
    const process = new MpvProcess({ platform: 'linux', spawn: () => child, transport: () => transport,
      ...(injected ? { pipe: join(temp.dir, 'owned.sock') } : {}) })
    try {
      await process.start()
      if (!injected) expect(process.pipe).toMatch(/mediaos-mpv-[a-f0-9-]+\.sock$/)
      await fs.writeFile(process.pipe, 'socket placeholder', 'utf8')
      await process.dispose()
      if (injected) expect(await fs.readFile(process.pipe, 'utf8')).toBe('socket placeholder')
      else await expect(fs.stat(process.pipe)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { await process.dispose(); await fs.rm(process.pipe, { force: true }); await temp.dispose() }
  })
  it('retries failed pipe connections and supplies the exact endpoint argument', async () => {
    vi.useFakeTimers()
    const child = childProcess(), transport = new MpvTransport('unused')
    const connect = vi.spyOn(transport, 'connect').mockRejectedValueOnce(new Error('not ready'))
      .mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(undefined)
    vi.spyOn(transport, 'dispose').mockImplementation(() => undefined)
    const spawn = vi.fn((_file: string, _args: string[]) => child)
    const factory = vi.fn((_path: string) => transport)
    const process = new MpvProcess({ platform: 'win32', spawn, transport: factory })
    const started = process.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(await started).toBe(transport); expect(connect).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[0]?.[1]).toContain(`--input-ipc-server=${process.pipe}`)
    expect(factory.mock.calls.map(([path]) => path)).toEqual([process.pipe, process.pipe, process.pipe])
    expect(factory.mock.calls).toHaveLength(3)
    expect(process.pipe).toMatch(/^\\\\\.\\pipe\\mediaos-mpv-[a-f0-9-]+$/)
    await process.dispose()
    const previous = process.pipe
    await process.start(); expect(process.pipe).not.toBe(previous)
    await process.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('gives up after five seconds, and handles spawn errors and early exits promptly', async () => {
    vi.useFakeTimers()
    for (const failure of ['timeout', 'error', 'exit']) {
      const child = childProcess(), transport = new MpvTransport('unused')
      vi.spyOn(transport, 'connect').mockRejectedValue(new Error('not ready'))
      const process = new MpvProcess({ spawn: () => child, transport: () => transport })
      const started = process.start(), rejected = expect(started).rejects.toThrow(failure === 'timeout' ? 'ready' : 'mpv')
      await vi.advanceTimersByTimeAsync(0)
      if (failure === 'error') child.emit('error', new Error('mpv missing'))
      if (failure === 'exit') child.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(failure === 'timeout' ? 5000 : 50)
      await rejected; await process.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for exit, escalating with the injected clock before spawning again', async () => {
    vi.useFakeTimers()
    const child = childProcess(), transport = new MpvTransport('unused')
    child.kill = vi.fn((signal) => { if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', 0)); return true })
    vi.spyOn(transport, 'connect').mockResolvedValue(undefined)
    const spawn = vi.fn(() => child)
    const process = new MpvProcess({ platform: 'win32', spawn, transport: () => transport })
    await process.start()
    const disposed = process.dispose(), restarting = process.start()
    await vi.advanceTimersByTimeAsync(2999)
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); await disposed; await restarting
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(spawn).toHaveBeenCalledTimes(2)
    await process.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
})
