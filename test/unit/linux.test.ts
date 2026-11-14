import { afterEach, describe, expect, it, vi } from 'vitest'
import * as net from 'node:net'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { EventPayloads } from '@shared/ipc-contract'
import { ControlCommands, ControlServer, parseControl, type ControlCommand } from '../../src/main/core/ControlSocket'
import { composeCore, linuxMpvArgs } from '../../src/main/core/compose'
import { mpvKey, MpvController } from '../../src/main/player/MpvController'
import { MpvTransport } from '../../src/main/player/mpv/MpvTransport'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { chromeArgs, LINUX_CHROME_ARGS } from '../../src/main/apps/chrome'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { focusProcess } from '../../src/main/system/linux/sway'
import { readLaunchOptions } from '../../src/main/launch-options'
import { findProfileBrowsers, parseCmdline, stopProfileBrowsers, type ProcessTable } from '../../src/main/apps/orphans'
import { ChromeAppHost } from '../../src/main/apps/ChromeAppHost'
import { FakeMpv } from '../fixtures/fake-mpv'
import { temporary, until } from './helpers'

afterEach(() => { vi.useRealTimers() })

function socketPath(dir: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\mediaos-test-${randomUUID()}` : join(dir, 'run', 'ctl.sock')
}

function send(path: string, text: string, close = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path)
    let reply = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { reply += chunk })
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
    socket.write(text)
    if (close) socket.end()
  })
}

type FakeTable = ProcessTable & { signals: [number, string | number][]; procs: { pid: number; args: string[] }[] }
/** A process list where SIGTERM ends a process unless it is in `stubborn`. */
function fakeTable(procs: { pid: number; args: string[] }[], stubborn: number[] = []): FakeTable {
  const table: FakeTable = {
    procs: [...procs],
    signals: [],
    list: async () => table.procs.map((p) => ({ ...p, args: [...p.args] })),
    signal(pid, signal) {
      const alive = table.procs.some((p) => p.pid === pid)
      if (signal !== 0) table.signals.push([pid, signal])
      if (alive && (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn.includes(pid)))) {
        table.procs = table.procs.filter((p) => p.pid !== pid)
      }
      return alive
    },
  }
  return table
}

describe('control commands', () => {
  it('parses only the known verbs and actions', () => {
    expect(parseControl('home-down\n')).toEqual({ kind: 'home-down' })
    expect(parseControl(' home-up ')).toEqual({ kind: 'home-up' })
    expect(parseControl('recover')).toEqual({ kind: 'recover' })
    expect(parseControl('home')).toEqual({ kind: 'press', action: 'home' })
    expect(parseControl('press select')).toEqual({ kind: 'press', action: 'select' })
    for (const bad of ['', 'press', 'press launch', 'press select now', 'rm -rf', 'HOME']) expect(parseControl(bad)).toBeUndefined()
  })
  it('times Home like the remote: a tap is Home, a hold is Recovery, recover is immediate', async () => {
    vi.useFakeTimers()
    const routed: [string, boolean][] = []
    const commands = new ControlCommands(async (action, long) => { routed.push([action, long]) })
    commands.handle({ kind: 'home-down' }); commands.handle({ kind: 'home-up' })
    commands.handle({ kind: 'home-down' }); await vi.advanceTimersByTimeAsync(1500); commands.handle({ kind: 'home-up' })
    commands.handle({ kind: 'home-down' }); commands.handle({ kind: 'recover' }); await vi.advanceTimersByTimeAsync(2000)
    commands.handle({ kind: 'press', action: 'down' })
    expect(routed).toEqual([['home', false], ['recovery', true], ['recovery', false], ['down', false]])
  })
  it('treats a release that overtakes its press as a tap, but forgets a stray release', async () => {
    vi.useFakeTimers()
    const routed: [string, boolean][] = []
    const commands = new ControlCommands(async (action, long) => { routed.push([action, long]) })
    commands.handle({ kind: 'home-up' }); commands.handle({ kind: 'home-down' }); await vi.advanceTimersByTimeAsync(2000)
    commands.handle({ kind: 'home-up' }); await vi.advanceTimersByTimeAsync(400)
    commands.handle({ kind: 'home-down' }); await vi.advanceTimersByTimeAsync(1500); commands.handle({ kind: 'home-up' })
    expect(routed).toEqual([['home', false], ['recovery', true]])
  })
  it('answers each line with ok or error and ignores oversized input', async () => {
    const temp = await temporary()
    const got: ControlCommand[] = []
    const server = new ControlServer({ path: socketPath(temp.dir), onCommand: (c) => got.push(c) })
    try {
      await server.listen()
      const path = (server as unknown as { opts: { path: string } }).opts.path
      expect(await send(path, 'home-down\n')).toBe('ok\n')
      // A line with no newline, then the client closes its side (what socat does). Windows pipes can't half-close, so the
      // reply is only checked on Unix sockets.
      const reply = await send(path, 'press back', true)
      if (process.platform !== 'win32') expect(reply).toBe('ok\n')
      expect(await send(path, 'nonsense\n')).toBe('error\n')
      expect(await send(path, `${'x'.repeat(300)}\n`)).toBe('error\n')
      expect(got).toEqual([{ kind: 'home-down' }, { kind: 'press', action: 'back' }])
    } finally { await server.close(); await temp.dispose() }
  })
  it('answers error when the command itself fails', async () => {
    const temp = await temporary()
    const server = new ControlServer({ path: socketPath(temp.dir), onCommand: () => { throw new Error('boom') } })
    try {
      await server.listen()
      const path = (server as unknown as { opts: { path: string } }).opts.path
      expect(await send(path, 'home-down\n')).toBe('error\n')
    } finally { await server.close(); await temp.dispose() }
  })
})

describe('Linux shell wiring', () => {
  it('routes the control socket through core: Home reaches the shell page, recover opens Recovery', async () => {
    const temp = await temporary()
    const path = socketPath(temp.dir)
    const focus = vi.fn()
    // A YouTube window left over from a shell that crashed, plus things that must be left alone.
    const table = fakeTable([
      { pid: 41, args: ['/opt/google/chrome/chrome', '--app=https://www.youtube.com/tv',
        `--user-data-dir=${join(temp.dir, 'chrome', 'youtube')}`] },
      { pid: 42, args: ['/opt/google/chrome/chrome', '--user-data-dir=/home/someone/.config/google-chrome'] },
    ])
    const composed = await composeCore({ platform: 'linux', dataDir: temp.dir, logDir: join(temp.dir, 'logs'), restartShell() {},
      forceMockPlayer: true, fixtureLatencyMs: 0, controlSocket: path, chromePath: 'chrome-not-installed', focusShell: focus,
      processes: table })
    const events: { name: string; value: unknown }[] = []
    composed.core.on('action', (v: EventPayloads['action']) => events.push({ name: 'action', value: v }))
    composed.core.on('recovery', (v) => events.push({ name: 'recovery', value: v }))
    try {
      expect(await send(path, 'home\n')).toBe('ok\n')
      expect(await send(path, 'recover\n')).toBe('ok\n')
      await until(() => events.length === 2)
      expect(events).toEqual([{ name: 'action', value: { action: 'home' } }, { name: 'recovery', value: {} }])
      // Home and Recovery give the keyboard back to the shell even though core already had the shell in front.
      expect(focus).toHaveBeenCalledTimes(2)
      composed.core.setForeground({ kind: 'player' }); composed.core.setForeground({ kind: 'shell' })
      expect(focus).toHaveBeenCalledTimes(3)
      await until(() => table.signals.length > 0)
      expect(table.signals).toEqual([[41, 'SIGTERM']])
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('adds the Linux flags for Chrome and mpv', () => {
    const youtube = APP_CATALOG.find((a) => a.id === 'youtube')!
    const args = chromeArgs(youtube, { profileDir: 'profiles', chromePath: 'chrome', extraArgs: LINUX_CHROME_ARGS }, { kind: 'direct' })
    expect(args).toEqual(expect.arrayContaining(['--ozone-platform=wayland', '--password-store=basic', '--kiosk']))
    expect(linuxMpvArgs(false)).toEqual(['--input-vo-keyboard=yes', '--input-conf=/etc/mediaos/mpv/input.conf'])
    expect(linuxMpvArgs(true)).toContain('--hwdec=no')
  })
  it('turns on spatial navigation for ordinary websites only, so arrows move between links instead of scrolling', () => {
    const route = { kind: 'direct' } as const, opts = { profileDir: 'profiles', chromePath: 'chrome', extraArgs: LINUX_CHROME_ARGS }
    const flagged = (id: string) => chromeArgs(APP_CATALOG.find((a) => a.id === id)!, opts, route).includes('--enable-spatial-navigation')
    expect(flagged('iplayer')).toBe(true)
    expect(flagged('netflix')).toBe(true)
    expect(flagged('youtube')).toBe(false)
    expect(LINUX_CHROME_ARGS).not.toContain('--enable-spatial-navigation')
    for (const app of APP_CATALOG.filter((a) => !a.blocked)) expect(flagged(app.id)).toBe(app.nav === 'pointer')
  })
  it('waits for the keyboard to be put back before starting Chrome', async () => {
    const temp = await temporary(), order: string[] = []
    const spawn = (_file: string, _args: string[]) => {
      order.push('spawn')
      const child = new EventEmitter() as ChildProcess
      Object.defineProperty(child, 'exitCode', { value: null, writable: true })
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    const host = new ChromeAppHost({ profileDir: temp.dir, chromePath: 'chrome', spawn, processes: fakeTable([]),
      beforeLaunch: async () => { await Promise.resolve(); order.push('settle') } })
    try {
      await host.launch(APP_CATALOG.find((a) => a.id === 'iplayer')!, { kind: 'direct' })
      expect(order).toEqual(['settle', 'spawn'])
    } finally { await host.close(); await temp.dispose() }
  })
  it('reads the Linux launch options', () => {
    const opts = readLaunchOptions({ MEDIAOS_PLATFORM: 'linux', XDG_RUNTIME_DIR: '/run/user/1000/', MEDIAOS_SOFTWARE_VIDEO: '1' }, [])
    expect(opts).toMatchObject({ platform: 'linux', controlSocket: '/run/user/1000/mediaos/ctl.sock', softwareVideo: true })
    expect(readLaunchOptions({ XDG_RUNTIME_DIR: 'relative' }, []).controlSocket).toBeUndefined()
    expect(readLaunchOptions({ MEDIAOS_CONTROL_SOCKET: '/tmp/x.sock' }, []).controlSocket).toBe('/tmp/x.sock')
  })
  it('asks sway to focus the shell by process id, and only for a real id', async () => {
    const exec = vi.fn(async () => undefined)
    await focusProcess(1234, undefined, exec); await focusProcess(0, undefined, exec)
    expect(exec.mock.calls).toEqual([['swaymsg', ['[pid=1234]', 'focus']]])
    const warn = vi.fn()
    await focusProcess(5, { debug() {}, info() {}, warn, error() {} }, async () => { throw new Error('no sway') })
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('mpv remote keys', () => {
  it('accepts only whitelisted mediaos-key messages', () => {
    expect(mpvKey({ event: 'client-message', args: ['mediaos-key', 'back'] })).toBe('back')
    expect(mpvKey({ event: 'client-message', args: ['mediaos-key', 'power'] })).toBeUndefined()
    expect(mpvKey({ event: 'client-message', args: ['other', 'back'] })).toBeUndefined()
    expect(mpvKey({ event: 'client-message', args: ['mediaos-key', 'back', 'extra'] })).toBeUndefined()
    expect(mpvKey({ event: 'end-file', args: ['mediaos-key', 'back'] })).toBeUndefined()
  })
  it('passes keys on only while something is playing', async () => {
    const server = new FakeMpv(); await server.start()
    const onKey = vi.fn()
    const player = new MpvController({ transport: new MpvTransport(server.path), onKey })
    const source = new FixtureSource()
    try {
      const item = (await source.rows()).latest.find((i) => i.type === 'movie')!
      await player.play(await source.playback(item.id, { resume: false }), source)
      await until(() => player.state().status === 'playing')
      server.send({ event: 'client-message', args: ['mediaos-key', 'playPause'] })
      await until(() => onKey.mock.calls.length === 1)
      expect(onKey).toHaveBeenCalledWith('playPause')
      await player.stop()
    } finally { await player.dispose(); await server.dispose() }
  })
})

describe('app windows left over from a crashed shell', () => {
  const root = resolve('/data/chrome')
  const browser = (pid: number, dir: string, ...extra: string[]) => ({ pid, args: ['/opt/google/chrome/chrome', ...extra,
    `--user-data-dir=${dir}`] })
  it('finds only Chrome browser processes using a MediaOS profile', async () => {
    const table = fakeTable([
      browser(10, join(root, 'youtube')),
      browser(11, join(root, 'netflix'), '--app=https://www.netflix.com'),
      browser(12, join(root, 'youtube'), '--type=renderer'),
      browser(13, root),
      browser(14, `${root}-evil`),
      browser(15, join(root, '..', 'elsewhere')),
      { pid: 16, args: ['/usr/bin/bash'] },
      browser(process.pid, join(root, 'youtube')),
    ])
    expect(await findProfileBrowsers(table, root)).toEqual([10, 11])
    expect(await findProfileBrowsers(table, root, join(root, 'netflix'))).toEqual([11])
  })
  it('reads command lines whether NUL-separated or rewritten by Chrome into one spaced title', () => {
    expect(parseCmdline('/usr/bin/mpv\0--idle\0a b.mkv\0')).toEqual(['/usr/bin/mpv', '--idle', 'a b.mkv'])
    // What /proc/<pid>/cmdline holds for Chrome 157's browser process on the VM (one field, spaces between flags).
    expect(parseCmdline('/opt/google/chrome/chrome --app=https://example.com --user-data-dir=/home/m/chrome/youtube\0'))
      .toEqual(['/opt/google/chrome/chrome', '--app=https://example.com', '--user-data-dir=/home/m/chrome/youtube'])
    expect(parseCmdline('/opt/google/chrome/chrome --type=renderer --user-data-dir=/x')).toContain('--type=renderer')
  })
  it('asks them to quit, then forces any that are still running', async () => {
    vi.useFakeTimers()
    const table = fakeTable([browser(10, join(root, 'youtube')), browser(11, join(root, 'netflix'))], [11])
    const warn = vi.fn()
    const stopped = stopProfileBrowsers({ table, profileDir: root, logger: { debug() {}, info() {}, warn, error() {} },
      clock: { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval } })
    await vi.advanceTimersByTimeAsync(3100)
    expect(await stopped).toBe(2)
    expect(table.signals).toEqual([[10, 'SIGTERM'], [11, 'SIGTERM'], [11, 'SIGKILL']])
    expect(warn).toHaveBeenCalledOnce()
    expect(await stopProfileBrowsers({ table, profileDir: root })).toBe(0)
  })
  it('does not force a process whose id now belongs to something else', async () => {
    vi.useFakeTimers()
    const table = fakeTable([browser(12, join(root, 'youtube'))], [12])
    const stopped = stopProfileBrowsers({ table, profileDir: root,
      clock: { now: () => Date.now(), setTimeout, clearTimeout, setInterval, clearInterval } })
    await vi.advanceTimersByTimeAsync(1000)
    table.procs = [{ pid: 12, args: ['/usr/bin/mpv', '--idle'] }]
    await vi.advanceTimersByTimeAsync(2100)
    expect(await stopped).toBe(1)
    expect(table.signals).toEqual([[12, 'SIGTERM']])
  })
  it('closes leftovers on request and after closing its own app, without touching other profiles', async () => {
    const temp = await temporary()
    const children: ChildProcess[] = []
    const spawn = (_file: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess
      Object.defineProperty(child, 'exitCode', { value: null, writable: true })
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    const table = fakeTable([browser(20, join(temp.dir, 'youtube')), browser(21, join(temp.dir, 'netflix'))])
    const host = new ChromeAppHost({ profileDir: temp.dir, chromePath: 'chrome', spawn, processes: table })
    try {
      await host.launch(APP_CATALOG.find((a) => a.id === 'youtube')!, { kind: 'direct' })
      // Chrome handed the window to another browser process for the same profile; closing the app closes that too.
      await host.close()
      expect(children).toHaveLength(1)
      expect(table.signals).toEqual([[20, 'SIGTERM']])
      await host.closeLeftovers()
      expect(table.signals).toEqual([[20, 'SIGTERM'], [21, 'SIGTERM']])
    } finally { await host.close(); await temp.dispose() }
  })
})
