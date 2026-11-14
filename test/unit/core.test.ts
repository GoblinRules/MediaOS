import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { CALLS, type CallName, type EventPayloads, type Foreground } from '@shared/ipc-contract'
import { defaultSettings } from '@shared/settings-schema'
import type { PlayerCommand, PlayerState } from '@shared/player-types'
import type { AppHost } from '../../src/main/apps/types'
import type { PlayerController } from '../../src/main/player/types'
import { composeCore } from '../../src/main/core/compose'
import { Core } from '../../src/main/core/Core'
import { handleCall } from '../../src/main/core/ipc'
import { ActionRouter } from '../../src/main/core/ActionRouter'
import { SourceError } from '../../src/main/sources/MediaSource'
import { UserFacingError } from '../../src/main/system/net/texts'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { deferred, temporary } from './helpers'
import { runtime } from '../../src/main/core/runtime'

afterEach(() => vi.useRealTimers())

describe('core composition and IPC', () => {
  it.each([false, true])('owns the overnight timer only when enabled (%s) and disposes it', async (enabled) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 13, 5, 25))
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir,
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    const base = composed.core
    const auto = vi.spyOn(base.system.updates, 'auto').mockResolvedValue({ ok: true })
    let core = base
    try {
      await base.dispatch('shell.reportIdle', [true])
      // The mock composition never enables the overnight timer on its own.
      await vi.advanceTimersByTimeAsync(5 * 60000); expect(auto).not.toHaveBeenCalled()
      base.dispose()
      core = new Core({ ...base, overnightUpdates: enabled, timers: runtime,
        restartShell() {}, clearCaches: async () => undefined })
      await core.dispatch('shell.reportIdle', [true])
      await vi.advanceTimersByTimeAsync(5 * 60000)
      expect(auto).toHaveBeenCalledTimes(enabled ? 1 : 0)
      core.dispose()
      vi.setSystemTime(new Date(2026, 10, 14, 5, 25)); await vi.advanceTimersByTimeAsync(5 * 60000)
      expect(auto).toHaveBeenCalledTimes(enabled ? 1 : 0)
    } finally { core.dispose(); await composed.dispose(); await temp.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('dispatches every CALLS name with valid arguments through the mock composition', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), restartShell = vi.fn()
    const { core, images, dispose } = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, fixtureLatencyMs: 0, mockDelayMs: 0, restartShell,
      // Only the weather service fetches here (no Jellyfin or Plex sources); never reach the real internet.
      fetch: async () => Response.json({ results: [{ name: 'London', latitude: 51.5, longitude: -0.13, country: 'UK' }] }) })
    try {
      core.hub.add(new FixtureSource({ id: 'remove-me' }))
      await core.secrets.set('remove-me', { token: 'private' })
      const home = await core.hub.home(core.settings.get().home)
      const key = home.rows.find((r) => r.kind === 'latest')!.items.find((i) => i.type === 'movie')!.key
      const library = (await core.hub.libraries())[0]!.key
      const quick = await core.signin.quickConnect('http://test')
      const plex = await core.signin.plexPin()
      await core.signin.poll(plex.flowId); await core.signin.poll(plex.flowId); await core.signin.poll(plex.flowId)
      await core.system.bluetooth.startScan()
      const removeFolder = await core.system.folders.add({ server: 'nas', share: 'Remove', guest: true })
      const retryFolder = await core.system.folders.add({ server: 'nas', share: 'Retry', guest: true })
      if (!removeFolder.ok || !retryFolder.ok) throw new Error('Mock folders were not created')
      core.settings.update({ vpn: { locations: [{ id: 'loc-00000000', label: 'UK',
        nmUuid: '00000000-0000-0000-0000-000000000001', dns: null, addedAt: '2026-11-14T00:00:00Z' }],
        activeLocationId: 'loc-00000000' } })
      const args: Record<CallName, unknown[]> = {
        'folders.list': [], 'folders.discover': [], 'folders.listShares': [{ server: 'nas', guest: true }],
        'folders.add': [{ server: 'nas', share: 'Films', guest: true }],
        'folders.remove': [removeFolder.id], 'folders.retry': [retryFolder.id],
        'home.get': [], 'home.refresh': [], 'sources.list': [], 'sources.remove': ['remove-me'], 'sources.rename': ['demo', 'Our TV'],
        'libraries.list': [], 'libraries.browse': [library, { sort: 'title', offset: 0, limit: 20 }],
        'items.get': [key], 'items.children': [key], 'items.setWatched': [key, true], 'items.setFavourite': [key, true],
        'search.query': ['sky'], 'weather.search': ['London'], 'weather.get': [],
        'jellyfin.discover': [], 'jellyfin.probe': ['http://test'], 'jellyfin.quickConnect': ['http://test'],
        'jellyfin.password': ['http://test', 'guest', 'demo'], 'plex.pin': [], 'signin.poll': [quick.flowId],
        'signin.cancel': [quick.flowId], 'plex.addServers': [plex.flowId, ['home-plex']],
        'player.play': [key, { resume: false }], 'player.command': [{ kind: 'stop' }], 'player.state': [],
        'apps.list': [], 'apps.launch': ['youtube'], 'apps.close': [], 'apps.resetProfile': ['youtube'],
        'settings.get': [], 'settings.update': [{ deviceName: 'Test TV' }],
        'network.status': [], 'network.scan': [], 'network.connect': ['Home Wi-Fi', 'correct'], 'network.forget': ['home'],
        'network.profiles': [], 'network.applyIp': ['wifi:home', { method: 'auto', dns: { mode: 'auto' } }],
        'network.trial': [], 'network.keep': [], 'network.revert': [], 'network.resetAll': ['AUTOMATIC'],
        'audio.outputs': [], 'audio.setOutput': ['hdmi'], 'audio.volume': [], 'audio.setVolume': [50],
        'audio.setChannels': ['stereo'], 'audio.testTone': [], 'display.outputs': [],
        'display.setMode': ['HDMI-A-1', '1080p60'], 'display.setScale': ['HDMI-A-1', 1],
        'bluetooth.devices': [], 'bluetooth.scan': [true], 'bluetooth.pair': ['AA:BB:CC:00:00:02'],
        'bluetooth.remove': ['AA:BB:CC:00:00:02'], 'cec.status': [], 'cec.wakeTv': [], 'cec.standbyTv': [],
        'power.reboot': [], 'power.powerOff': [], 'power.screenOff': [], 'power.screenOn': [], 'time.get': [], 'time.zones': [],
        'time.setTimezone': ['Europe/London'], 'updates.check': [], 'updates.status': [], 'updates.apply': [],
        'updates.rollback': [], 'info.get': [], 'info.diagnostics': [],
        'shell.restart': [], 'shell.factoryReset': ['ERASE'], 'shell.reportIdle': [true], 'shell.notices': [],
        'vpn.status': [], 'vpn.setEnabled': [false], 'vpn.setLocation': ['loc-00000000'], 'vpn.removeLocation': ['loc-00000000'],
        'vpn.check': [], 'vpn.setAppVpn': ['iplayer', 'vpn-only'], 'vpn.setAllApps': ['direct'], 'vpn.startImport': [],
        'vpn.chooseImportEntry': ['any'], 'vpn.finishImport': ['UK'], 'vpn.cancelImport': [],
      }
      const seen = new Set<string>()
      for (const name of Object.keys(CALLS) as CallName[]) {
        if (name === 'network.applyIp') await core.system.network.connect('Home Wi-Fi', 'correct')
        if (name === 'network.keep') await vi.advanceTimersByTimeAsync(2000)
        const reply = await handleCall(core, name, args[name])
        expect(reply, name).toMatchObject({ ok: true })
        if (reply.ok && reply.value && typeof reply.value === 'object' && 'ok' in reply.value) {
          expect(reply.value, name).toMatchObject({ ok: true })
        }
        seen.add(name)
      }
      expect(seen.size).toBe(Object.keys(CALLS).length)
      expect(restartShell).toHaveBeenCalledTimes(2)
      expect(core.idle).toBe(true)
      expect(core.secrets.get('remove-me')).toBeUndefined()
      expect((await images.resolve('mediaos-img://img/missing/item/poster')).status).toBe(404)
      await expect(fs.stat(join(temp.dir, 'settings.json'))).rejects.toThrow()
      await expect(fs.stat(join(temp.dir, 'secrets.json'))).rejects.toThrow()
    } finally { await dispose(); await temp.dispose() }
  })
  it('rejects bad arguments and unknown calls, passes SourceError messages and hides unexpected errors', async () => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir, forceMockPlayer: true,
      mockDelayMs: 0, restartShell() {} })
    const { core } = composed
    try {
      const generic = 'Something went wrong. Try again, or restart MediaOS from Settings.'
      expect(await handleCall(core, 'not.a.call', [])).toEqual({ ok: false, error: generic })
      expect(await handleCall(core, 'audio.setVolume', [999])).toEqual({ ok: false, error: generic })
      expect(await handleCall(core, 'items.get', ['missing~id'])).toEqual({ ok: false, error: "That library isn't connected any more." })
      const dispatch = vi.spyOn(core, 'dispatch').mockRejectedValueOnce(new SourceError('Please sign in again.', 'auth'))
      expect(await handleCall(core, 'home.get', [])).toEqual({ ok: false, error: 'Please sign in again.' })
      dispatch.mockRejectedValueOnce(new UserFacingError("Updates aren't set up yet."))
      expect(await handleCall(core, 'updates.check', [])).toEqual({ ok: false, error: "Updates aren't set up yet." })
      dispatch.mockRejectedValueOnce(new Error('technical stack token=private'))
      expect(await handleCall(core, 'home.get', [])).toEqual({ ok: false,
        error: 'Something went wrong. Try again, or restart MediaOS from Settings.' })
    } finally { await composed.dispose() }
    try {
      const logs = await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')
      expect(logs).toContain('technical stack'); expect(logs).not.toContain('private')
    } finally { await temp.dispose() }
  })
  it('merges sparse settings without schema defaults resetting choices, sorts apps and forwards foreground/system events', async () => {
    vi.useFakeTimers()
    const temp = await temporary()
    let closed: (() => void) | undefined
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {}, openAppWindow: () => ({ close() {}, onClosed(cb) { closed = cb } }) })
    const { core } = composed
    const foreground: Foreground[] = [], changes: EventPayloads['system'][] = [], homeChanged = vi.fn()
    core.on('foreground', (f) => foreground.push(f)); core.on('system', (s) => changes.push(s)); core.on('homeChanged', homeChanged)
    try {
      core.settings.update({ home: { ...core.settings.get().home, rows: ['latest'], mergeContinue: false },
        apps: { ...core.settings.get().apps, pinned: ['prime', 'youtube'], hidden: ['netflix'] } })
      expect(await handleCall(core, 'settings.update', [{ home: { hero: false } }])).toMatchObject({ ok: true })
      expect(core.settings.get().home).toEqual({ ...defaultSettings().home, rows: ['latest'], mergeContinue: false, hero: false })
      expect((await core.dispatch('apps.list', [])).map((app) => app.id).slice(0, 2)).toEqual(['prime', 'youtube'])
      expect((await core.dispatch('apps.list', [])).some((app) => app.id === 'netflix')).toBe(true)
      const key = (await core.dispatch('home.get', [])).rows[0]!.items.find((i) => i.type === 'movie')!.key
      await core.dispatch('player.play', [key, { resume: false }]); expect(core.getForeground()).toEqual({ kind: 'player' })
      await vi.advanceTimersByTimeAsync(300)
      homeChanged.mockClear()
      await core.dispatch('player.command', [{ kind: 'stop' }])
      expect(core.getForeground()).toEqual({ kind: 'shell' })
      expect(homeChanged).toHaveBeenCalledTimes(1)
      await core.dispatch('apps.launch', ['youtube'])
      expect(core.player.state().status).toBe('idle'); expect(core.getForeground()).toEqual({ kind: 'app', appId: 'youtube' })
      closed!(); expect(core.getForeground()).toEqual({ kind: 'shell' }); expect(homeChanged).toHaveBeenCalled()
      await core.dispatch('network.connect', ['Home Wi-Fi', 'correct'])
      await core.dispatch('bluetooth.scan', [true]); expect(changes).toContainEqual({ what: 'network' })
      expect(changes).toContainEqual({ what: 'bluetooth' })
      await core.dispatch('updates.check', [])
      expect(changes.filter((change) => change.what === 'updates')).toEqual([{ what: 'updates' }, { what: 'updates' }])
      expect(foreground).toEqual([{ kind: 'player' }, { kind: 'shell' }, { kind: 'app', appId: 'youtube' }, { kind: 'shell' }])
    } finally { await composed.dispose(); await temp.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reopens saved fixture sources and emits the recovery notice exactly once when listeners attach', async () => {
    const temp = await temporary()
    const opts = { platform: 'mock' as const, dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} }
    let composed = await composeCore(opts)
    try {
      const added = await composed.core.signin.password('http://test', 'guest', 'demo')
      await composed.dispose(); composed = await composeCore(opts)
      expect(composed.core.hub.list().some((s) => s.id === added.id)).toBe(true)
      await composed.dispose()
      await fs.writeFile(join(temp.dir, 'settings.json'), 'broken', 'utf8')
      composed = await composeCore(opts)
      // Handed over once (when the screen asks), however early anything subscribed to events.
      const toast = vi.fn(); composed.core.on('toast', toast); await Promise.resolve()
      expect(toast).not.toHaveBeenCalled()
      const first = await handleCall(composed.core, 'shell.notices', [])
      expect(first).toMatchObject({ ok: true, value: [{ tone: 'warn', text: expect.stringContaining('damaged') }] })
      expect(await handleCall(composed.core, 'shell.notices', [])).toEqual({ ok: true, value: [] })
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('factory reset removes profiles, image cache, settings and secrets before invoking restart', async () => {
    const temp = await temporary()
    const restart = vi.fn()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, restartShell: restart })
    try {
      await fs.mkdir(join(temp.dir, 'chrome', 'youtube'), { recursive: true })
      await fs.writeFile(join(temp.dir, 'chrome', 'youtube', 'prefs'), 'profile', 'utf8')
      composed.core.settings.update({ deviceName: 'Reset me' })
      await composed.core.secrets.set('demo', { token: 'private' })
      await composed.core.dispatch('shell.factoryReset', ['ERASE'])
      expect(restart).toHaveBeenCalledOnce()
      for (const path of ['chrome', 'settings.json', 'secrets.json']) await expect(fs.stat(join(temp.dir, path))).rejects.toThrow()
      expect(await fs.readdir(join(temp.dir, 'images'))).toEqual([])
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('forwards trial changes and outcome toasts, and reverts before restarting', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), restart = vi.fn()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell: restart, netTrialSec: 3 })
    const { core } = composed, trial = vi.fn(), toast = vi.fn()
    core.on('netTrial', trial); core.on('toast', toast)
    const revert = vi.spyOn(core.system.network, 'revert')
    try {
      expect(await core.dispatch('network.applyIp', ['wired', { method: 'auto', dns: { mode: 'auto' } }])).toEqual({ ok: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(trial).toHaveBeenCalledWith({ trial: expect.objectContaining({ profileId: 'wired' }) })
      await core.dispatch('shell.restart', [])
      expect(revert).toHaveBeenCalledOnce(); expect(restart).toHaveBeenCalledOnce()
      expect(revert.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0]!)
      expect(await core.system.network.trial()).toBeNull()
      expect(trial).toHaveBeenLastCalledWith({ trial: null })
      expect(toast).toHaveBeenCalledWith({ id: expect.any(String), text: 'The old network settings are back.', tone: 'info' })
      await core.dispatch('network.applyIp', ['wired', { method: 'auto', dns: { mode: 'auto' } }])
      const expired = deferred<void>()
      core.on('toast', (value) => { if (value.text.startsWith('No answer')) expired.resolve() })
      await vi.advanceTimersByTimeAsync(3000)
      await expired.promise
      expect(await core.system.network.trial()).toBeNull()
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it.each(['power.reboot', 'power.powerOff', 'power.screenOff', 'updates.apply', 'updates.rollback'] as const)(
    'reverts a pending trial before %s', async (call) => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    const { core } = composed
    try {
      await core.system.network.applyIp('wired', { method: 'auto', dns: { mode: 'auto' } })
      const revert = vi.spyOn(core.system.network, 'revert')
      const action = call === 'updates.apply' || call === 'updates.rollback'
        ? vi.spyOn(core.system.updates, call === 'updates.apply' ? 'apply' : 'rollback').mockResolvedValue({ ok: true })
        : call === 'power.screenOff' ? vi.spyOn(core.system.display, 'power')
        : vi.spyOn(core.system.power, call === 'power.reboot' ? 'reboot' : 'powerOff')
      const flush = vi.spyOn(core.settings, 'flush')
      expect(await core.dispatch(call, [])).toEqual({ ok: true })
      expect(revert.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]!)
      expect(await core.system.network.trial()).toBeNull()
      if (call.startsWith('updates.')) {
        expect(flush).toHaveBeenCalledOnce()
        expect(revert.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]!)
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(action.mock.invocationCallOrder[0]!)
      }
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('switches the screen back on only after MediaOS switched it off, once per wake', async () => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    const { core } = composed
    try {
      const power = vi.spyOn(core.system.display, 'power')
      expect(await core.dispatch('power.screenOn', [])).toEqual({ ok: true })
      expect(power).not.toHaveBeenCalled()
      await core.dispatch('power.screenOff', [])
      power.mockClear()
      power.mockResolvedValueOnce({ ok: false, error: 'busy' })
      expect(await core.dispatch('power.screenOn', [])).toEqual({ ok: false, error: 'busy' })
      // Two presses together share one command, and a failed wake is retried by the next press.
      const [first, second] = await Promise.all([core.wakeScreen(), core.wakeScreen()])
      expect(first).toEqual({ ok: true })
      expect(second).toEqual({ ok: true })
      await core.wakeScreen()
      expect(power.mock.calls).toEqual([[true], [true]])
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('factory reset resets the network before settings, and failure blocks restart after erasing everything else', async () => {
    const temp = await temporary(), restart = vi.fn()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell: restart })
    const { core } = composed
    try {
      await core.system.network.applyIp('wired', { method: 'auto', dns: { mode: 'auto' } })
      const revert = vi.spyOn(core.system.network, 'revert')
      const reset = vi.spyOn(core.system.network, 'resetAll').mockResolvedValue({ ok: false, error: 'Reset failed' })
      const settings = vi.spyOn(core.settings, 'erase'), secrets = vi.spyOn(core.secrets, 'erase')
      await expect(core.dispatch('shell.factoryReset', ['ERASE'])).rejects.toThrow(
        "Everything else was erased, but the network settings couldn't be reset. " +
        'Hold Home, choose Reset network to automatic, then restart the box.')
      expect(revert.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]!)
      expect(reset.mock.invocationCallOrder[0]).toBeLessThan(settings.mock.invocationCallOrder[0]!)
      expect(settings).toHaveBeenCalledOnce(); expect(secrets).toHaveBeenCalledOnce(); expect(restart).not.toHaveBeenCalled()
      // Recovery and restart still work after SettingsStore has been erased.
      reset.mockRestore()
      expect(await core.dispatch('network.resetAll', ['AUTOMATIC'])).toEqual({ ok: true })
      expect(await core.dispatch('shell.restart', [])).toEqual({ ok: true }); expect(restart).toHaveBeenCalledOnce()
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('passes startup recovery notices through CoreOptions and shell.notices exactly once', async () => {
    const temp = await temporary()
    const options = { platform: 'mock' as const, dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} }
    let composed = await composeCore(options)
    try {
      await composed.core.system.network.applyIp('wired', { method: 'auto', dns: { mode: 'auto' } })
      await composed.dispose(); composed = await composeCore(options)
      expect(await composed.core.dispatch('shell.notices', [])).toEqual([{ id: expect.any(String), tone: 'warn',
        text: "The last network change wasn't confirmed, so MediaOS put the old settings back." }])
      expect(await composed.core.dispatch('shell.notices', [])).toEqual([])
      await expect(fs.stat(join(temp.dir, 'net-trial.json'))).rejects.toThrow()
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('drops stale asynchronous trial reads, catches errors and unsubscribes on disposal', async () => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    const base = composed.core
    base.dispose()
    let notify!: () => void
    const unTrial = vi.fn(), unToast = vi.fn(), log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    vi.spyOn(base.system.network, 'on').mockImplementation((event, cb) => {
      if (event === 'trial') { notify = cb; return unTrial }
      return () => undefined
    })
    vi.spyOn(base.system.network, 'onToast').mockReturnValue(unToast)
    const core = new Core({ hub: base.hub, settings: base.settings, secrets: base.secrets, player: base.player,
      apps: base.apps, vpn: base.vpn, system: base.system, signin: base.signin, logger: log,
      restartShell() {}, clearCaches: async () => undefined,
      notices: ['Extra notice.'] })
    const event = vi.fn(); core.on('netTrial', event)
    const first = deferred<Awaited<ReturnType<typeof base.system.network.trial>>>()
    const read = vi.spyOn(base.system.network, 'trial').mockReturnValueOnce(first.promise).mockResolvedValueOnce(null)
    try {
      notify(); notify(); await Promise.resolve()
      expect(event).toHaveBeenCalledOnce(); expect(event).toHaveBeenLastCalledWith({ trial: null })
      first.resolve({ profileId: 'old', name: 'Old', phase: 'checking', secondsLeft: 42,
        router: 'checking', dns: 'checking', internet: 'checking', canKeep: false })
      await Promise.resolve(); expect(event).toHaveBeenCalledOnce()
      read.mockRejectedValueOnce(new Error('Failed read')); notify()
      await Promise.resolve(); await Promise.resolve(); expect(log.warn).toHaveBeenCalledOnce()
      expect(await core.dispatch('shell.notices', [])).toEqual([{ id: expect.any(String), tone: 'warn', text: 'Extra notice.' }])
      const late = deferred<null>(); read.mockReturnValueOnce(late.promise); notify()
      core.dispose(); late.resolve(null); await Promise.resolve()
      expect(event).toHaveBeenCalledOnce(); expect(unTrial).toHaveBeenCalledOnce(); expect(unToast).toHaveBeenCalledOnce()
    } finally { core.dispose(); await composed.dispose(); await temp.dispose() }
  })
  it('continues restarting after a revert error or its ten-second deadline', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), restart = vi.fn()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell: restart })
    const { core } = composed
    try {
      await core.system.network.applyIp('wired', { method: 'auto', dns: { mode: 'auto' } })
      const revert = vi.spyOn(core.system.network, 'revert').mockRejectedValueOnce(new Error('Failed'))
      expect(await core.dispatch('shell.restart', [])).toEqual({ ok: true })
      const pending = deferred<{ ok: true }>(); revert.mockReturnValueOnce(pending.promise)
      const second = core.dispatch('shell.restart', [])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await second).toEqual({ ok: true }); expect(restart).toHaveBeenCalledTimes(2)
      pending.resolve({ ok: true }); revert.mockRestore()
    } finally { await composed.dispose(); await temp.dispose() }
  })
})

