import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { chromeArgs, prepareProfile } from '../../src/main/apps/chrome'
import { ChromeAppHost } from '../../src/main/apps/ChromeAppHost'
import { MockAppHost, type MockWindow } from '../../src/main/apps/MockAppHost'
import { createMockSystem } from '../../src/main/system/mock/MockSystemServices'
import { MockSignInService } from '../../src/main/signin/MockSignInService'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { temporary } from './helpers'

afterEach(() => vi.useRealTimers())
describe('apps', () => {
  it('builds Chrome argv including optional UA, and rejects blocked apps', () => {
    const options = { profileDir: 'profiles', chromePath: 'chrome' }
    const youtube = APP_CATALOG.find((a) => a.id === 'youtube')!
    const args = chromeArgs(youtube, options)
    expect(args).toContain(`--app=${youtube.url}`); expect(args).toContain(`--user-agent=${youtube.ua}`)
    expect(args).toContain('--kiosk'); expect(args).toContain('--start-fullscreen')
    expect(args).toContain('--disable-features=Translate,MediaRouter')
    expect(args).toContain('--class=mediaos-app-youtube')
    expect(args.find((a) => a.startsWith('--user-data-dir='))).toContain('youtube')
    expect(chromeArgs(APP_CATALOG.find((a) => a.id === 'netflix')!, options).some((a) => a.startsWith('--user-agent='))).toBe(false)
    const blocked = APP_CATALOG.find((a) => a.blocked)!
    expect(() => chromeArgs(blocked, options)).toThrow(blocked.note)
  })
  it('repairs profile exit flags, preserves preferences and removes Singleton locks only', async () => {
    const temp = await temporary()
    try {
      await fs.mkdir(join(temp.dir, 'Default'))
      const file = join(temp.dir, 'Default', 'Preferences')
      await fs.writeFile(file, JSON.stringify({
        profile: { exited_cleanly: false, exit_type: 'Crashed', name: 'Guest' }, theme: 'dark',
      }), 'utf8')
      await fs.writeFile(join(temp.dir, 'SingletonLock'), 'pid', 'utf8')
      await fs.writeFile(join(temp.dir, 'keep'), 'yes', 'utf8')
      await prepareProfile(temp.dir)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
        profile: { exited_cleanly: true, exit_type: 'Normal', name: 'Guest' }, theme: 'dark',
      })
      expect(await fs.readdir(temp.dir)).not.toContain('SingletonLock')
      expect(await fs.readFile(join(temp.dir, 'keep'), 'utf8')).toBe('yes')
      await prepareProfile(join(temp.dir, 'new-profile'))
    } finally { await temp.dispose() }
  })
  it('opens one mock window at a time and emits onExit only for a user close', async () => {
    const callbacks: (() => void)[] = []
    const windows: MockWindow[] = []
    const host = new MockAppHost({ openWindow: () => {
      const window = { close: vi.fn(), onClosed: (cb: () => void) => callbacks.push(cb) }
      windows.push(window); return window
    } })
    const exit = vi.fn(); host.onExit(exit)
    await host.launch(APP_CATALOG[0]!); await host.launch(APP_CATALOG[1]!)
    expect(windows[0]?.close).toHaveBeenCalled(); expect(host.running()).toBe(APP_CATALOG[1]!.id)
    callbacks[0]!(); expect(exit).not.toHaveBeenCalled()
    callbacks[1]!(); expect(exit).toHaveBeenCalledWith(APP_CATALOG[1]!.id); expect(host.running()).toBeUndefined()
    await host.close(); await host.resetProfile('youtube')
  })
  it('runs one Chrome at a time, escalates a stuck process and safely resets profiles', async () => {
    const temp = await temporary()
    const children: ChildProcess[] = []
    const spawn = vi.fn((_file: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess
      Object.defineProperty(child, 'exitCode', { value: null, writable: true })
      child.kill = vi.fn(() => true)
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const host = new ChromeAppHost({ profileDir: temp.dir, chromePath: 'chrome', spawn })
    const exit = vi.fn(); host.onExit(exit)
    try {
      await host.launch(APP_CATALOG[0]!); expect(host.running()).toBe('youtube')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const launch = host.launch(APP_CATALOG[1]!)
      await vi.advanceTimersByTimeAsync(3000); await launch
      expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM')
      expect(children[0]?.kill).toHaveBeenCalledWith('SIGKILL'); expect(exit).not.toHaveBeenCalled()
      children[1]!.emit('exit', 0)
      expect(exit).toHaveBeenCalledWith(APP_CATALOG[1]!.id)
      expect(host.running()).toBeUndefined()
      await host.resetProfile('youtube')
      await expect(fs.stat(join(temp.dir, 'youtube'))).rejects.toThrow()
      await expect(host.resetProfile('../outside')).rejects.toThrow()
      await fs.mkdir(join(temp.dir, 'outside'))
      await fs.symlink(join(temp.dir, 'outside'), join(temp.dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      // An in-root target is safe; an outside target is refused before recursive removal.
      const external = await temporary()
      try {
        await fs.symlink(external.dir, join(temp.dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
        await expect(host.resetProfile('escape')).rejects.toThrow('inside')
        expect((await fs.stat(external.dir)).isDirectory()).toBe(true)
        await fs.rm(join(temp.dir, 'escape'))
      } finally { await external.dispose() }
      await fs.rm(join(temp.dir, 'link'))
    } finally { await host.close(); await temp.dispose() }
  })
})

describe('mock system', () => {
  it('changes network state with events and rejects wrong Wi-Fi passwords', async () => {
    const system = createMockSystem({ delayMs: 0 })
    const changed = vi.fn(), unsub = system.network.on('changed', changed)
    try {
      expect(await system.network.status()).toMatchObject({ kind: 'ethernet', connected: true })
      const aps = await system.network.scanWifi(); expect(aps).toHaveLength(5)
      const result = await system.network.connect(aps[0]!.ssid, 'wrongpass')
      expect(result).toEqual({ ok: false, error: "That Wi-Fi password didn't work. Check it and try again." })
      expect(changed).not.toHaveBeenCalled()
      expect(await system.network.connect(aps[0]!.ssid, 'correct')).toEqual({ ok: true })
      expect(await system.network.status()).toMatchObject({ kind: 'wifi', ssid: aps[0]!.ssid })
      expect(changed).toHaveBeenCalledTimes(1)
      unsub(); await system.network.forget(aps[0]!.id)
      expect((await system.network.status()).connected).toBe(false); expect(changed).toHaveBeenCalledTimes(1)
    } finally { system.dispose() }
  })
  it('pairs a discovered Bluetooth controller after 1.5 seconds and emits changes', async () => {
    vi.useFakeTimers()
    const system = createMockSystem(), changed = vi.fn()
    system.bluetooth.on('changed', changed)
    try {
      const scan = system.bluetooth.startScan(); await vi.advanceTimersByTimeAsync(350); await scan
      const controller = (await system.bluetooth.devices()).find((d) => d.kind === 'gamepad')!
      const pair = system.bluetooth.pair(controller.address)
      await vi.advanceTimersByTimeAsync(1499)
      expect((await system.bluetooth.devices()).find((d) => d.kind === 'gamepad')?.paired).toBe(false)
      await vi.advanceTimersByTimeAsync(1); await pair
      expect((await system.bluetooth.devices()).find((d) => d.kind === 'gamepad')).toMatchObject({ paired: true, connected: true })
      expect(changed).toHaveBeenCalledTimes(2)
      await system.bluetooth.stopScan(); await system.bluetooth.remove(controller.address)
      expect(await system.bluetooth.devices()).toHaveLength(1)
    } finally { system.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('supports scenarios and settings, and writes redacted diagnostics into the supplied logs folder', async () => {
    const temp = await temporary()
    const system = createMockSystem({ scenario: 'noCec', logDir: temp.dir, delayMs: 0 })
    try {
      expect(await system.cec.status()).toMatchObject({ adapter: false, message: expect.stringContaining('adapter') })
      const offline = createMockSystem({ scenario: 'offline' }), wifi = createMockSystem({ scenario: 'wifiOnly' })
      expect((await offline.network.status()).internet).toBe(false)
      expect((await wifi.network.status()).kind).toBe('none'); offline.dispose(); wifi.dispose()
      await system.audio.setOutput('headphones'); await system.audio.setVolume(72)
      expect((await system.audio.outputs()).find((s) => s.active)?.id).toBe('headphones')
      expect(await system.audio.volume()).toBe(72)
      await system.display.setMode('HDMI-A-1', '2160p30')
      expect((await system.display.outputs())[0]?.current?.width).toBe(3840)
      await system.time.setTimezone('Europe/Paris'); expect((await system.time.get()).timezone).toBe('Europe/Paris')
      expect(await system.updates.check()).toMatchObject({ current: '0.1.0' })
      await fs.writeFile(join(temp.dir, 'mediaos.log'), 'Authorization: MediaBrowser Token="private"\n?api_key=secret\n', 'utf8')
      const path = await system.info.collectDiagnostics()
      const text = await fs.readFile(path, 'utf8')
      expect(path.startsWith(temp.dir)).toBe(true); expect(text).not.toMatch(/private|secret/)
    } finally { system.dispose(); await temp.dispose() }
  })
})

describe('mock sign-in', () => {
  it('discovers, probes, signs in using Quick Connect or password, and persists fixture sources', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), hub = new MediaHub()
    const settings = await SettingsStore.open(join(temp.dir, 'settings.json'))
    const signin = new MockSignInService(hub, settings)
    const changed = vi.fn(); hub.onChanged(changed)
    try {
      const discover = signin.discover(); await vi.advanceTimersByTimeAsync(800)
      expect((await discover)[0]?.name).toBe('Living Room Jellyfin')
      expect(await signin.probe('https://server.test/')).toMatchObject({ version: '10.11.0', quickConnect: true })
      await expect(signin.probe('http://offline.invalid')).rejects.toThrow("Can't reach that server")
      const start = await signin.quickConnect('http://server.test')
      expect(start.code).toMatch(/^\d{6}$/)
      expect(await signin.poll(start.flowId)).toEqual({ state: 'waiting' })
      expect(await signin.poll(start.flowId)).toEqual({ state: 'waiting' })
      expect(await signin.poll(start.flowId)).toMatchObject({ state: 'done' })
      expect(await signin.poll(start.flowId)).toMatchObject({ state: 'done' })
      expect(hub.list()).toHaveLength(1); expect(settings.get().sources).toHaveLength(1)
      expect(changed).toHaveBeenCalledTimes(1)
      await expect(signin.password('http://test', 'guest', 'bad')).rejects.toThrow("That user name or password didn't work.")
      await signin.password('http://test', 'guest', 'demo'); expect(hub.list()).toHaveLength(2)
      const cancel = await signin.quickConnect('http://test'); await signin.cancel(cancel.flowId)
      expect(await signin.poll(cancel.flowId)).toEqual({ state: 'expired' })
      await vi.advanceTimersByTimeAsync(600_000)
      expect(await signin.poll(start.flowId)).toEqual({ state: 'expired' })
    } finally { signin.dispose(); hub.dispose(); await settings.flush(); await temp.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('offers Plex server choices after two waits, validates choices and adds each selected server once', async () => {
    const temp = await temporary(), hub = new MediaHub()
    const settings = await SettingsStore.open(join(temp.dir, 'settings.json'))
    const signin = new MockSignInService(hub, settings, { delayMs: 0 })
    try {
      const start = await signin.plexPin()
      expect(start).toMatchObject({ where: 'plex.tv/link', qrUrl: 'https://plex.tv/link' })
      expect(start.code).toHaveLength(4)
      await signin.poll(start.flowId); await signin.poll(start.flowId)
      const choices = await signin.poll(start.flowId)
      expect(choices.state).toBe('chooseServers')
      if (choices.state !== 'chooseServers') throw new Error('Missing choices')
      expect(choices.servers[1]?.reach).toContain('Plex Pass')
      await expect(signin.plexAddServers(start.flowId, ['bad'])).rejects.toThrow('Choose a server')
      const infos = await signin.plexAddServers(start.flowId, choices.servers.map((s) => s.id))
      expect(infos.map((s) => s.name)).toEqual(['Home Plex', "Dad's Plex"])
      await signin.plexAddServers(start.flowId, ['home-plex'])
      expect(hub.list()).toHaveLength(2); expect(settings.get().sources).toHaveLength(2)
    } finally { signin.dispose(); hub.dispose(); await settings.flush(); await temp.dispose() }
  })
})
