import type { IpConfig, NetStatus, Result, WifiAp } from '@shared/system-types'
import type { SystemServices, Unsub } from '../SystemServices'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import type { FileSystem } from '../../settings/atomic'
import { IpTrial } from '../net/IpTrial'
import { NetQueue } from '../net/NetQueue'
import { memoryJournal } from '../net/MemoryJournal'
import { WIFI_NOT_READY } from '../net/texts'
import { NmBackend, type NmOptions } from './NmBackend'
import { NodeCommandRunner } from './CommandRunner'
import type { CommandRunner } from './CommandRunner'
import { profileKind, rows } from './nmcli-parse'

type Network = SystemServices['network']
export interface LinuxNetworkOptions extends Omit<NmOptions, 'runner'> {
  runner?: CommandRunner
  logger?: Log
  journal?: string
  fs?: FileSystem
  trialSec?: number
  queue?: NetQueue
}
export class LinuxNetwork implements Network {
  private readonly backend: NmBackend
  private readonly clock: Runtime
  private readonly logger: Log
  private readonly runner: CommandRunner
  private readonly queue: NetQueue
  private readonly ipTrial: IpTrial
  private listeners = new Set<() => void>()
  private monitor?: { kill(): void }
  private debounce?: ReturnType<typeof setTimeout>
  private restart?: ReturnType<typeof setTimeout>
  private backoff = 1000
  private disposed = false
  private internet = false
  private lastCheck = -Infinity
  private lastUplink = ''
  private readonly monotonic: () => number
  private checking?: Promise<void>
  private recheck?: { dev: string; address?: string }