describe('Core TV power', () => {
  async function make(options: { bootOnce?: (key: string) => Promise<boolean> } = {}) {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir,
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    const base = composed.core
    base.dispose()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const core = new Core({ ...base, logger, ...options, timers: runtime,
      restartShell() {}, clearCaches: async () => undefined })
    return { core, logger, dispose: async () => { core.dispose(); await composed.dispose(); await temp.dispose() } }
  }
  it('wakes once per Core start and consults the boot marker once', async () => {
    const bootOnce = vi.fn(async () => true), { core, dispose } = await make({ bootOnce })
    const wake = vi.spyOn(core.system.cec, 'wakeTv')
    try {
      await Promise.all([core.start(), core.start()]); await core.start()
      expect(wake).toHaveBeenCalledOnce(); expect(bootOnce).toHaveBeenCalledExactlyOnceWith('tv-woken')
    } finally { await dispose() }
  })
  it.each(['boot-used', 'disabled', 'no-option'])('honours boot state and settings: %s', async (mode) => {
    const bootOnce = vi.fn(async () => mode !== 'boot-used')
    const { core, dispose } = await make(mode === 'no-option' ? {} : { bootOnce })
    const wake = vi.spyOn(core.system.cec, 'wakeTv')
    try {
      if (mode === 'disabled') core.settings.update({ cec: { wakeTvOnStart: false, standbyTvOnPowerOff: true } })
      await core.start()
      expect(wake).toHaveBeenCalledTimes(mode === 'no-option' ? 1 : 0)
      if (mode === 'disabled') expect(bootOnce).not.toHaveBeenCalled()
    } finally { await dispose() }
  })
  it.each(['absent', 'failed', 'throw', 'boot-throw'])('contains startup failures and logs appropriately: %s', async (mode) => {
    const { core, logger, dispose } = await make({ bootOnce: async () => {
      if (mode === 'boot-throw') throw new Error('marker failed')
      return true
    } })
    const error = mode === 'absent' ? 'No TV remote adapter is connected.' : 'TV failed'
    const wake = vi.spyOn(core.system.cec, 'wakeTv')
    if (mode === 'throw') wake.mockRejectedValue(new Error('runner failed'))
    else wake.mockResolvedValue({ ok: false, error })
    try {
      await expect(core.start()).resolves.toBeUndefined()
      expect(mode === 'absent' ? logger.debug : logger.warn).toHaveBeenCalledOnce()
      if (mode === 'absent') expect(logger.warn).not.toHaveBeenCalled()
    } finally { await dispose() }
  })
  it.each(['ok', 'fail', 'throw', 'timeout'])('puts the TV on standby before powering off (%s)', async (mode) => {
    vi.useFakeTimers()
    const { core, logger, dispose } = await make(), pending = deferred<{ ok: true }>()
    const order: string[] = []
    const standby = vi.spyOn(core.system.cec, 'standbyTv').mockImplementation(async () => {
      order.push('standby')
      if (mode === 'timeout') return pending.promise
      if (mode === 'throw') throw new Error('failed')
      return mode === 'fail' ? { ok: false, error: 'TV failed' } : { ok: true }
    })
    const power = vi.spyOn(core.system.power, 'powerOff').mockImplementation(async () => {
      order.push('poweroff'); return { ok: true }
    })
    try {
      const result = core.dispatch('power.powerOff', [])
      if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(2999); expect(power).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(await result).toEqual({ ok: true })
      expect(standby).toHaveBeenCalledOnce(); expect(order).toEqual(['standby', 'poweroff'])
      if (mode !== 'ok') expect(logger.warn).toHaveBeenCalled()
    } finally { pending.resolve({ ok: true }); await dispose() }
  })
  it('respects the standby setting and never puts the TV on standby for reboot', async () => {
    const { core, dispose } = await make(), standby = vi.spyOn(core.system.cec, 'standbyTv')
    try {
      await core.dispatch('power.reboot', []); expect(standby).not.toHaveBeenCalled()
      core.settings.update({ cec: { wakeTvOnStart: true, standbyTvOnPowerOff: false } })
      await core.dispatch('power.powerOff', []); expect(standby).not.toHaveBeenCalled()
    } finally { await dispose() }
  })
  it('wakes the TV after the display succeeds without waiting or changing its result', async () => {
    const { core, dispose } = await make(), pending = deferred<{ ok: true }>(), order: string[] = []
    const wake = vi.spyOn(core.system.cec, 'wakeTv').mockImplementation(() => { order.push('tv'); return pending.promise })
    try {
      await core.wakeScreen(); expect(wake).not.toHaveBeenCalled()
      await core.dispatch('power.screenOff', [])
      const display = deferred<{ ok: true }>(), result = { ok: true } as const
      vi.spyOn(core.system.display, 'power').mockImplementation(async () => {
        await display.promise; order.push('display'); return result
      })
      const waking = core.wakeScreen(); expect(wake).not.toHaveBeenCalled()
      display.resolve(result)
      expect(await waking).toBe(result); expect(order).toEqual(['display', 'tv'])
      await core.wakeScreen(); expect(wake).toHaveBeenCalledOnce()
    } finally { pending.resolve({ ok: true }); await dispose() }
  })
  it('keeps a failed display result and contains a later TV wake rejection', async () => {
    const { core, logger, dispose } = await make(), wake = vi.spyOn(core.system.cec, 'wakeTv')
    try {
      await core.dispatch('power.screenOff', [])
      const result = { ok: false, error: 'display failed' } as const
      const power = vi.spyOn(core.system.display, 'power').mockResolvedValueOnce(result)
      expect(await core.wakeScreen()).toBe(result); expect(wake).not.toHaveBeenCalled()
      power.mockResolvedValueOnce({ ok: true }); wake.mockRejectedValueOnce(new Error('TV failed'))
      expect(await core.wakeScreen()).toEqual({ ok: true })
      expect(logger.warn).toHaveBeenCalledWith('TV could not be woken', expect.any(Error))
    } finally { await dispose() }
  })
})

