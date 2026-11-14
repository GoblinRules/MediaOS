import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { composeCore } from '../../src/main/core/compose'
import { Core } from '../../src/main/core/Core'
import { VpnController } from '../../src/main/vpn/VpnController'
import { MockVpnBackend } from '../../src/main/vpn/mock/MockVpnBackend'
import { deferred, temporary } from './helpers'

async function make() {
  const temp = await temporary()
  const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
    forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
  return { core: composed.core, dispose: async () => { await composed.dispose(); await temp.dispose() } }
}
describe('Core VPN wiring', () => {
  it('uses the mock network trial to reject VPN changes too', async () => {
    const f = await make()
    try {
      expect(await f.core.system.network.applyIp('wired', { method: 'auto', dns: { mode: 'preset', preset: 'cloudflare' } }))
        .toEqual({ ok: true })
      expect(await f.core.system.network.trial()).not.toBeNull()
      expect(await f.core.vpn.setEnabled(true)).toEqual({ ok: false, error: 'Finish checking the network settings first.' })
    } finally { await f.core.system.network.revert(); await f.dispose() }
  })
  it('closes a held direct launch when its choice changes to VPN-only', async () => {
    const f = await make(), held = deferred<void>(), launching = deferred<void>(), toast = vi.fn()
    f.core.settings.update({ vpn: { enabled: true } })
    const launch = f.core.apps.launch.bind(f.core.apps)
    vi.spyOn(f.core.apps, 'launch').mockImplementation(async (...args) => {
      launching.resolve(); await held.promise; await launch(...args)
    })
    f.core.on('toast', toast)
    try {
      const result = f.core.dispatch('apps.launch', ['iplayer']); await launching.promise
      await f.core.vpn.setAppVpn('iplayer', 'vpn-only')
      held.resolve()
      expect(await result).toEqual({ ok: false, error: 'BBC iPlayer closed because its VPN setting changed. Open it again.' })
      expect(f.core.apps.running()).toBeUndefined(); expect(f.core.getForeground()).toEqual({ kind: 'shell' })
      expect(toast).not.toHaveBeenCalled(); expect(f.core.vpn.status().appOnVpn).toBeNull()
    } finally { held.resolve(); await f.dispose() }
  })
  it('closes a held VPN launch and shows the drop dialog when the tunnel drops', async () => {
    const f = await make(), held = deferred<void>(), launching = deferred<void>(), dropped = vi.fn()
    const key = randomBytes(32).toString('base64')
    await f.core.vpn.startImport()
    await f.core.vpn.receiveFile('UK.conf', Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\n` +
      `[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`))
    await f.core.vpn.finishImport('UK'); await f.core.vpn.setAppVpn('iplayer', 'vpn-only'); await f.core.vpn.setEnabled(true)
    const launch = f.core.apps.launch.bind(f.core.apps)
    vi.spyOn(f.core.apps, 'launch').mockImplementation(async (...args) => {
      launching.resolve(); await held.promise; await launch(...args)
    })
    f.core.on('vpnDropped', dropped)
    try {
      const result = f.core.dispatch('apps.launch', ['iplayer']); await launching.promise
      const status = vi.spyOn(MockVpnBackend.prototype, 'status').mockResolvedValue({ state: 'absent', tunIp: null })
      try { await f.core.vpn.check() } finally { status.mockRestore() }
      expect(f.core.vpn.status().state).toBe('down')
      held.resolve(); expect(await result).toEqual({ ok: true })
      expect(dropped).toHaveBeenCalledExactlyOnceWith({ appId: 'iplayer' })
      expect(f.core.apps.running()).toBeUndefined(); expect(f.core.getForeground()).toEqual({ kind: 'shell' })
    } finally { held.resolve(); await f.dispose() }
  })
  it('reports only the new app when the tunnel drops while switching between VPN apps', async () => {
    const f = await make(), held = deferred<void>(), launching = deferred<void>(), dropped = vi.fn()
    const key = randomBytes(32).toString('base64')
    await f.core.vpn.startImport()
    await f.core.vpn.receiveFile('UK.conf', Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\n` +
      `[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`))
    await f.core.vpn.finishImport('UK'); await f.core.vpn.setAllApps('vpn-only'); await f.core.vpn.setEnabled(true)
    try {
      expect(await f.core.dispatch('apps.launch', ['iplayer'])).toEqual({ ok: true })
      expect(f.core.vpn.status().appOnVpn).toBe('iplayer')
      const launch = f.core.apps.launch.bind(f.core.apps)
      vi.spyOn(f.core.apps, 'launch').mockImplementation(async (...args) => {
        launching.resolve(); await held.promise; await launch(...args)
      })
      f.core.on('vpnDropped', dropped)
      const result = f.core.dispatch('apps.launch', ['itvx']); await launching.promise
      const status = vi.spyOn(MockVpnBackend.prototype, 'status').mockResolvedValue({ state: 'absent', tunIp: null })
      try { await f.core.vpn.check() } finally { status.mockRestore() }
      held.resolve(); expect(await result).toEqual({ ok: true })
      expect(dropped).toHaveBeenCalledExactlyOnceWith({ appId: 'itvx' })
    } finally { held.resolve(); await f.dispose() }
  })
  it('does not toast a fallback whose held launch is rejected', async () => {
    const f = await make(), held = deferred<void>(), launching = deferred<void>(), toast = vi.fn()
    vi.spyOn(f.core.vpn, 'routeFor').mockResolvedValue({ kind: 'fallback' })
    const launch = f.core.apps.launch.bind(f.core.apps)
    vi.spyOn(f.core.apps, 'launch').mockImplementation(async (...args) => {
      launching.resolve(); await held.promise; await launch(...args)
    })
    f.core.on('toast', toast)
    try {
      const result = f.core.dispatch('apps.launch', ['iplayer']); await launching.promise
      f.core.settings.update({ vpn: { enabled: true, apps: { iplayer: 'vpn-only' } } })
      held.resolve(); expect(await result).toMatchObject({ ok: false }); expect(toast).not.toHaveBeenCalled()
    } finally { held.resolve(); await f.dispose() }
  })
  it('starts TV wake while VPN reconcile is held', async () => {
    const f = await make(), held = deferred<void>(), started = deferred<void>()
    vi.spyOn(f.core.vpn, 'start').mockImplementation(() => { started.resolve(); return held.promise })
    const wake = vi.spyOn(f.core.system.cec, 'wakeTv').mockResolvedValue({ ok: true })
    f.core.settings.update({ cec: { wakeTvOnStart: true } })
    const core = new Core({ ...f.core, restartShell() {}, clearCaches: async () => {} })
    try {
      const start = core.start(); await started.promise; await Promise.resolve()
      expect(wake).toHaveBeenCalledOnce(); held.resolve(); await start
    } finally { held.resolve(); core.dispose(); await f.dispose() }
  })
  it('returns the composition while VPN start-up is held', async () => {
    const temp = await temporary(), held = deferred<void>(), ready = vi.fn()
    const spy = vi.spyOn(VpnController.prototype, 'start').mockReturnValue(held.promise)
    const composition = composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir,
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} }).then((value) => { ready(); return value })
    try { await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce()) }
    finally { held.resolve(); spy.mockRestore(); await (await composition).dispose(); await temp.dispose() }
  })
  it('records app exit before starting player playback', async () => {
    const f = await make(), exit = vi.spyOn(f.core.vpn, 'noteExited'), play = vi.spyOn(f.core.player, 'play')
    // Some hosts close without an exit event or clearing running() immediately; this must be explicit in player.play.
    const close = vi.spyOn(f.core.apps, 'close').mockResolvedValue()
    try {
      await f.core.dispatch('apps.launch', ['iplayer'])
      const home = await f.core.hub.home(f.core.settings.get().home)
      const key = home.rows.flatMap((r) => r.items).find((i) => i.type === 'movie')!.key
      await f.core.dispatch('player.play', [key, { resume: false }])
      expect(exit).toHaveBeenCalledWith('iplayer')
      expect(exit.mock.invocationCallOrder[0]).toBeLessThan(play.mock.invocationCallOrder[0]!)
    } finally { close.mockRestore(); await f.dispose() }
  })
  it('blocks VPN-only launches before stopping the player or opening an app', async () => {
    const f = await make(), launch = vi.spyOn(f.core.apps, 'launch'), stop = vi.spyOn(f.core.player, 'stop')
    vi.spyOn(f.core.vpn, 'routeFor').mockResolvedValue({ kind: 'blocked' })
    try {
      expect(await f.core.dispatch('apps.launch', ['iplayer']))
        .toEqual({ ok: false, error: "BBC iPlayer can't open right now", vpnBlocked: true })
      expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('launches a fallback directly and toasts using the catalogue name', async () => {
    const f = await make(), launch = vi.spyOn(f.core.apps, 'launch'), toast = vi.fn()
    vi.spyOn(f.core.vpn, 'routeFor').mockResolvedValue({ kind: 'fallback' })
    const note = vi.spyOn(f.core.vpn, 'confirmLaunch'); f.core.on('toast', toast)
    try {
      expect(await f.core.dispatch('apps.launch', ['iplayer'])).toEqual({ ok: true })
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ id: 'iplayer' }), { kind: 'direct' })
      expect(note).toHaveBeenCalledWith('iplayer', { kind: 'direct' }, true)
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'info',
        text: "The VPN isn't working, so BBC iPlayer opened without it." }))
      const exit = vi.spyOn(f.core.vpn, 'noteExited'); await f.core.dispatch('apps.close', [])
      expect(exit).toHaveBeenCalledWith('iplayer')
    } finally { await f.dispose() }
  })
  it('deletes VPN profiles before settings are erased during factory reset', async () => {
    const f = await make(), profiles = vi.spyOn(f.core.vpn, 'deleteAllProfiles'), settings = vi.spyOn(f.core.settings, 'erase')
    try {
      await f.core.dispatch('shell.factoryReset', ['ERASE'])
      expect(profiles).toHaveBeenCalledOnce()
      expect(profiles.mock.invocationCallOrder[0]).toBeLessThan(settings.mock.invocationCallOrder[0]!)
    } finally { await f.dispose() }
  })
  it('clears the VPN app when a Home-key close returns foreground to the shell', async () => {
    const f = await make()
    vi.spyOn(f.core.vpn, 'routeFor').mockResolvedValue({ kind: 'vpn', port: 1080, label: 'UK' })
    vi.spyOn(f.core.vpn, 'confirmLaunch').mockImplementation(async (id, route) => {
      f.core.vpn.noteLaunched(id, route); return true
    })
    try {
      await f.core.dispatch('apps.launch', ['iplayer']); expect(f.core.vpn.status().appOnVpn).toBe('iplayer')
      // ActionRouter closes the host directly, then hands foreground back to Core.
      await f.core.apps.close(); f.core.setForeground({ kind: 'shell' })
      expect(f.core.vpn.status().appOnVpn).toBeNull()
    } finally { await f.dispose() }
  })
  it('imports a dev file, emits status, launches via the mock proxy and closes on drop', async () => {
    const temp = await temporary(), key = randomBytes(32).toString('base64'), file = join(temp.dir, 'uk.conf')
    await fs.writeFile(file, `[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\n[Peer]\nPublicKey = ${key}\n` +
      'Endpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n', 'utf8')
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, vpnImport: file, restartShell() {} })
    const { core } = composed, event = vi.fn(), dropped = vi.fn()
    core.on('vpn', event); core.on('vpnDropped', dropped)
    try {
      expect(await core.dispatch('vpn.startImport', [])).toMatchObject({ stage: 'name', suggested: 'uk' })
      expect(await core.dispatch('vpn.finishImport', ['UK'])).toEqual({ stage: 'done', label: 'UK' })
      await core.dispatch('vpn.setAppVpn', ['iplayer', 'vpn-only']); await core.dispatch('vpn.setEnabled', [true])
      const launch = vi.spyOn(core.apps, 'launch')
      await core.dispatch('apps.launch', ['iplayer'])
      expect(launch).toHaveBeenCalledWith(expect.objectContaining({ id: 'iplayer' }), { kind: 'vpn', port: 1080, label: 'UK' })
      expect(core.vpn.status().appOnVpn).toBe('iplayer')
      expect(event).toHaveBeenLastCalledWith({ status: expect.objectContaining({ state: 'connected', appOnVpn: 'iplayer' }) })
      const notify = vi.spyOn(core.vpn, 'notifyNetworkChanged'); await core.system.network.resetAll()
      expect(notify).toHaveBeenCalled()
      await core.dispatch('vpn.setEnabled', [false]); expect(core.apps.running()).toBeUndefined()
      expect(core.getForeground()).toEqual({ kind: 'shell' }); expect(dropped).not.toHaveBeenCalled()
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('caps the development file read and reports a large file', async () => {
    const temp = await temporary(), file = join(temp.dir, 'huge.conf')
    await fs.writeFile(file, Buffer.alloc(1024 * 1024))
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, vpnImport: file, restartShell() {} })
    try { expect(await composed.core.dispatch('vpn.startImport', [])).toEqual({ stage: 'error', error: 'too-large' }) }
    finally { await composed.dispose(); await temp.dispose() }
  })
})
