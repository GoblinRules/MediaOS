import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpConfig, NetStatus, WifiAp } from '@shared/system-types'
import { createMockSystem, type MockSystemOptions } from '../../src/main/system/mock/MockSystemServices'
import { MockTrialBackend } from '../../src/main/system/mock/MockTrialBackend'
import { runtime, delay } from '../../src/main/core/runtime'

const good: IpConfig = { method: 'manual', address: '192.168.1.60', prefix: 24, gateway: '192.168.1.1', dns: { mode: 'router' } }
const systems: ReturnType<typeof createMockSystem>[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const system of systems.splice(0)) system.dispose(); vi.useRealTimers() })
function make(options: MockSystemOptions = {}) {
  const system = createMockSystem({ clock: runtime, ...options }); systems.push(system); return system
}

describe('mock trial network', () => {
  it('provides active profiles and a detached live view, and checks at 1, 1.5 and 2 seconds', async () => {
    const system = make(), changed = vi.fn(), trials = vi.fn()
    system.network.on('changed', changed); system.network.on('trial', trials)
    expect(await system.network.status()).toMatchObject({ method: 'auto', prefix: 24, profileId: 'wired' })
    const profiles = await system.network.profiles()
    expect(profiles).toMatchObject([{ id: 'wired', name: 'Cable', kind: 'ethernet', active: true,
      config: { method: 'auto', dns: { mode: 'auto' } }, live: { address: '192.168.1.42', prefix: 24 } },
    { id: 'wifi:home', name: 'Home Wi-Fi', active: false }])
    profiles[0]!.live!.dns.push('8.8.8.8')
    expect((await system.network.status()).dns).toEqual(['192.168.1.1'])
    expect(await system.network.applyIp('wired', good)).toEqual({ ok: true })
    expect(await system.network.status()).toMatchObject({ method: 'manual', ip: '192.168.1.60', internet: true, prefix: 24 })
    expect(await system.network.trial()).toMatchObject({ router: 'checking', dns: 'checking', internet: 'checking' })
    await vi.advanceTimersByTimeAsync(999)
    expect(await system.network.trial()).toMatchObject({ router: 'checking' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await system.network.trial()).toMatchObject({ router: 'ok', dns: 'checking', internet: 'checking', canKeep: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(await system.network.trial()).toMatchObject({ dns: 'ok', internet: 'checking' })
    await vi.advanceTimersByTimeAsync(500)
    expect(await system.network.trial()).toMatchObject({ internet: 'ok', phase: 'ready', canKeep: true })
    expect(await system.network.keep()).toEqual({ ok: true })
    expect((await system.network.profiles())[0]).toMatchObject({ config: good, live: { address: '192.168.1.60' } })
    expect(changed).toHaveBeenCalled(); expect(trials).toHaveBeenCalled()
  })
  it('reports the address clash and leaves status and configuration unchanged', async () => {
    const system = make(), before = await system.network.status()
    expect(await system.network.applyIp('wired', { ...good, address: '192.168.1.7' } as IpConfig)).toEqual({ ok: false,
      error: 'Another device on your network is already using 192.168.1.7. Choose a different number for the last part.' })
    expect(await system.network.status()).toEqual(before)
    expect((await system.network.profiles())[0]!.config).toEqual({ method: 'auto', dns: { mode: 'auto' } })
    expect(await system.network.trial()).toBeNull()
  })
  it.each([
    { method: 'manual', address: '10.0.0.20', prefix: 24, gateway: '10.0.0.1', dns: { mode: 'router' } },
    { method: 'manual', address: '192.168.1.60', prefix: 24, gateway: '192.168.1.2', dns: { mode: 'router' } },
  ] satisfies IpConfig[])('fails all checks with unreachable address or router: $gateway', async (config) => {
    const system = make()
    expect(await system.network.applyIp('wired', config)).toEqual({ ok: true })
    expect(await system.network.status()).toMatchObject({ connected: true, ip: config.address, internet: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await system.network.trial()).toMatchObject({ router: 'failed', dns: 'failed', internet: 'failed', canKeep: false })
    expect(await system.network.revert()).toEqual({ ok: true })
    expect(await system.network.status()).toMatchObject({ ip: '192.168.1.42', method: 'auto', internet: true })
  })
  it('allows Keep with broken custom DNS and restores the default lease on reset', async () => {
    const system = make()
    await system.network.applyIp('wired', { ...good, dns: { mode: 'custom', servers: ['192.0.2.53'] } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await system.network.trial()).toMatchObject({ router: 'ok', dns: 'failed', internet: 'failed', canKeep: true })
    expect(await system.network.keep()).toEqual({ ok: true })
    expect(await system.network.resetAll()).toEqual({ ok: true })
    expect(await system.network.status()).toMatchObject({ method: 'auto', ip: '192.168.1.42', prefix: 24, profileId: 'wired' })
    expect((await system.network.profiles()).every((p) => p.config?.method === 'auto' && p.config.dns.mode === 'auto')).toBe(true)
  })
  it('connects Wi-Fi, makes wired inactive, and keeps each profile configuration separately', async () => {
    const system = make({ delayMs: 0 })
    await system.network.applyIp('wired', good); await vi.advanceTimersByTimeAsync(2000); await system.network.keep()
    expect(await system.network.connect('Home Wi-Fi', 'correct')).toEqual({ ok: true })
    expect(await system.network.profiles()).toMatchObject([{ id: 'wired', active: false, config: good },
      { id: 'wifi:home', active: true, config: { method: 'auto', dns: { mode: 'auto' } }, live: { address: '192.168.1.43' } }])
    expect((await system.network.profiles())[0]!.live).toBeUndefined()
    expect(await system.network.status()).toMatchObject({ profileId: 'wifi:home', method: 'auto', prefix: 24 })
    expect(await system.network.applyIp('wired', good)).toEqual({ ok: false,
      error: 'Connect to Cable first, then change its IP settings.' })
    await system.network.applyIp('wifi:home', { method: 'auto', dns: { mode: 'preset', preset: 'cloudflare' } })
    await vi.advanceTimersByTimeAsync(2000); await system.network.keep()
    expect((await system.network.status()).dns).toEqual(['1.1.1.1', '1.0.0.1'])
    await system.network.resetAll()
    expect((await system.network.profiles()).every((p) => p.config?.method === 'auto' && p.config.dns.mode === 'auto')).toBe(true)
    // Reset keeps the box on the network it is using now.
    expect(await system.network.status()).toMatchObject({ profileId: 'wifi:home', method: 'auto', dns: ['192.168.1.1'] })
    expect((await system.network.scanWifi()).find((ap) => ap.id === 'home')!.known).toBe(true)
  })
  it.each(['wifiOnly', 'offline'] as const)('makes wired inactive in %s', async (scenario) => {
    const system = make({ scenario })
    expect((await system.network.profiles())[0]!.active).toBe(false)
    expect((await system.network.status()).connected).toBe(false)
  })
  it('reactivates the kept configuration when reconnecting to a saved Wi-Fi profile', async () => {
    const system = make({ delayMs: 0 })
    await system.network.connect('Home Wi-Fi', 'correct')
    await system.network.applyIp('wifi:home', good)
    await vi.advanceTimersByTimeAsync(2000); await system.network.keep()
    await system.network.connect('Garden office', 'correct')
    expect(await system.network.status()).toMatchObject({ profileId: 'wifi:garden', method: 'auto', ip: '192.168.1.43' })
    await system.network.connect('Home Wi-Fi', 'correct')
    expect(await system.network.status()).toMatchObject({ profileId: 'wifi:home', method: 'manual', ip: '192.168.1.60' })
    expect((await system.network.profiles()).find((p) => p.id === 'wifi:home')).toMatchObject({ config: good,
      active: true, live: { address: '192.168.1.60' } })
  })
  it('refuses unmanaged wired profiles with their explanation', async () => {
    const system = make({ scenario: 'netUnmanaged' })
    const why = "This connection is set up outside MediaOS, so its settings can't be changed here."
    expect((await system.network.profiles())[0]).toMatchObject({ editable: false, why })
    expect(await system.network.applyIp('wired', good)).toEqual({ ok: false, error: why })
  })
  it('uses the explicit delay scale, expires the trial and disposes pending checks', async () => {
    const system = make({ delayMs: 35, trialSec: 3 }), changed = vi.fn(), trial = vi.fn()
    system.network.on('changed', changed); system.network.on('trial', trial)
    await system.network.applyIp('wired', good)
    await vi.advanceTimersByTimeAsync(200)
    expect(await system.network.trial()).toMatchObject({ phase: 'ready', canKeep: false })
    await vi.advanceTimersByTimeAsync(2800)
    expect(await system.network.trial()).toBeNull(); expect(changed).toHaveBeenCalledTimes(2)
    const count = trial.mock.calls.length
    await system.network.applyIp('wired', good); system.dispose()
    const afterDispose = trial.mock.calls.length
    await vi.advanceTimersByTimeAsync(100_000)
    expect(trial).toHaveBeenCalledTimes(afterDispose); expect(afterDispose).toBeGreaterThan(count)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('MockTrialBackend checkpoints', () => {
  it('deep-copies snapshots, tracks saved properties, handles missing handles and simulates restart', async () => {
    let status: NetStatus = { connected: true, kind: 'ethernet', profileId: 'wired', method: 'auto', prefix: 24,
      ip: '192.168.1.42', gateway: '192.168.1.1', dns: ['192.168.1.1'], internet: true }
    const wifi: WifiAp[] = [], changed = vi.fn()
    const backend = new MockTrialBackend({ wifi, status: () => status, setStatus: (value) => { status = value },
      changed, wait: (ms) => delay(ms) })
    const before = await backend.snapshot('wired')
    const handle = await backend.begin('wired', 90)
    await backend.applyTemporary('wired', good, 30_000)
    expect(await backend.unsaved('wired')).toBe(true); expect(await backend.matches(before)).toBe(false)
    expect(await backend.alive(handle)).toBe(true)
    backend.simulateRestart(); expect(await backend.alive(handle)).toBe(false)
    expect(await backend.commit(handle)).toBe('gone'); expect(await backend.rollback(handle)).toBe('gone')
    expect(status.ip).toBe('192.168.1.60')
    await backend.restore(before)
    expect(await backend.matches(before)).toBe(true); expect(await backend.unsaved('wired')).toBe(false)
    status.dns!.push('8.8.8.8'); expect(await backend.matches(before)).toBe(false)
    await backend.restore(before); expect(status.dns).toEqual(['192.168.1.1'])
    const next = await backend.begin('wired', 90); expect(next).not.toBe(handle)
    await backend.applyTemporary('wired', good, 30_000); await backend.commit(next); await backend.save('wired')
    expect(await backend.unsaved('wired')).toBe(false); expect(await backend.alive(next)).toBe(false)
    await backend.resetAll(); expect(await backend.unsaved('wired')).toBe(false); expect(await backend.matches(before)).toBe(true)
  })
})