describe('ActionRouter', () => {
  function make(backend: 'mpv' | 'mock' = 'mpv') {
    let foreground: Foreground = { kind: 'shell' }
    const commands: PlayerCommand[] = [], events: { name: string; value: unknown }[] = []
    const player: PlayerController = { state: () => ({ backend } as PlayerState),
      command: vi.fn(async (cmd) => { commands.push(cmd) }), stop: vi.fn(async () => undefined),
      play: vi.fn(async () => undefined), onState: () => () => undefined, dispose: async () => undefined }
    const apps: AppHost = { close: vi.fn(async () => undefined), launch: async () => undefined,
      running: () => undefined, resetProfile: async () => undefined, onExit: () => () => undefined }
    const setForeground = (value: Foreground) => { foreground = value }
    const router = new ActionRouter({ player, apps, foreground: () => foreground, setForeground,
      playbackSettings: () => ({ skipBackSec: 15, skipForwardSec: 45 }), emit: (name, value) => events.push({ name, value }) })
    return { router, commands, events, player, apps, setForeground, foreground: () => foreground }
  }
  it('forwards shell actions and always emits recovery', async () => {
    const ctx = make(); await ctx.router.route('back', true)
    expect(ctx.events).toEqual([{ name: 'action', value: { action: 'back', long: true } }])
    ctx.setForeground({ kind: 'app', appId: 'youtube' }); await ctx.router.route('recovery')
    expect(ctx.events.at(-1)).toEqual({ name: 'recovery', value: {} })
    expect(ctx.apps.close).toHaveBeenCalledOnce(); expect(ctx.foreground().kind).toBe('shell')
    ctx.setForeground({ kind: 'player' }); await ctx.router.route('recovery')
    expect(ctx.player.stop).toHaveBeenCalledOnce(); expect(ctx.events.filter((e) => e.name === 'recovery')).toHaveLength(2)
  })
  it('maps mpv playback and skips using configured durations; Home and Back stop and restore the shell', async () => {
    const ctx = make(); ctx.setForeground({ kind: 'player' })
    await ctx.router.route('playPause'); await ctx.router.route('rewind'); await ctx.router.route('fastForward')
    expect(ctx.commands).toEqual([{ kind: 'togglePause' }, { kind: 'seekRelative', seconds: -15 }, { kind: 'seekRelative', seconds: 45 }])
    ctx.commands.length = 0
    await ctx.router.route('select'); await ctx.router.route('left'); await ctx.router.route('right'); await ctx.router.route('up')
    expect(ctx.commands).toEqual([{ kind: 'togglePause' }, { kind: 'seekRelative', seconds: -15 }, { kind: 'seekRelative', seconds: 45 }])
    await ctx.router.route('home'); expect(ctx.player.stop).toHaveBeenCalledOnce(); expect(ctx.foreground().kind).toBe('shell')
    ctx.setForeground({ kind: 'player' }); await ctx.router.route('back'); expect(ctx.player.stop).toHaveBeenCalledTimes(2)
    const mock = make('mock'); mock.setForeground({ kind: 'player' }); await mock.router.route('playPause')
    expect(mock.commands).toEqual([])
  })
  it('closes apps on Home or long Back and ignores ordinary app keys', async () => {
    const ctx = make(); ctx.setForeground({ kind: 'app', appId: 'youtube' })
    await ctx.router.route('back'); await ctx.router.route('select'); expect(ctx.apps.close).not.toHaveBeenCalled()
    await ctx.router.route('back', true); expect(ctx.apps.close).toHaveBeenCalledOnce()
    ctx.setForeground({ kind: 'app', appId: 'youtube' }); await ctx.router.route('home')
    expect(ctx.apps.close).toHaveBeenCalledTimes(2); expect(ctx.foreground().kind).toBe('shell')
  })
})
