import type { IpConfig, NetProfile, NetStatus, Result, WifiAp } from '@shared/system-types'
import { dnsPreset } from '@shared/dns-presets'
import type { TrialBackend } from '../net/IpTrial'
import { APPLY_DEADLINE_MS } from '../net/IpTrial'
import { addressInUse } from '../net/texts'

interface Snapshot { profileId: string; config: IpConfig; saved: IpConfig; status: NetStatus }
interface Options {
  wifi: WifiAp[]
  status(): NetStatus
  setStatus(status: NetStatus): void
  changed(): void
  wait(ms: number): Promise<void>
  delayMs?: number
  unmanaged?: boolean
}
const automatic = (): IpConfig => ({ method: 'auto', dns: { mode: 'auto' } })
const ok: Result = { ok: true }

/** In-memory NetworkManager stand-in. Saved properties are separate from temporary live properties. */
export class MockTrialBackend implements TrialBackend {
  private configs = new Map<string, IpConfig>([['wired', automatic()]])
  private saved = new Map<string, IpConfig>([['wired', automatic()]])
  private checkpoints = new Map<string, Snapshot>()
  private serial = 0

  constructor(private opts: Options) {
    for (const ap of opts.wifi.filter((ap) => ap.known)) this.ensure(`wifi:${ap.id}`)
  }

  private ensure(id: string): IpConfig {
    if (!this.configs.has(id)) { this.configs.set(id, automatic()); this.saved.set(id, automatic()) }
    return this.configs.get(id)!
  }

  async profiles(): Promise<NetProfile[]> {
    const status = this.opts.status()
    const profiles: NetProfile[] = [{ id: 'wired', name: 'Cable', kind: 'ethernet', active: status.profileId === 'wired',
      editable: !this.opts.unmanaged, ...(this.opts.unmanaged ? {
        why: "This connection is set up outside MediaOS, so its settings can't be changed here.",
      } : {}) }]
    for (const ap of this.opts.wifi.filter((ap) => ap.known)) {
      profiles.push({ id: `wifi:${ap.id}`, name: ap.ssid, kind: 'wifi', active: status.profileId === `wifi:${ap.id}`, editable: true })
    }
    return profiles.map((profile) => ({ ...profile, config: structuredClone(this.ensure(profile.id)),
      ...(profile.active && status.ip ? { live: { address: status.ip, prefix: status.prefix ?? 24,
        gateway: status.gateway, dns: [...status.dns ?? []] } } : {}) }))
  }

  async snapshot(profileId: string): Promise<unknown> {
    this.ensure(profileId)
    return structuredClone({ profileId, config: this.configs.get(profileId)!, saved: this.saved.get(profileId)!,
      status: this.opts.status() } satisfies Snapshot)
  }
  async begin(profileId: string, _timeoutSec: number): Promise<string> {
    const handle = `mock-cp-${++this.serial}`
    this.checkpoints.set(handle, await this.snapshot(profileId) as Snapshot)
    return handle
  }
  /** Reconnecting uses the settings already kept for this profile. The caller owns the queue. */
  activate(profileId: string): Promise<Result> {
    return this.applyTemporary(profileId, structuredClone(this.ensure(profileId)), APPLY_DEADLINE_MS)
  }
  async applyTemporary(profileId: string, cfg: IpConfig, _deadlineMs: number): Promise<Result> {
    if (cfg.method === 'manual' && cfg.address === '192.168.1.7') {
      return { ok: false, error: addressInUse(cfg.address) }
    }
    this.configs.set(profileId, structuredClone(cfg))
    const old = this.opts.status()
    const gateway = cfg.method === 'manual' ? cfg.gateway : '192.168.1.1'
    const dns = cfg.dns.mode === 'custom' ? [...cfg.dns.servers]
      : cfg.dns.mode === 'preset' ? [...dnsPreset(cfg.dns.preset).ipv4] : [gateway]
    this.opts.setStatus({ ...old, connected: true, profileId, method: cfg.method,
      prefix: cfg.method === 'manual' ? cfg.prefix : 24,
      ip: cfg.method === 'manual' ? cfg.address : old.kind === 'wifi' ? '192.168.1.43' : '192.168.1.42',
      gateway, dns, internet: this.routerWorks(cfg) && this.dnsWorks(cfg) })
    this.opts.changed()
    return ok
  }
  checks(cfg: IpConfig): ReturnType<TrialBackend['checks']> {
    const check = async (ms: number, passed: boolean): Promise<boolean> => {
      await this.opts.wait(this.opts.delayMs === undefined ? ms : ms * this.opts.delayMs / 350)
      return passed
    }
    const router = this.routerWorks(cfg), dns = router && this.dnsWorks(cfg)
    return { router: () => check(1000, router), dns: () => check(1500, dns), internet: () => check(2000, dns) }
  }
  private routerWorks(cfg: IpConfig): boolean {
    return cfg.method === 'auto' || cfg.prefix === 24 && cfg.address.startsWith('192.168.1.') && cfg.gateway === '192.168.1.1'
  }
  private dnsWorks(cfg: IpConfig): boolean { return cfg.dns.mode !== 'custom' || !cfg.dns.servers.includes('192.0.2.53') }

  async commit(handle: string): Promise<'ok' | 'gone'> { return this.checkpoints.delete(handle) ? 'ok' : 'gone' }
  async clearCheckpoints(): Promise<void> { this.checkpoints.clear() }
  async save(profileId: string): Promise<Result> {
    this.saved.set(profileId, structuredClone(this.ensure(profileId))); this.opts.changed(); return ok
  }
  async unsaved(profileId: string): Promise<boolean> { return !equal(this.ensure(profileId), this.saved.get(profileId)) }
  async rollback(handle: string): Promise<'ok' | 'gone'> {
    const before = this.checkpoints.get(handle)
    if (!before) return 'gone'
    this.checkpoints.delete(handle)
    await this.restore(before)
    return 'ok'
  }
  async alive(handle: string): Promise<boolean> { return this.checkpoints.has(handle) }
  async restore(snapshot: unknown): Promise<Result> {
    const before = structuredClone(snapshot) as Snapshot
    this.configs.set(before.profileId, before.config)
    this.saved.set(before.profileId, before.saved)
    this.opts.setStatus(before.status)
    for (const ap of this.opts.wifi) ap.active = before.status.profileId === `wifi:${ap.id}`
    this.opts.changed()
    return ok
  }
  async matches(snapshot: unknown): Promise<boolean> {
    const before = snapshot as Snapshot
    return !await this.unsaved(before.profileId) &&
      equal(this.ensure(before.profileId), before.config) && equal(this.saved.get(before.profileId), before.saved) &&
      equal(this.opts.status(), before.status)
  }
  async resetAll(): Promise<Result> {
    for (const profile of await this.profiles()) this.ensure(profile.id)
    for (const id of this.configs.keys()) { this.configs.set(id, automatic()); this.saved.set(id, automatic()) }
    this.checkpoints.clear()
    // NetworkManager reconnects whatever is connected now, with the automatic settings; it doesn't switch networks.
    const current = this.opts.status().profileId
    if (current) return this.activate(current)
    this.opts.changed()
    return ok
  }
  /** Test hook for NetworkManager losing its checkpoints while temporary properties stay live. */
  simulateRestart(): void { this.checkpoints.clear(); this.opts.changed() }
}

function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