  constructor(opts: LinuxNetworkOptions) {
    this.queue = opts.queue ?? new NetQueue()
    this.clock = opts.clock ?? runtime
    this.monotonic = opts.monotonic ?? (() => performance.now())
    this.logger = opts.logger ?? silentLog
    this.runner = opts.runner ?? new NodeCommandRunner(this.logger)
    this.backend = new NmBackend({ ...opts, runner: this.runner, clock: this.clock })
    this.ipTrial = new IpTrial({ backend: this.backend, queue: this.queue, clock: this.clock, logger: this.logger,
      journalPath: opts.journal ?? 'net-trial.json', fs: opts.fs ?? (opts.journal ? undefined : memoryJournal()),
      trialSec: opts.trialSec, monotonic: opts.monotonic })
    this.startMonitor()
  }
  private startMonitor(): void {
    if (this.disposed) return
    this.monitor = this.runner.spawnLines('nmcli', ['monitor'], () => {
      if (this.disposed) return
      this.backoff = 1000
      if (this.debounce !== undefined) this.clock.clearTimeout(this.debounce)
      this.debounce = this.clock.setTimeout(() => {
        this.debounce = undefined
        this.changed()
        void this.queue.run(() => this.refreshInternet()).catch(() => undefined)
      }, 500)
    }, () => {
      if (this.disposed) return
      this.monitor = undefined
      this.restart = this.clock.setTimeout(() => { this.restart = undefined; this.startMonitor() }, this.backoff)
      this.backoff = Math.min(30000, this.backoff * 2)
    })
  }
  private changed(): void {
    if (this.disposed) return
    for (const cb of this.listeners) {
      try { cb() } catch (error) { this.logger.warn('Network listener failed', error) }
    }
  }
  private async refreshInternet(dev?: string, address?: string): Promise<void> {
    if (this.disposed) return
    if (!dev) {
      const uplink = await this.backend.uplink()
      if (!uplink) { this.offline(); return }
      dev = uplink.device
      address = (await this.backend.live(dev)).live?.address
    }
    const key = JSON.stringify([dev, address])
    if (this.checking) {
      this.recheck = key !== this.lastUplink ? { dev, address } : undefined
      return this.checking
    }
    if (key === this.lastUplink && this.monotonic() - this.lastCheck < 60000) return
    this.lastUplink = key
    this.lastCheck = this.monotonic()
    this.checking = this.backend.internet().then((value) => { this.internet = value }, () => { this.internet = false })
      .finally(() => {
        this.checking = undefined
        const owed = this.recheck
        this.recheck = undefined
        if (owed) return this.refreshInternet(owed.dev, owed.address)
      })
    return this.checking
  }
  private offline(): NetStatus {
    this.lastUplink = ''; this.internet = false
    return { connected: false, kind: 'none', internet: false }
  }
  status(): Promise<NetStatus> {
    return this.queue.run(async () => {
      try {
        const uplink = await this.backend.uplink()
        if (!uplink) return this.offline()
        const p = (await this.backend.connections()).find((p) => p.active && p.device === uplink.device)
        const kind = p && profileKind(p.type)
        if (!p || !kind) return this.offline()
        const current = await this.backend.live(uplink.device), settings = await this.backend.settings(p.uuid)
        const method = settings['ipv4.method']
        await this.refreshInternet(uplink.device, current.live?.address)
        return { connected: !!current.live, kind, ssid: kind === 'wifi' ? settings['802-11-wireless.ssid'] || p.name : undefined,
          ip: current.live?.address, gateway: current.live?.gateway, dns: current.live?.dns, mac: current.mac,
          internet: !!current.live && this.internet, method: method === 'auto' || method === 'manual' ? method : 'other',
          prefix: current.live?.prefix, profileId: p.uuid }
      } catch (error) {
        this.logger.warn('Network status unavailable', error)
        return this.offline()
      }
    })
  }
  scanWifi(): Promise<WifiAp[]> {
    return this.queue.run(async () => {
      const text = await this.backend.nmRead('IN-USE,SIGNAL,SSID,SECURITY', ['device', 'wifi', 'list', '--rescan', 'auto'])
      if (!text.trim()) return []
      const profiles = (await this.backend.profiles()).filter((p) => p.kind === 'wifi')
      const aps = new Map<string, WifiAp>()
      for (const [used, signal, ssid, security] of rows(text)) {
        if (!ssid) continue
        const known = profiles.find((p) => p.name === ssid)
        const ap = { id: known?.id ?? `scan:${ssid}`, ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)),
          secure: !!security && security !== '--', known: !!known, active: used === '*' }
        const old = aps.get(ssid)
        if (!old || ap.active || !old.active && old.signal < ap.signal) aps.set(ssid, ap)
      }
      return [...aps.values()]
    })
  }
  async connect(_ssid: string, _psk?: string): Promise<Result> { return { ok: false, error: WIFI_NOT_READY } }
  async forget(_id: string): Promise<Result> { return { ok: false, error: WIFI_NOT_READY } }
  profiles() { return this.queue.run(() => this.backend.profiles()) }
  applyIp(id: string, cfg: IpConfig) { return this.ipTrial.apply(id, cfg) }
  trial() { return this.ipTrial.trial() }
  keep() { return this.ipTrial.keep() }
  revert() { return this.ipTrial.revert() }
  resetAll() { return this.ipTrial.resetAll() }
  recoverPending() { return this.ipTrial.recoverPending() }
  on(event: 'changed' | 'trial', cb: () => void): Unsub {
    if (event === 'trial') return this.ipTrial.on('trial', cb)
    this.listeners.add(cb); return () => { this.listeners.delete(cb) }
  }
  onToast(cb: Parameters<Network['onToast']>[0]): Unsub { return this.ipTrial.onToast(cb) }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.monitor?.kill(); this.ipTrial.dispose(); this.listeners.clear()
    if (this.debounce !== undefined) this.clock.clearTimeout(this.debounce)
    if (this.restart !== undefined) this.clock.clearTimeout(this.restart)
  }
}
export function createLinuxNetwork(opts: LinuxNetworkOptions): LinuxNetwork { return new LinuxNetwork(opts) }
export function withRealIp(info: SystemServices['info'], net: Network): SystemServices['info'] {
  return { ...info, get: async () => ({ ...await info.get(), ip: (await net.status()).ip }) }
}
