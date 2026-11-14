import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { VpnController, type VpnProxyHost } from '../../src/main/vpn/VpnController'
import type { VpnBackend, VpnDeviceStatus } from '../../src/main/vpn/VpnBackend'
import type { WgConfig } from '../../src/main/vpn/wg-config'
import type { VpnStatus } from '../../src/shared/vpn-types'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { runtime } from '../../src/main/core/runtime'
import { deferred } from './helpers'

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const u1 = uuid(1), u2 = uuid(2), imported = uuid(9)
const location = (n = 1) => ({ id: `loc-0000000${n}`, label: n === 1 ? 'UK' : 'France', nmUuid: uuid(n),
  dns: '10.64.0.1', addedAt: '2026-11-14T00:00:00.000Z' })
const key = randomBytes(32).toString('base64')
const conf = (extra = '') => Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\nDNS = 10.64.0.1\n` +
  `${extra}\n[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`)

function zip(names: string[], contents = names.map(() => conf())): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = []
  let offset = 0
  for (const [index, name] of names.entries()) {
    const data = contents[index]!, filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

async function make(saved = true) {
  const settings = await SettingsStore.open('vpn-test-unused.json', { clock: runtime,
    fs: { ...fs, readFile: vi.fn().mockRejectedValue(Object.assign(new Error('Missing'), { code: 'ENOENT' })) } })
  const flush = vi.spyOn(settings, 'flush').mockResolvedValue()
  if (saved) settings.update({ vpn: { locations: [location()], activeLocationId: location().id } })
  const order: string[] = [], events: VpnStatus[] = []
  let device: VpnDeviceStatus = { state: 'up', tunIp: '10.64.0.2' }, port: number | null = 1080
  let running: string | undefined
  const portListeners = new Set<(port: number | null) => void>()
  const proxy: VpnProxyHost = {
    start: vi.fn(async () => { order.push('proxy start') }), stop: vi.fn(async () => { order.push('proxy stop'); port = null }),
    port: () => port, onPort: (cb) => { portListeners.add(cb); return () => { portListeners.delete(cb) } },
    setTunnel: vi.fn(),
  }
  const backend = {
    importProfile: vi.fn(async (_config: WgConfig, _label: string) => imported),
    listProfiles: vi.fn<VpnBackend['listProfiles']>(async () =>
      settings.get().vpn.locations.map((l) => ({ uuid: l.nmUuid, name: l.label, type: 'wireguard' }))),
    address: vi.fn(async (_uuid: string) => '10.64.0.2'),
    setAutoconnect: vi.fn(async (uuid: string, on: boolean) => { order.push(`auto ${uuid} ${on}`) }),
    up: vi.fn(async (uuid: string, _ip: string) => { order.push(`up ${uuid}`) }),
    down: vi.fn(async (uuid: string) => { order.push(`down ${uuid}`) }),
    remove: vi.fn(async (uuid: string) => { order.push(`remove ${uuid}`) }),
    status: vi.fn(async () => device), routingOk: vi.fn(async (_ip: string) => true),
    probe: vi.fn(async (_ip: string, _dns: string | null, _ms: number) => true),
  } satisfies VpnBackend
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const close = vi.fn(async () => { order.push('close'); running = undefined })
  const dropped = vi.fn(), toast = vi.fn()
  let id = 2
  const networkBusy = vi.fn(async () => false), randomInt = vi.fn((_max: number) => 1)
  const opts = { backend, settings, proxy, clock: runtime, logger, closeApp: close, runningApp: () => running, networkBusy, randomInt,
    appIds: () => ['iplayer', 'youtube', 'locked'], appName: (app: string) => app === 'locked' ? 'Locked' : app,
    isLockedDirect: (app: string): boolean => app === 'locked', emitStatus: (status: VpnStatus) => events.push(status),
    emitDropped: dropped, toast, id: () => String(id++).padStart(8, '0') }
  const controller = new VpnController(opts)
  return { controller, opts, settings, backend, proxy, close, dropped, toast, order, events, logger, flush, networkBusy, randomInt,
    device: (value: VpnDeviceStatus) => { device = value }, running: (app: string) => { running = app },
    port: (value: number | null) => { port = value; for (const cb of portListeners) cb(value) }, portListeners }
}
let active: Awaited<ReturnType<typeof make>>[] = []
async function setup(saved = true) { const f = await make(saved); active.push(f); return f }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z')) })
afterEach(() => { for (const f of active) f.controller.dispose(); active = []; vi.clearAllTimers(); vi.useRealTimers() })

describe('VPN controller routing and health', () => {
  it.each(['off', 'choice', 'port', 'locked'] as const)('rejects a VPN launch whose route changed: %s', async (change) => {
    const f = await setup(); await f.controller.setEnabled(true); await f.controller.setAppVpn('iplayer', 'vpn-only')
    const route = { kind: 'vpn', port: 1080, label: 'UK' } as const
    if (change === 'off') await f.controller.setEnabled(false)
    else if (change === 'choice') await f.controller.setAppVpn('iplayer', 'direct')
    else if (change === 'port') f.port(1081)
    else f.opts.isLockedDirect = () => true
    expect(await f.controller.confirmLaunch('iplayer', route)).toBe(false)
    expect(f.close).toHaveBeenCalledOnce(); expect(f.controller.status().appOnVpn).toBeNull()
    expect(f.dropped).not.toHaveBeenCalled()
  })
  it('confirms direct fallback only while that choice still allows it', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-or-direct' } } })
    expect(await f.controller.confirmLaunch('iplayer', { kind: 'direct' }, true)).toBe(true)
    expect(await f.controller.confirmLaunch('iplayer', { kind: 'direct' })).toBe(false)
    await f.controller.setAppVpn('iplayer', 'vpn-only')
    expect(await f.controller.confirmLaunch('iplayer', { kind: 'direct' }, true)).toBe(false)
  })
  it('does not publish a successful old-address probe after a newer status read', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    const held = deferred<boolean>(); f.backend.probe.mockReturnValueOnce(held.promise)
    const check = f.controller.check(); await vi.advanceTimersByTimeAsync(0)
    f.proxy.setTunnel = vi.fn(); f.device({ state: 'up', tunIp: '10.64.0.3' })
    f.backend.routingOk.mockResolvedValue(false)
    f.controller.notifyNetworkChanged(); await vi.advanceTimersByTimeAsync(0)
    held.resolve(true); expect((await check).state).toBe('down')
    expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
  })
  it('does not publish a held probe after an unknown status read', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    const held = deferred<boolean>(); f.backend.probe.mockReturnValueOnce(held.promise)
    const check = f.controller.check(); await vi.advanceTimersByTimeAsync(0)
    f.proxy.setTunnel = vi.fn(); f.backend.status.mockResolvedValueOnce({ state: 'unknown', tunIp: null })
    f.controller.notifyNetworkChanged(); await vi.advanceTimersByTimeAsync(0)
    held.resolve(true); expect((await check).state).toBe('connected')
    expect(f.proxy.setTunnel).not.toHaveBeenCalled()
  })
  it.each(['off', 'direct', 'locked'] as const)('re-reads routing settings after a held probe: %s', async (change) => {
    const f = await setup(), probe = deferred<boolean>()
    const app = change === 'locked' ? 'locked' : 'iplayer'
    f.opts.isLockedDirect = () => false
    f.settings.update({ vpn: { enabled: true, apps: { [app]: 'vpn-only' } } })
    f.backend.probe.mockReturnValueOnce(probe.promise)
    const route = f.controller.routeFor(app); await vi.advanceTimersByTimeAsync(0)
    if (change === 'off') await f.controller.setEnabled(false)
    else if (change === 'direct') await f.controller.setAppVpn(app, 'direct')
    else f.opts.isLockedDirect = () => true
    probe.resolve(true); expect(await route).toEqual({ kind: 'direct' })
  })
  it('never publishes a changed tunnel address whose routing check fails', async () => {
    const f = await setup(); await f.controller.setEnabled(true); await f.controller.setAppVpn('iplayer', 'vpn-only')
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' })
    f.proxy.setTunnel = vi.fn(); f.backend.routingOk.mockResolvedValue(false)
    f.device({ state: 'up', tunIp: '10.64.0.3' }); f.controller.notifyNetworkChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.status().state).toBe('down'); expect(f.dropped).toHaveBeenCalledExactlyOnceWith('iplayer')
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(f.proxy.setTunnel).not.toHaveBeenCalledWith('10.64.0.3', expect.anything())
    expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
  })
  it.each(['throw', 'timeout'] as const)('keeps a connected tunnel until three unknown status reads: %s', async (mode) => {
    const f = await setup(); await f.controller.setEnabled(true); f.proxy.setTunnel = vi.fn()
    f.backend.status.mockImplementation(() => mode === 'throw' ? Promise.reject(new Error('slow')) :
      deferred<VpnDeviceStatus>().promise)
    for (let miss = 1; miss <= 3; ++miss) {
      f.controller.notifyNetworkChanged(); await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 3000 : 0)
      expect(f.controller.status().state).toBe(miss === 3 ? 'down' : 'connected')
      if (miss < 3) expect(f.proxy.setTunnel).not.toHaveBeenCalled()
    }
    expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
  })
  it('fails an unknown launch read without changing the current state', async () => {
    const f = await setup(); await f.controller.setEnabled(true); f.port(null)
    await f.controller.setAppVpn('iplayer', 'vpn-only')
    f.backend.status.mockRejectedValue(new Error('slow'))
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(f.controller.status().state).toBe('connected')
  })
  it('keeps a connecting device connecting long enough to show slow', async () => {
    const f = await setup(), pending = deferred<void>(); f.device({ state: 'connecting', tunIp: null })
    f.backend.up.mockReturnValueOnce(pending.promise)
    const enable = f.controller.setEnabled(true); await vi.advanceTimersByTimeAsync(15000)
    expect(f.controller.status()).toMatchObject({ state: 'connecting', slow: true })
    pending.resolve(); await enable
  })
  it('enabling an already connected VPN does nothing', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' }); f.order.length = 0
    expect(await f.controller.setEnabled(true)).toEqual({ ok: true }); expect(f.order).toEqual([])
  })
  it('closes an existing VPN app before retrying enable from a failed state', async () => {
    const f = await setup(); await f.controller.setEnabled(true); f.backend.probe.mockResolvedValue(false)
    await f.controller.check(); await f.controller.check()
    // The host may finish a pending launch while a retry is being requested.
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' }); f.order.length = 0
    await f.controller.setEnabled(true)
    expect(f.order[0]).toBe('close'); expect(f.order[1]).toBe('proxy start')
  })
  it('does no queued backend or proxy work after disposing a held enable', async () => {
    const f = await setup(), held = deferred<void>(); f.flush.mockReturnValueOnce(held.promise)
    const enable = f.controller.setEnabled(true); await vi.advanceTimersByTimeAsync(0)
    const jobs = [f.controller.setEnabled(false), f.controller.setLocation(location().id), f.controller.removeLocation(location().id),
      f.controller.check(), f.controller.start(), f.controller.deleteAllProfiles(), f.controller.startImport(),
      f.controller.receiveFile('UK.conf', conf()), f.controller.chooseImportEntry('any'), f.controller.finishImport('UK'),
      f.controller.setAppVpn('iplayer', 'vpn-only'), f.controller.setAllApps('direct'), f.controller.cancelImport()]
    f.controller.dispose(); held.resolve(); await enable; await Promise.all(jobs)
    expect(f.order).toEqual([]); expect(f.backend.status).not.toHaveBeenCalled()
    expect(f.backend.importProfile).not.toHaveBeenCalled(); expect(f.backend.listProfiles).not.toHaveBeenCalled()
  })
  it('rejects VPN changes during a network trial without backend writes', async () => {
    const f = await setup(); await f.controller.startImport(); await f.controller.receiveFile('UK.conf', conf())
    f.networkBusy.mockResolvedValue(true)
    for (const change of [() => f.controller.setEnabled(true), () => f.controller.setLocation('missing'),
      () => f.controller.removeLocation(location().id)]) {
      expect(await change()).toEqual({ ok: false, error: 'Finish checking the network settings first.' })
    }
    expect(await f.controller.finishImport('UK')).toEqual({ stage: 'error', error: 'save-failed' })
    expect(f.order).toEqual([]); expect(f.backend.importProfile).not.toHaveBeenCalled()
  })
  it('waits for a network trial before reconciling and still rejects changes immediately', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true } }); f.networkBusy.mockResolvedValue(true)
    const start = f.controller.start(); await vi.advanceTimersByTimeAsync(6000)
    expect(f.backend.listProfiles).not.toHaveBeenCalled()
    expect(await f.controller.setEnabled(false)).toEqual({ ok: false, error: 'Finish checking the network settings first.' })
    f.networkBusy.mockResolvedValue(false); await vi.advanceTimersByTimeAsync(2000); await start
    expect(f.controller.status().state).toBe('connected')
  })
  it('quietly gives up reconcile after a two-minute network trial', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true } }); f.networkBusy.mockResolvedValue(true)
    const start = f.controller.start(); await vi.advanceTimersByTimeAsync(120000); await start
    expect(f.controller.status().state).toBe('down'); expect(f.backend.listProfiles).not.toHaveBeenCalled()
    expect(f.proxy.start).not.toHaveBeenCalled(); expect(f.toast).not.toHaveBeenCalled()
  })
  it('shows an off VPN as off after giving up a two-minute network trial at start-up', async () => {
    const f = await setup(); f.networkBusy.mockResolvedValue(true)
    const start = f.controller.start(); await vi.advanceTimersByTimeAsync(120000); await start
    expect(f.controller.status().state).toBe('off')
  })
  it('waits during bring-up if a network trial starts after enabling is saved', async () => {
    const f = await setup()
    f.flush.mockImplementationOnce(async () => { f.networkBusy.mockResolvedValue(true) })
    const enable = f.controller.setEnabled(true); await vi.advanceTimersByTimeAsync(4000)
    expect(f.proxy.start).not.toHaveBeenCalled()
    f.networkBusy.mockResolvedValue(false); await vi.advanceTimersByTimeAsync(2000); await enable
    expect(f.controller.status().state).toBe('connected')
  })
  it('leaves an off VPN check idle without probing', async () => {
    const f = await setup()
    expect(await f.controller.check()).toMatchObject({ state: 'off', check: 'idle' })
    expect(f.backend.probe).not.toHaveBeenCalled(); expect(f.backend.status).not.toHaveBeenCalled()
  })
  it('still disables the VPN if closing the app throws', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' })
    f.close.mockRejectedValueOnce(new Error('close failed')); await f.controller.setEnabled(false)
    expect(f.controller.status()).toMatchObject({ enabled: false, state: 'off', appOnVpn: null })
    expect(f.backend.down).toHaveBeenCalled(); expect(f.proxy.stop).toHaveBeenCalled()
  })
  it('counts failed launch probes towards the two-failure rule', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } })
    f.backend.probe.mockResolvedValue(false)
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(f.controller.status().state).not.toBe('not-working')
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(f.controller.status().state).toBe('not-working')
  })
  it('starts not set up, needs a location and strips private location fields from status', async () => {
    const f = await setup(false)
    expect(f.controller.status().state).toBe('not-set-up')
    expect(await f.controller.setEnabled(true)).toEqual({ ok: false, error: 'Add a VPN location first.' })
    f.settings.update({ vpn: { locations: [location()], activeLocationId: location().id, apps: { youtube: 'direct' } } })
    expect(f.controller.status().locations).toEqual([{ id: location().id, label: 'UK', addedAt: location().addedAt }])
    expect(f.controller.status().apps).toEqual({})
  })
  it.each([
    [false, 'vpn-only', 'iplayer'], [true, 'direct', 'iplayer'], [true, 'vpn-only', 'locked'],
  ] as const)('routes direct for enabled=%s choice=%s app=%s', async (enabled, choice, app) => {
    const f = await setup()
    f.settings.update({ vpn: { enabled, apps: { [app]: choice } } })
    expect(await f.controller.routeFor(app)).toEqual({ kind: 'direct' }); expect(f.backend.probe).not.toHaveBeenCalled()
  })
  it('routes a connected app through the proxy without another probe', async () => {
    const f = await setup(); await f.controller.setAppVpn('iplayer', 'vpn-only'); await f.controller.setEnabled(true)
    f.backend.probe.mockClear()
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'vpn', port: 1080, label: 'UK' })
    expect(f.backend.probe).not.toHaveBeenCalled()
  })
  it.each(['vpn-only', 'vpn-or-direct'] as const)('a launch probe passes for %s', async (choice) => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: choice } } })
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'vpn', port: 1080, label: 'UK' })
    expect(f.controller.status().state).toBe('connected'); expect(f.backend.probe).toHaveBeenCalledOnce()
  })
  it.each(['vpn-only', 'vpn-or-direct'] as const)('a failed launch is blocked or falls back for %s', async (choice) => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: choice } } })
    f.backend.probe.mockResolvedValue(false)
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: choice === 'vpn-only' ? 'blocked' : 'fallback' })
  })
  it.each(['status', 'routingOk', 'probe'] as const)('enforces a total three-second budget when %s hangs', async (step) => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } })
    const pending = deferred<never>(); f.backend[step].mockReturnValue(pending.promise)
    const route = f.controller.routeFor('iplayer'), done = vi.fn(); void route.then(done)
    await vi.advanceTimersByTimeAsync(2999); expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(await route).toEqual({ kind: 'blocked' })
  })
  it('spends the remaining budget waiting for the proxy, and removes the listener', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } }); f.port(null)
    f.backend.status.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000)); return { state: 'up', tunIp: '10.64.0.2' }
    })
    const route = f.controller.routeFor('iplayer')
    await vi.advanceTimersByTimeAsync(2999); expect(f.portListeners.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1); expect(await route).toEqual({ kind: 'blocked' }); expect(f.portListeners.size).toBe(0)
  })
  it('waits for a proxy port within the budget', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } }); f.port(null)
    const route = f.controller.routeFor('iplayer'); await vi.advanceTimersByTimeAsync(20); f.port(1081)
    expect(await route).toEqual({ kind: 'vpn', port: 1081, label: 'UK' }); expect(f.portListeners.size).toBe(0)
  })
  it('counts consecutive failures, resets on pass, and goes down when routing is missing', async () => {
    const f = await setup(); await f.controller.setEnabled(true); f.backend.probe.mockResolvedValue(false)
    expect((await f.controller.check()).state).toBe('connected')
    f.backend.probe.mockResolvedValueOnce(true); expect((await f.controller.check()).state).toBe('connected')
    expect((await f.controller.check()).state).toBe('connected')
    expect((await f.controller.check()).state).toBe('not-working')
    f.backend.routingOk.mockResolvedValue(false)
    expect((await f.controller.check()).state).toBe('down'); expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
    expect(f.events.some((e) => e.check === 'checking')).toBe(true)
  })
  it.each([null, '127.0.0.1'])('a missing or invalid address (%s) is immediately down', async (ip) => {
    const f = await setup(); await f.controller.setEnabled(true); f.device({ state: 'up', tunIp: ip })
    f.controller.notifyNetworkChanged(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.status().state).toBe('down'); expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
  })
  it('polls every five seconds, probes every thirty and stops timers when disabled', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.backend.status.mockClear(); f.backend.probe.mockClear()
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.backend.status).toHaveBeenCalledTimes(7); expect(f.backend.probe).toHaveBeenCalledOnce()
    await f.controller.setEnabled(false); f.backend.status.mockClear(); f.backend.probe.mockClear()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.backend.status).not.toHaveBeenCalled(); expect(f.backend.probe).not.toHaveBeenCalled()
  })
  it('shares concurrent probes', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only', youtube: 'vpn-only' } } })
    const pending = deferred<boolean>(); f.backend.probe.mockReturnValue(pending.promise)
    const a = f.controller.routeFor('iplayer'), b = f.controller.routeFor('youtube')
    await vi.advanceTimersByTimeAsync(0); expect(f.backend.probe).toHaveBeenCalledOnce()
    pending.resolve(true); expect((await a).kind).toBe('vpn'); expect((await b).kind).toBe('vpn')
  })
  it('ignores a successful old-address probe after the tunnel disappears', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    const pending = deferred<boolean>(); f.backend.probe.mockReturnValueOnce(pending.promise)
    const check = f.controller.check(); await vi.advanceTimersByTimeAsync(0)
    f.device({ state: 'absent', tunIp: null }); f.controller.notifyNetworkChanged(); await vi.advanceTimersByTimeAsync(0)
    pending.resolve(true); expect((await check).state).toBe('down')
    expect(f.proxy.setTunnel).toHaveBeenLastCalledWith(null, null)
  })
  it('recovers after a status command that never answers', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.backend.status.mockReturnValueOnce(deferred<VpnDeviceStatus>().promise)
    const check = f.controller.check(); await vi.advanceTimersByTimeAsync(3000); await check
    expect((await f.controller.check()).state).toBe('connected')
  })
  it.each(['connecting', 'not-working'] as const)('re-probes launch routes from %s', async (state) => {
    const f = await setup(); f.backend.probe.mockResolvedValue(false); await f.controller.setEnabled(true)
    if (state === 'not-working') await f.controller.check()
    expect(f.controller.status().state).toBe(state)
    await f.controller.setAppVpn('iplayer', 'vpn-only'); f.backend.probe.mockResolvedValue(true)
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'vpn', port: 1080, label: 'UK' })
  })
  it('shows slow after fifteen seconds connecting', async () => {
    const f = await setup(), pending = deferred<void>(); f.backend.up.mockReturnValue(pending.promise)
    const enable = f.controller.setEnabled(true)
    await vi.advanceTimersByTimeAsync(14999); expect(f.controller.status()).toMatchObject({ state: 'connecting', slow: false })
    await vi.advanceTimersByTimeAsync(1); expect(f.controller.status().slow).toBe(true)
    pending.resolve(); await enable; expect(f.controller.status()).toMatchObject({ state: 'connected', slow: false })
  })
  it('keeps enabled and retry timers after an up failure', async () => {
    const f = await setup(); f.backend.up.mockRejectedValue(new Error('failed'))
    expect(await f.controller.setEnabled(true)).toEqual({ ok: true })
    expect(f.controller.status()).toMatchObject({ enabled: true, state: 'down' })
    await vi.advanceTimersByTimeAsync(30000); expect(f.controller.status().state).toBe('connected')
  })
  it.each([true, false])('notifies one drop and recovery, VPN app open=%s', async (open) => {
    const f = await setup(); await f.controller.setEnabled(true)
    if (open) f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' })
    f.device({ state: 'absent', tunIp: null })
    await f.controller.check(); await f.controller.check()
    expect(f.close).toHaveBeenCalledTimes(open ? 1 : 0); expect(f.dropped).toHaveBeenCalledTimes(open ? 1 : 0)
    if (open) expect(f.dropped).toHaveBeenCalledWith('iplayer')
    else expect(f.toast).toHaveBeenCalledExactlyOnceWith(
      "The VPN has disconnected. Apps using it will stop until it's back.", 'error')
    f.device({ state: 'up', tunIp: '10.64.0.3' }); await f.controller.check(); await f.controller.check()
    expect(f.toast.mock.calls.filter(([text]) => text === 'The VPN is back.')).toHaveLength(1)
    expect(f.proxy.setTunnel).toHaveBeenLastCalledWith('10.64.0.3', '10.64.0.1')
  })
  it('closes a running VPN app on two failed probes and records app exits', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' }); f.controller.noteExited('other')
    expect(f.controller.status().appOnVpn).toBe('iplayer')
    f.backend.probe.mockResolvedValue(false); await f.controller.check(); await f.controller.check(); await f.controller.check()
    expect(f.close).toHaveBeenCalledOnce(); expect(f.dropped).toHaveBeenCalledOnce()
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' }); f.controller.noteExited('iplayer')
    expect(f.controller.status().appOnVpn).toBeNull()
  })
  it('closes the VPN app before down, and still turns off after backend failures', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' }); f.order.length = 0
    f.backend.down.mockImplementation(async () => { f.order.push('down'); throw new Error('failed') })
    await f.controller.setEnabled(false)
    expect(f.order).toEqual(['close', `auto ${u1} false`, 'down', 'proxy stop'])
    expect(f.controller.status()).toMatchObject({ state: 'off', enabled: false, appOnVpn: null })
  })
  it.each(['one', 'all'] as const)('closes before saving changed app choices (%s) and honours locks', async (which) => {
    const f = await setup(); f.running('iplayer')
    const update = vi.spyOn(f.settings, 'update')
    await (which === 'one' ? f.controller.setAppVpn('iplayer', 'vpn-only') : f.controller.setAllApps('vpn-only'))
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!)
    expect(f.settings.get().vpn.apps.locked).toBeUndefined()
    expect(await f.controller.setAppVpn('locked', 'vpn-only')).toEqual({ ok: false, error: 'Locked always connects directly.' })
    await f.controller.setAppVpn('iplayer', 'direct'); expect(f.settings.get().vpn.apps.iplayer).toBeUndefined()
  })
  it('does not close an app when its choice has not changed', async () => {
    const f = await setup(); f.running('iplayer'); await f.controller.setAppVpn('iplayer', 'direct')
    await f.controller.setAllApps('direct'); expect(f.close).not.toHaveBeenCalled()
  })
  it('switches locations in order and changes the active location while off without backend writes', async () => {
    const f = await setup(); f.settings.update({ vpn: { locations: [location(), location(2)] } })
    await f.controller.setEnabled(true); f.controller.noteLaunched('iplayer', { kind: 'vpn', port: 1080, label: 'UK' })
    f.order.length = 0; await f.controller.setLocation(location(2).id)
    expect(f.order).toEqual(['close', `auto ${u1} false`, `down ${u1}`, 'proxy start', `auto ${u2} true`, `up ${u2}`])
    await f.controller.setEnabled(false); f.order.length = 0; await f.controller.setLocation(location().id)
    expect(f.order).toEqual([])
    expect((await f.controller.setLocation('missing')).ok).toBe(false)
  })
  it('turns off before removing the active location and keeps a location on removal failure', async () => {
    const f = await setup(); await f.controller.setEnabled(true); f.order.length = 0
    f.backend.remove.mockRejectedValueOnce(new Error('failed'))
    expect((await f.controller.removeLocation(location().id)).ok).toBe(false)
    expect(f.settings.get().vpn.locations).toHaveLength(1); expect(f.settings.get().vpn.enabled).toBe(false)
    expect(f.order).toEqual([`auto ${u1} false`, `down ${u1}`, 'proxy stop'])
    await f.controller.removeLocation(location().id); expect(f.controller.status().state).toBe('not-set-up')
  })
  it('selects the first remaining location when the active location is removed', async () => {
    const f = await setup(); f.settings.update({ vpn: { locations: [location(), location(2)] } })
    await f.controller.removeLocation(location().id)
    expect(f.controller.status().activeLocationId).toBe(location(2).id)
    expect(f.backend.remove).toHaveBeenCalledWith(u1)
  })
  it('serialises quick on/off calls', async () => {
    const f = await setup(), pending = deferred<void>()
    f.backend.up.mockImplementation(async (uuid) => { f.order.push(`up ${uuid}`); await pending.promise })
    const on = f.controller.setEnabled(true), off = f.controller.setEnabled(false)
    await vi.advanceTimersByTimeAsync(0); expect(f.backend.down).not.toHaveBeenCalled()
    pending.resolve(); await on; await off
    expect(f.order).toEqual(['proxy start', `auto ${u1} true`, `up ${u1}`, `auto ${u1} false`, `down ${u1}`, 'proxy stop'])
  })
  it('disposes timers and ignores in-flight probe results without taking the tunnel down', async () => {
    const f = await setup(); await f.controller.setEnabled(true)
    const pending = deferred<boolean>(); f.backend.probe.mockReturnValue(pending.promise)
    const check = f.controller.check(); await vi.advanceTimersByTimeAsync(0); f.controller.dispose()
    pending.resolve(false); await check; const count = f.events.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.events).toHaveLength(count); expect(f.backend.down).not.toHaveBeenCalled(); expect(f.proxy.stop).not.toHaveBeenCalled()
  })
  it('removes a pending port listener on disposal', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } }); f.port(null)
    const route = f.controller.routeFor('iplayer'); await vi.advanceTimersByTimeAsync(0)
    expect(f.portListeners.size).toBe(1); f.controller.dispose()
    expect(await route).toEqual({ kind: 'blocked' }); expect(f.portListeners.size).toBe(0)
  })
})

describe('VPN reconciliation', () => {
  it('blocks VPN-only routing while the start-up profile listing is held', async () => {
    const f = await setup(), held = deferred<Awaited<ReturnType<VpnBackend['listProfiles']>>>()
    f.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } })
    f.backend.listProfiles.mockReturnValueOnce(held.promise)
    const start = f.controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(await f.controller.routeFor('iplayer')).toEqual({ kind: 'blocked' })
    expect(f.backend.probe).not.toHaveBeenCalled()
    held.resolve(null); await start
  })
  it('drops missing saved profiles and cleans up only owned WireGuard leftovers', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true } })
    f.backend.listProfiles.mockResolvedValue([
      { uuid: 'orphan-1', name: 'mosvpn0', type: 'wireguard' },
      { uuid: 'orphan-2', name: 'MediaOS VPN - UK', type: 'wireguard' },
      { uuid: 'personal', name: 'Personal VPN', type: 'wireguard' },
      { uuid: 'ethernet', name: 'mosvpn0', type: '802-3-ethernet' },
    ])
    await f.controller.start()
    expect(f.settings.get().vpn).toMatchObject({ locations: [], activeLocationId: null, enabled: false })
    expect(f.backend.remove.mock.calls).toEqual([['orphan-1'], ['orphan-2']]); expect(f.logger.warn).toHaveBeenCalled()
  })
  it('a failed listing deletes nothing and still brings up the saved active profile', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true } })
    vi.spyOn(f.opts.backend as VpnBackend, 'listProfiles').mockResolvedValue(null)
    await f.controller.start()
    expect(f.settings.get().vpn.locations).toHaveLength(1); expect(f.backend.remove).not.toHaveBeenCalled()
    expect(f.backend.up).toHaveBeenCalledWith(u1, '10.64.0.2')
  })
  it('keeps the active location enabled if only an inactive profile is missing', async () => {
    const f = await setup(); f.settings.update({ vpn: { enabled: true, locations: [location(), location(2)] } })
    f.backend.listProfiles.mockResolvedValue([{ uuid: u1, name: 'UK', type: 'wireguard' }])
    await f.controller.start()
    expect(f.settings.get().vpn).toMatchObject({ enabled: true, activeLocationId: location().id, locations: [location()] })
    expect(f.controller.status().state).toBe('connected')
  })
  it.each([true, false])('sets active/inactive profiles to match enabled=%s', async (enabled) => {
    const f = await setup(); f.settings.update({ vpn: { enabled, locations: [location(), location(2)] } })
    await f.controller.start()
    expect(f.backend.setAutoconnect).toHaveBeenCalledWith(u2, false)
    expect(f.backend.down).toHaveBeenCalledWith(u2)
    expect(f.backend.setAutoconnect).toHaveBeenCalledWith(u1, enabled)
    if (!enabled) expect(f.backend.down).toHaveBeenCalledWith(u1)
  })
  it('factory cleanup attempts every profile despite failures, then stops the proxy', async () => {
    const f = await setup(); f.settings.update({ vpn: { locations: [location(), location(2)] } })
    f.backend.down.mockRejectedValueOnce(new Error('failed')); f.backend.remove.mockRejectedValueOnce(new Error('failed'))
    await f.controller.deleteAllProfiles()
    expect(f.backend.down).toHaveBeenCalledTimes(2); expect(f.backend.remove).toHaveBeenCalledTimes(2)
    expect(f.proxy.stop).toHaveBeenCalledOnce(); expect(f.logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('VPN imports', () => {
  it('picks a random import entry for any', async () => {
    const f = await setup(false); await f.controller.startImport()
    await f.controller.receiveFile('servers.zip', zip(['uk.conf', 'fr.conf', 'de.conf']))
    expect(await f.controller.chooseImportEntry('any')).toMatchObject({ stage: 'name', suggested: 'fr' })
    expect(f.randomInt).toHaveBeenCalledExactlyOnceWith(3)
  })
  it('tries the remaining entries in order when the random entry cannot be parsed', async () => {
    const f = await setup(false); await f.controller.startImport()
    await f.controller.receiveFile('servers.zip', zip(['uk.conf', 'bad.conf', 'de.conf'], [conf(), Buffer.from('bad'), conf()]))
    expect(await f.controller.chooseImportEntry('any')).toMatchObject({ stage: 'name', suggested: 'uk' })
  })
  it('gives a parse error when no entry chosen by any can be parsed', async () => {
    const f = await setup(false); await f.controller.startImport()
    await f.controller.receiveFile('servers.zip', zip(['uk.conf', 'fr.conf'], [Buffer.from('bad'), Buffer.from('bad')]))
    expect(await f.controller.chooseImportEntry('any')).toEqual({ stage: 'error', error: 'not-wireguard' })
  })
  it('waits, checks, names, saves and clears its config without exposing any key in logs or status', async () => {
    const f = await setup(false)
    expect(await f.controller.startImport()).toEqual({ stage: 'waiting', url: null, code: null,
      expiresAt: '2026-11-14T00:05:00.000Z' })
    await f.controller.receiveFile('uk-lon.conf', conf('PostUp = unsafe'))
    expect(f.controller.status().import).toEqual({ stage: 'name', suggested: 'uk-lon', removed: ['PostUp'] })
    expect(await f.controller.finishImport('  UK  ')).toEqual({ stage: 'done', label: 'UK' })
    expect(f.settings.get().vpn).toMatchObject({ activeLocationId: 'loc-00000002', locations: [
      { id: 'loc-00000002', label: 'UK', dns: '10.64.0.1', nmUuid: imported },
    ] })
    expect(f.events.map((s) => s.import?.stage)).toEqual(expect.arrayContaining(['checking', 'saving', 'done']))
    for (const value of [...Object.values(f.logger).map((fn) => fn.mock.calls), f.events, f.settings.get()]) {
      expect(JSON.stringify(value)).not.toContain(key)
    }
    await f.controller.finishImport('Another'); expect(f.backend.importProfile).toHaveBeenCalledOnce()
  })
  it.each([
    ['too-large', Buffer.alloc(65537)], ['not-wireguard', Buffer.from('not a config')],
    ['no-private-key', Buffer.from('[Interface]\nAddress = 10.1.1.2/32\n')],
    ['not-full-tunnel', Buffer.from(conf().toString('utf8').replace('0.0.0.0/0', '10.0.0.0/8'))],
    ['several-peers', Buffer.concat([conf(), Buffer.from('[Peer]\n')])],
  ] as const)('maps import error %s', async (error, input) => {
    const f = await setup(false); await f.controller.startImport(); await f.controller.receiveFile('file.conf', input)
    expect(f.controller.status().import).toEqual({ stage: 'error', error })
    await f.controller.finishImport('UK'); expect(f.backend.importProfile).not.toHaveBeenCalled()
  })
  it('expires after five minutes and ignores files outside waiting', async () => {
    const f = await setup(false); await f.controller.receiveFile('x.conf', conf()); expect(f.controller.status().import).toBeNull()
    await f.controller.startImport(); await vi.advanceTimersByTimeAsync(300000)
    expect(f.controller.status().import).toEqual({ stage: 'error', error: 'expired' })
    await f.controller.receiveFile('x.conf', conf()); expect(f.controller.status().import).toEqual({ stage: 'error', error: 'expired' })
    expect(f.events.at(-1)?.import).toEqual({ stage: 'error', error: 'expired' })
    await f.controller.cancelImport(); expect(f.controller.status().import).toBeNull()
  })
  it('replaces an import and cancels the old expiry timer after receiving a file', async () => {
    const f = await setup(false); await f.controller.startImport(); await f.controller.receiveFile('first.conf', conf())
    await f.controller.startImport(); await f.controller.receiveFile('second.conf', conf())
    await vi.advanceTimersByTimeAsync(300000)
    expect(f.controller.status().import).toMatchObject({ stage: 'name', suggested: 'second' })
    await f.controller.cancelImport(); await f.controller.finishImport('UK'); expect(f.backend.importProfile).not.toHaveBeenCalled()
  })
  it.each([['only.conf'], ['uk-lon.conf', 'fr-par.conf']])('uses ZIP entries without writing them to disk: %j', async (...names) => {
    const f = await setup(false); await f.controller.startImport(); await f.controller.receiveFile('servers.zip', zip(names))
    if (names.length > 1) {
      expect(f.controller.status().import?.stage).toBe('choose')
      const before = f.controller.status().import
      for (const id of ['e999', 'e00', 'e01']) {
        await f.controller.chooseImportEntry(id); expect(f.controller.status().import).toEqual(before)
      }
      await f.controller.chooseImportEntry('e1'); expect(f.controller.status().import).toMatchObject({ stage: 'name', suggested: 'fr-par' })
    } else expect(f.controller.status().import).toMatchObject({ stage: 'name', suggested: 'only' })
  })
  it('refuses a ZIP with no configs and a truncated ZIP', async () => {
    const f = await setup(false)
    for (const input of [zip(['readme.txt']), Buffer.from('PK\x03\x04bad')]) {
      await f.controller.startImport(); await f.controller.receiveFile('bad.zip', input)
      expect(f.controller.status().import).toEqual({ stage: 'error', error: 'not-wireguard' })
    }
  })
  it('turns the VPN on after the first location only, without the Done screen waiting for the tunnel', async () => {
    const f = await setup(false); await f.controller.startImport(); await f.controller.receiveFile('UK.conf', conf())
    let release!: () => void
    f.backend.up.mockImplementationOnce(async (uuid: string) => { await new Promise<void>((r) => { release = r }); f.order.push(`up ${uuid}`) })
    expect(await f.controller.finishImport('UK')).toEqual({ stage: 'done', label: 'UK' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settings.get().vpn.enabled).toBe(true)
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(f.order).toContain(`up ${imported}`)
    await f.controller.setEnabled(false); f.backend.up.mockClear(); f.backend.importProfile.mockResolvedValue(uuid(10))
    await f.controller.startImport(); await f.controller.receiveFile('FR.conf', conf())
    expect(await f.controller.finishImport('France')).toEqual({ stage: 'done', label: 'France' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.settings.get().vpn.enabled).toBe(false); expect(f.backend.up).not.toHaveBeenCalled()
  })
  it('uses suggestions, trims labels to code points and makes case-insensitive duplicates unique', async () => {
    const f = await setup(); await f.controller.startImport(); await f.controller.receiveFile('UK.conf', conf())
    expect(await f.controller.finishImport('')).toEqual({ stage: 'done', label: 'UK 2' })
    f.backend.importProfile.mockResolvedValue(uuid(10))
    await f.controller.startImport(); await f.controller.receiveFile('file.conf', conf())
    const label = '😀'.repeat(24)
    expect(await f.controller.finishImport(label + 'x')).toEqual({ stage: 'done', label })
    f.backend.importProfile.mockResolvedValue(uuid(11))
    await f.controller.startImport(); await f.controller.receiveFile('file.conf', conf())
    expect(await f.controller.finishImport(label)).toEqual({ stage: 'done', label: '😀'.repeat(22) + ' 2' })
  })
  it('refuses a sixth location', async () => {
    const f = await setup(); f.settings.update({ vpn: { locations: Array.from({ length: 5 }, (_, i) => location(i + 1)) } })
    expect(await f.controller.startImport()).toEqual({ stage: 'error', error: 'too-many-locations' })
  })
  it.each(['backend', 'settings'] as const)('handles save failure in %s and clears secrets', async (step) => {
    const f = await setup(false); await f.controller.startImport(); await f.controller.receiveFile('UK.conf', conf())
    if (step === 'backend') f.backend.importProfile.mockRejectedValue(new Error(key))
    else f.flush.mockRejectedValueOnce(new Error(key))
    expect(await f.controller.finishImport('UK')).toEqual({ stage: 'error', error: 'save-failed' })
    expect(f.backend.remove).toHaveBeenCalledTimes(step === 'settings' ? 1 : 0)
    expect(f.settings.get().vpn.locations).toHaveLength(0)
    expect(JSON.stringify(Object.values(f.logger).map((fn) => fn.mock.calls))).not.toContain(key)
  })
  it.each(['file', 'null', 'throw'] as const)('handles the dev import path: %s', async (mode) => {
    const f = await setup(false), dev = new VpnController({ ...f.opts, devImport: async () => {
      if (mode === 'throw') throw new Error('read failed')
      return mode === 'file' ? { name: 'UK.conf', data: conf() } : null
    } })
    try {
      expect(await dev.startImport()).toMatchObject(mode === 'file' ? { stage: 'name', suggested: 'UK' } :
        { stage: 'error', error: 'not-wireguard' })
    } finally { dev.dispose() }
  })
})
