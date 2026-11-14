import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChromeAppHost } from '../../src/main/apps/ChromeAppHost'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { profilePath } from '../../src/main/apps/chrome'
import type { AppExitReason, AppHost } from '../../src/main/apps/types'
import type { ProcessTable } from '../../src/main/apps/orphans'
import { runtime } from '../../src/main/core/runtime'
import { composeCore } from '../../src/main/core/compose'
import { Core } from '../../src/main/core/Core'
import { silentLog } from '../../src/main/log/Logger'
import { MpvProcess } from '../../src/main/player/mpv/MpvProcess'
import { MpvTransport } from '../../src/main/player/mpv/MpvTransport'
import { FakeMpv } from '../fixtures/fake-mpv'
import { deferred, temporary, until } from './helpers'

afterEach(() => vi.useRealTimers())
const app = APP_CATALOG.find((entry) => entry.id === 'youtube')!
const other = APP_CATALOG.find((entry) => entry.id === 'netflix')!

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.defineProperty(child, 'exitCode', { value: null, writable: true })
  child.kill = vi.fn(() => {
    Object.defineProperty(child, 'exitCode', { value: 0, writable: true })
    child.emit('exit', 0, null); return true
  })
  return child
}

async function fixture(withProcesses = true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const temp = await temporary()
  let now = 10_000
  const events: string[] = [], children: ChildProcess[] = []
  const live = new Map<number, string>()
  const processes: ProcessTable = {
    list: vi.fn(async () => [...live].map(([pid, id]) => ({ pid,
      args: ['chrome', `--user-data-dir=${profilePath(temp.dir, id)}`] }))),
    signal: vi.fn((pid, signal) => {
      if (signal === 0) return live.has(pid)
      events.push(`${pid}:${signal}`); return live.delete(pid)
    }),
  }
  const spawn = vi.fn(() => {
    events.push('spawn')
    const child = fakeChild(); children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  const error = vi.fn()
  const host = new ChromeAppHost({ profileDir: temp.dir, chromePath: 'chrome', spawn,
    clock: { ...runtime, now: () => now }, logger: { ...silentLog, error },
    processes: withProcesses ? processes : undefined })
  const exit = vi.fn(); host.onExit(exit)
  return { host, children, live, processes, events, spawn, error, exit, dir: temp.dir,
    advance(ms: number) { now += ms },
    async dispose() { await host.close(); await temp.dispose() } }
}

describe('Chrome profile guard', () => {
  it('stops only the target profile before removing its lock and spawning', async () => {
    const f = await fixture()
    try {
      f.live.set(101, app.id); f.live.set(102, other.id)
      const lock = join(f.dir, app.id, 'SingletonLock')
      await fs.mkdir(join(f.dir, app.id)); await fs.writeFile(lock, 'old browser', 'utf8')
      const launch = f.host.launch(app, { kind: 'direct' })
      await until(() => f.events.includes('101:SIGTERM'))
      expect(await fs.readFile(lock, 'utf8')).toBe('old browser')
      expect(f.spawn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100); await launch
      expect(f.events).toEqual(['101:SIGTERM', 'spawn'])
      expect(f.live.has(102)).toBe(true)
      await expect(fs.stat(lock)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { await f.dispose() }
  })

  it('launches normally without a process table', async () => {
    const f = await fixture(false)
    try {
      await f.host.launch(app, { kind: 'direct' })
      expect(f.host.running()).toBe(app.id)
      expect(f.spawn).toHaveBeenCalledOnce()
      expect(f.processes.list).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('stops a hand-over browser and logs an error before notifying listeners at 1,500 ms', async () => {
    const f = await fixture()
    try {
      await f.host.launch(app, { kind: 'direct' }); f.live.set(201, app.id); f.live.set(202, other.id)
      f.advance(1500); f.children[0]!.emit('exit', 0, null)
      expect(f.exit).not.toHaveBeenCalled()
      await until(() => f.events.includes('201:SIGTERM'))
      expect(f.exit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(app.id, 'handover')
      expect(f.error.mock.calls).toEqual([['Chrome handed the window to another browser; closing it']])
      expect(f.live.has(201)).toBe(false); expect(f.live.has(202)).toBe(true)
      expect(f.host.running()).toBeUndefined()
    } finally { await f.dispose() }
  })

  it.each([
    { ms: 2500, code: 0, signal: null },
    { ms: 500, code: 1, signal: null },
    { ms: 500, code: null, signal: 'SIGTERM' },
  ] as const)('reports a normal exit for $code / $signal at $ms ms', async ({ ms, code, signal }) => {
    const f = await fixture()
    try {
      await f.host.launch(app, { kind: 'direct' }); f.live.set(301, app.id)
      const checks = vi.mocked(f.processes.list).mock.calls.length
      f.advance(ms); f.children[0]!.emit('exit', code, signal)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(app.id, 'exited')
      expect(f.processes.list).toHaveBeenCalledTimes(checks)
      expect(f.live.has(301)).toBe(true); expect(f.error).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('does not treat its own quick close of a replaced app (Chrome exits 0 on SIGTERM) as a hand-over', async () => {
    const f = await fixture()
    try {
      await f.host.launch(app, { kind: 'direct' })
      // The fake kill() exits with code 0 at once, as real Chrome does on SIGTERM, well inside the 2 s window.
      await f.host.launch(other, { kind: 'direct' })
      expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
      const checks = vi.mocked(f.processes.list).mock.calls.length
      await f.host.closeLeftovers()
      expect(f.exit).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled()
      expect(f.processes.list).toHaveBeenCalledTimes(checks + 1)
      expect(f.host.running()).toBe(other.id)
    } finally { await f.dispose() }
  })

  it('rechecks the current app when a hand-over cleanup reaches the serial queue', async () => {
    const f = await fixture()
    const checked = deferred<void>(), release = deferred<void>()
    try {
      await f.host.launch(app, { kind: 'direct' })
      vi.mocked(f.processes.list).mockImplementationOnce(async () => { checked.resolve(); await release.promise; return [] })
      const leftovers = f.host.closeLeftovers()
      await checked.promise
      const launch = f.host.launch(other, { kind: 'direct' })
      f.children[0]!.emit('exit', 0, null)
      release.resolve(); await leftovers; await launch; await f.host.closeLeftovers()
      expect(f.exit).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled()
      expect(f.host.running()).toBe(other.id)
    } finally { release.resolve(); await f.dispose() }
  })

  it('uses the spawn event time rather than the launch request time', async () => {
    const f = await fixture(false)
    try {
      f.spawn.mockImplementationOnce(() => {
        const child = fakeChild(); f.children.push(child)
        queueMicrotask(() => { f.advance(5000); child.emit('spawn') })
        return child
      })
      await f.host.launch(app, { kind: 'direct' }); f.advance(1500); f.children[0]!.emit('exit', 0, null)
      await until(() => f.exit.mock.calls.length > 0)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(app.id, 'handover')
    } finally { await f.dispose() }
  })

  it('preserves spawn errors as ordinary exits and rejects launch', async () => {
    const f = await fixture(false)
    try {
      const error = new Error('Chrome could not start')
      f.spawn.mockImplementationOnce(() => {
        const child = fakeChild()
        queueMicrotask(() => child.emit('error', error))
        return child
      })
      await expect(f.host.launch(app, { kind: 'direct' })).rejects.toBe(error)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(app.id, 'exited')
      expect(f.error).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
})

describe('Core app exit messages', () => {
  it.each([
    [app.id, 'handover', "YouTube didn't open properly. Try again."],
    ['missing-app', 'handover', "The app didn't open properly. Try again."],
    [app.id, 'exited', undefined],
  ] satisfies [string, AppExitReason, string | undefined][])('handles %s exiting with %s', async (id, reason, text) => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir,
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    composed.core.dispose()
    let notify!: Parameters<AppHost['onExit']>[0]
    vi.spyOn(composed.core.apps, 'onExit').mockImplementation((cb) => { notify = cb; return () => undefined })
    const core = new Core({ ...composed.core, restartShell() {}, clearCaches: async () => undefined })
    try {
      const toast = vi.fn(); core.on('toast', toast)
      core.setForeground({ kind: 'app', appId: id }); notify(id, reason)
      expect(core.getForeground()).toEqual({ kind: 'shell' })
      if (text) expect(toast).toHaveBeenCalledExactlyOnceWith({ id: expect.any(String), text, tone: 'error' })
      else expect(toast).not.toHaveBeenCalled()
    } finally { core.dispose(); await composed.dispose(); await temp.dispose() }
  })
})

it('disables mpv web extraction in the fixed arguments before extra arguments', async () => {
  const server = new FakeMpv(); await server.start()
  const child = fakeChild(), spawn = vi.fn((_file: string, _args: string[]) => child)
  // The keyboard is put back (after phone typing) before mpv opens its window.
  const beforeStart = vi.fn(async () => { expect(spawn).not.toHaveBeenCalled() })
  const process = new MpvProcess({ platform: 'win32', spawn, extraArgs: ['--hwdec=no'], beforeStart,
    transport: () => new MpvTransport(server.path) })
  try {
    await process.start()
    expect(beforeStart).toHaveBeenCalledOnce()
    const args = spawn.mock.calls[0]![1]
    expect(args).toContain('--ytdl=no')
    expect(args.indexOf('--ytdl=no')).toBeLessThan(args.indexOf('--hwdec=no'))
  } finally { await process.dispose(); await server.dispose() }
})
