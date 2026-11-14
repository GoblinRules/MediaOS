import { randomBytes, randomInt } from 'node:crypto'
import type { Result } from '../../shared/system-types'
import { MAX_VPN_LOCATIONS, VPN_LABEL_MAX, type AppRoute, type AppVpnChoice, type VpnImportError,
  type VpnImportStage, type VpnState, type VpnStatus } from '../../shared/vpn-types'
import { runtime, type Runtime } from '../core/runtime'
import type { SettingsStore } from '../settings/SettingsStore'
import type { Settings } from '../../shared/settings-schema'
import { silentLog, type Log } from '../log/Logger'
import type { VpnBackend } from './VpnBackend'
import { parseWireGuard, type WgConfig } from './wg-config'
import { readZipConfs } from './zip-reader'
import { groupServers, suggestLabel } from './server-groups'
import { stripDisplayControls } from './display-text'
import { validTunnelAddress } from './proxy/target-policy'
import type { VpnUploadPort } from '../remote/upload'

export interface VpnProxyHost {
  start(): Promise<void>; stop(): Promise<void>; port(): number | null
  onPort(cb: (port: number | null) => void): () => void
  setTunnel(tunIp: string | null, dns: string | null): void
}
export interface VpnControllerOptions {
  backend: VpnBackend; settings: SettingsStore; proxy: VpnProxyHost; clock?: Runtime; logger?: Log
  closeApp(): Promise<void>; runningApp(): string | undefined; appName(id: string): string
  appIds(): string[]; isLockedDirect(id: string): boolean
  emitStatus(status: VpnStatus): void; emitDropped(appId: string): void
  toast(text: string, tone: 'info' | 'error'): void
  devImport?: () => Promise<{ name: string; data: Buffer } | null>
  id?: () => string
  randomInt?: (max: number) => number
  networkBusy?: () => Promise<boolean>
  upload?: VpnUploadPort
}
type Location = Settings['vpn']['locations'][number]
const ok = { ok: true } as const

export class VpnController {
  private state: VpnState = 'not-set-up'
  private checkState: VpnStatus['check'] = 'idle'
  private slow = false
  private appOnVpn: string | null = null
  private stage: VpnImportStage | null = null
  private config: WgConfig | null = null
  private entries: { name: string; data: Buffer }[] = []
  private failures = 0
  private dropped = false
  private disposed = false
  private epoch = 0
  private tail: Promise<unknown> = Promise.resolve()
  private probing?: Promise<boolean>
  private refreshing?: Promise<string | null | undefined>
  private tunnelIp: string | null = null
  private observedIp: string | null = null
  private statusMisses = 0
  private reconciling = false
  private tunnelRevision = 0
  private suspended = false
  private pollTimer?: ReturnType<typeof setInterval>
  private probeTimer?: ReturnType<typeof setInterval>
  private slowTimer?: ReturnType<typeof setTimeout>
  private importTimer?: ReturnType<typeof setTimeout>
  private importRevision = 0
  private cancellations = new Set<() => void>()
  private readonly clock: Runtime
  private readonly logger: Log

  constructor(private opts: VpnControllerOptions) {
    this.clock = opts.clock ?? runtime; this.logger = opts.logger ?? silentLog
    this.state = this.baseState()
  }
  private vpn(): Settings['vpn'] { return this.opts.settings.get().vpn }
  private active(): Location | undefined { const v = this.vpn(); return v.locations.find((l) => l.id === v.activeLocationId) }
  private baseState(): VpnState { const v = this.vpn(); return !v.locations.length ? 'not-set-up' : v.enabled ? 'down' : 'off' }
  status(): VpnStatus {
    const v = this.vpn()
    return { state: this.state, enabled: v.enabled, activeLocationId: v.activeLocationId,
      locations: v.locations.map(({ id, label, addedAt }) => ({ id, label, addedAt })),
      apps: Object.fromEntries(Object.entries(v.apps).filter(([, choice]) => choice !== 'direct')),
      check: this.checkState, slow: this.slow, appOnVpn: this.appOnVpn, import: structuredClone(this.stage) }
  }
  private emit(): void { if (!this.disposed) this.opts.emitStatus(this.status()) }
  private queue<T>(work: () => Promise<T>, inactive: () => T): Promise<T> {
    const job = this.tail.then(() => this.disposed ? inactive() : work()).finally(() => this.emit())
    this.tail = job.catch(() => undefined); return job
  }
  private async save(patch: Partial<Settings['vpn']>): Promise<void> {
    if (this.disposed) return
    this.opts.settings.update({ vpn: { ...this.vpn(), ...patch } }); await this.opts.settings.flush()
  }
  private async attempt(work: () => Promise<unknown>): Promise<void> {
    if (this.disposed) return
    try { await work() } catch { this.logger.warn('VPN change could not be completed') }
  }
  private async transition(next: VpnState): Promise<void> {
    const previous = this.state
    if (previous === next || this.disposed) return
    this.state = next; this.slow = false
    if (this.slowTimer !== undefined) this.clock.clearTimeout(this.slowTimer)
    this.slowTimer = undefined
    if (next === 'connecting') this.slowTimer = this.clock.setTimeout(() => {
      this.slowTimer = undefined
      if (this.state === 'connecting') { this.slow = true; this.emit() }
    }, 15000)
    this.emit()
    if (previous === 'connected' && (next === 'down' || next === 'not-working')) {
      this.dropped = true
      const id = this.appOnVpn
      if (id) {
        await this.attempt(() => this.opts.closeApp())
        if (this.appOnVpn === id) this.appOnVpn = null
        this.opts.emitDropped(id)
      }
      else this.opts.toast("The VPN has disconnected. Apps using it will stop until it's back.", 'error')
      this.emit()
    } else if (next === 'connected' && this.dropped) {
      this.dropped = false; this.opts.toast('The VPN is back.', 'info')
    }
  }
  private valid(epoch: number): boolean {
    return !this.disposed && !this.suspended && this.vpn().enabled && epoch === this.epoch
  }
  private setTunnel(ip: string | null): void {
    if (this.disposed) return
    this.tunnelIp = ip
    this.opts.proxy.setTunnel(ip, ip ? this.active()?.dns ?? null : null)
  }
  private invalidate(): void {
    ++this.epoch
    for (const cancel of [...this.cancellations]) cancel()
    this.probing = undefined; this.refreshing = undefined
  }
  private stopTimers(): void {
    if (this.pollTimer !== undefined) this.clock.clearInterval(this.pollTimer)
    if (this.probeTimer !== undefined) this.clock.clearInterval(this.probeTimer)
    if (this.slowTimer !== undefined) this.clock.clearTimeout(this.slowTimer)
    this.pollTimer = this.probeTimer = this.slowTimer = undefined
  }
  private startTimers(): void {
    if (this.disposed || this.pollTimer !== undefined) return
    this.pollTimer = this.clock.setInterval(() => this.notifyNetworkChanged(), 5000)
    this.probeTimer = this.clock.setInterval(() => { void this.probeNow() }, 30000)
  }
  private readStatus(epoch: number): Promise<string | null | undefined> {
    if (this.refreshing) return this.refreshing
    const job = (async () => {
      const status = await this.budget(() => this.opts.backend.status(), 3000,
        { state: 'unknown', tunIp: null } as const)
      if (!this.valid(epoch)) return null
      if (status.state === 'unknown') {
        ++this.tunnelRevision
        if (++this.statusMisses >= 3) { this.setTunnel(null); await this.transition('down') }
        return undefined
      }
      this.statusMisses = 0
      const ip = status.state === 'up' && status.tunIp && validTunnelAddress(status.tunIp) ? status.tunIp : null
      if (ip !== this.observedIp) { this.observedIp = ip; ++this.tunnelRevision }
      if (!ip || ip !== this.tunnelIp) this.setTunnel(null)
      if ((!ip && !(status.state === 'connecting' && this.state === 'connecting')) ||
        (ip && this.state === 'connected' && ip !== this.tunnelIp)) await this.transition('down')
      return ip
    })()
    this.refreshing = job
    const clear = (): void => { if (this.refreshing === job) this.refreshing = undefined }
    void job.then(clear, clear)
    return job
  }
  notifyNetworkChanged(): void {
    const epoch = this.epoch
    if (this.valid(epoch)) void this.readStatus(epoch).then(async (ip) => {
      if (!ip || this.state !== 'down' || this.reconciling) return
      // An old-address probe may still be finishing; recovery must check the newly observed address.
      if (this.probing) await this.probing
      if (this.valid(epoch) && this.state === 'down' && this.observedIp === ip) await this.probeNow()
    }).catch(() => undefined)
  }
  /** The deadline includes a hung status/routing read, not just the UDP socket. Late results are ignored. */
  private budget<T>(work: (alive: () => boolean) => Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      let ended = false
      const finish = (value: T): void => {
        if (ended) return
        ended = true; this.clock.clearTimeout(timer); this.cancellations.delete(cancel); resolve(value)
      }
      const cancel = (): void => finish(fallback)
      const timer = this.clock.setTimeout(cancel, Math.max(0, ms))
      this.cancellations.add(cancel)
      void work(() => !ended).then(finish, () => finish(fallback))
    })
  }
  private probeNow(): Promise<boolean> {
    if (this.probing) return this.probing
    if (!this.vpn().enabled || this.disposed) return Promise.resolve(false)
    const epoch = this.epoch, deadline = this.clock.now() + 3000
    let revision = this.tunnelRevision, checkedIp: string | null = null, unknown = true
    const job = this.budget(async (alive) => {
      const ip = await this.readStatus(epoch)
      unknown = ip === undefined
      if (!alive() || !this.valid(epoch) || !ip) return false
      revision = this.tunnelRevision; checkedIp = ip
      const routing = await this.opts.backend.routingOk(ip)
      if (!alive() || !this.valid(epoch)) return false
      if (!routing) { this.setTunnel(null); await this.transition('down'); return false }
      return this.opts.backend.probe(ip, this.active()?.dns ?? null, Math.max(0, deadline - this.clock.now()))
    }, 3000, false).then(async (passed) => {
      if (!this.valid(epoch)) return false
      if (passed && (revision !== this.tunnelRevision || checkedIp !== this.observedIp)) return false
      if (passed) { this.setTunnel(checkedIp); this.failures = 0; await this.transition('connected') }
      else if (!unknown && ++this.failures >= 2 && this.state !== 'down') await this.transition('not-working')
      this.emit(); return passed
    }).finally(() => { if (this.probing === job) this.probing = undefined })
    this.probing = job; return job
  }
  private waitPort(ms: number): Promise<number | null> {
    const port = this.opts.proxy.port()
    if (port) return Promise.resolve(port)
    return new Promise((resolve) => {
      let ended = false
      const finish = (value: number | null): void => {
        if (ended) return
        ended = true; off(); this.clock.clearTimeout(timer); this.cancellations.delete(cancel); resolve(value)
      }
      const cancel = (): void => finish(null)
      const off = this.opts.proxy.onPort((value) => { if (value) finish(value) })
      const timer = this.clock.setTimeout(cancel, Math.max(0, ms))
      this.cancellations.add(cancel)
    })
  }
  async routeFor(appId: string): Promise<AppRoute | { kind: 'blocked' } | { kind: 'fallback' }> {
    if (this.disposed) return { kind: 'blocked' }
    const v = this.vpn(), choice = v.apps[appId] ?? 'direct'
    if (!v.enabled || choice === 'direct' || this.opts.isLockedDirect(appId)) return { kind: 'direct' }
    let port = this.opts.proxy.port()
    if (!this.reconciling && (this.state !== 'connected' || !port)) {
      const deadline = this.clock.now() + 3000, epoch = this.epoch
      let passed = false
      port = await this.budget(async (alive) => {
        passed = await this.probeNow()
        if (!alive() || !this.valid(epoch) || !passed) return null
        return this.waitPort(Math.max(0, deadline - this.clock.now()))
      }, 3000, null)
      if (!this.valid(epoch)) port = null
      else if (passed && !port && ++this.failures >= 2) await this.transition('not-working')
    }
    const latest = this.vpn(), latestChoice = latest.apps[appId] ?? 'direct'
    if (!latest.enabled || latestChoice === 'direct' || this.opts.isLockedDirect(appId)) return { kind: 'direct' }
    if (this.disposed || this.reconciling) return { kind: latestChoice === 'vpn-only' ? 'blocked' : 'fallback' }
    if (port && this.state === 'connected') return { kind: 'vpn', port, label: this.active()?.label ?? 'VPN' }
    return { kind: latestChoice === 'vpn-only' ? 'blocked' : 'fallback' }
  }
  async confirmLaunch(appId: string, route: AppRoute, fallback = false): Promise<boolean> {
    if (this.disposed) return false
    const v = this.vpn(), choice = v.apps[appId] ?? 'direct', locked = this.opts.isLockedDirect(appId)
    const right = route.kind === 'vpn'
      ? v.enabled && this.state === 'connected' && !locked && choice !== 'direct' && this.opts.proxy.port() === route.port
      : !v.enabled || choice === 'direct' || locked || (fallback && choice === 'vpn-or-direct')
    if (right) { this.noteLaunched(appId, route); return true }
    const drop = route.kind === 'vpn' && (this.state === 'down' || this.state === 'not-working')
    await this.attempt(() => this.opts.closeApp()); this.appOnVpn = null
    if (drop && !this.disposed) this.opts.emitDropped(appId)
    this.emit(); return false
  }
  noteLaunched(appId: string, route: AppRoute): void {
    if (!this.disposed) { this.appOnVpn = route.kind === 'vpn' ? appId : null; this.emit() }
  }
  noteExited(appId: string): void { if (this.appOnVpn === appId) { this.appOnVpn = null; this.emit() } }
  private async closeVpnApp(): Promise<void> {
    if (this.appOnVpn) {
      try { await this.opts.closeApp() } finally { this.appOnVpn = null }
    }
  }
  private async networkBusy(): Promise<boolean> {
    try { return await this.opts.networkBusy?.() ?? false } catch { return true }
  }
  private async waitNetworkIdle(): Promise<boolean> {
    const deadline = this.clock.now() + 120000
    while (!this.disposed && await this.networkBusy()) {
      if (this.clock.now() >= deadline) { await this.transition(this.vpn().enabled ? 'down' : this.baseState()); return false }
      await this.budget(() => new Promise<boolean>(() => {}), 2000, false)
    }
    return !this.disposed
  }
  private async bringUp(location: Location): Promise<void> {
    if (this.disposed || !await this.waitNetworkIdle()) return
    this.invalidate(); this.suspended = false; this.failures = 0; this.statusMisses = 0; this.checkState = 'idle'
    const epoch = this.epoch
    await this.transition('connecting'); this.startTimers()
    try {
      if (!this.valid(epoch)) return
      await this.opts.proxy.start()
      if (!this.valid(epoch)) return
      await this.opts.backend.setAutoconnect(location.nmUuid, true)
      if (!this.valid(epoch)) return
      const ip = await this.opts.backend.address(location.nmUuid)
      if (!this.valid(epoch)) return
      if (!ip) throw new Error('No tunnel address')
      await this.opts.backend.up(location.nmUuid, ip)
      if (this.valid(epoch)) await this.probeNow()
    } catch {
      if (!this.valid(epoch)) return
      this.logger.warn('VPN could not be connected')
      this.setTunnel(null); await this.transition('down')
    }
  }
  private async enable(on: boolean): Promise<Result> {
    if (this.disposed) return ok
    const location = this.active()
    if (on) {
      if (!location) return { ok: false, error: 'Add a VPN location first.' }
      if (this.vpn().enabled && this.state === 'connected') return ok
      if (this.vpn().enabled) await this.attempt(() => this.closeVpnApp())
      await this.save({ enabled: true }); await this.bringUp(location)
    } else {
      await this.attempt(() => this.closeVpnApp())
      if (this.disposed) return ok
      // Record the deliberate direct choice before cancelling a pending launch probe.
      this.opts.settings.update({ vpn: { ...this.vpn(), enabled: false } })
      this.suspended = true; this.invalidate(); this.stopTimers(); this.dropped = false; this.slow = false
      if (location) {
        await this.attempt(() => this.opts.backend.setAutoconnect(location.nmUuid, false))
        await this.attempt(() => this.opts.backend.down(location.nmUuid))
      }
      this.setTunnel(null); await this.attempt(() => this.opts.proxy.stop())
      await this.save({ enabled: false }); this.checkState = 'idle'; await this.transition(this.baseState())
    }
    return ok
  }
  async setEnabled(on: boolean): Promise<Result> {
    if (this.disposed) return ok
    if (await this.networkBusy()) return this.networkError()
    return this.queue(async () => await this.networkBusy() ? this.networkError() : this.enable(on), () => ok)
  }
  private networkError(): Result { return { ok: false, error: 'Finish checking the network settings first.' } }
  async setLocation(id: string): Promise<Result> {
    if (this.disposed) return ok
    if (await this.networkBusy()) return this.networkError()
    return this.queue(async () => {
      if (await this.networkBusy()) return this.networkError()
      if (this.disposed) return ok
      const v = this.vpn(), next = v.locations.find((l) => l.id === id)
      if (!next) return { ok: false, error: 'That VPN location could not be found. Choose another location.' }
      if (v.activeLocationId === id) return ok
      if (v.enabled) {
        await this.closeVpnApp()
        if (this.disposed) return ok
        this.suspended = true; this.invalidate(); this.setTunnel(null)
        await this.transition('connecting')
        const old = this.active()
        if (old) {
          // Do not activate another profile if the previous profile could still autoconnect.
          try {
            await this.opts.backend.setAutoconnect(old.nmUuid, false)
            if (this.disposed) return ok
            await this.opts.backend.down(old.nmUuid)
          }
          catch {
            this.suspended = false; await this.transition('down')
            return { ok: false, error: "The VPN location couldn't be changed. Restart the TV box and try again." }
          }
        }
      }
      await this.save({ activeLocationId: id })
      if (v.enabled) await this.bringUp(next)
      return ok
    }, () => ok)
  }
  async removeLocation(id: string): Promise<Result> {
    if (this.disposed) return ok
    if (await this.networkBusy()) return this.networkError()
    return this.queue(async () => {
      if (await this.networkBusy()) return this.networkError()
      if (this.disposed) return ok
      const location = this.vpn().locations.find((l) => l.id === id)
      if (!location) return { ok: false, error: 'That VPN location could not be found. Choose another location.' }
      if (this.vpn().enabled && this.vpn().activeLocationId === id) await this.enable(false)
      if (this.disposed) return ok
      try { await this.opts.backend.remove(location.nmUuid) } catch {
        return { ok: false, error: "The location couldn't be removed. Restart the TV box and try again." }
      }
      const v = this.vpn(), locations = v.locations.filter((l) => l.id !== id)
      await this.save({ locations, activeLocationId: v.activeLocationId === id ? locations[0]?.id ?? null : v.activeLocationId })
      if (!this.vpn().enabled) await this.transition(this.baseState())
      return ok
    }, () => ok)
  }
  check(): Promise<VpnStatus> {
    return this.queue(async () => {
      if (!this.vpn().enabled) { this.checkState = 'idle'; return this.status() }
      this.checkState = 'checking'; this.emit()
      this.checkState = await this.probeNow() ? 'ok' : 'failed'; return this.status()
    }, () => this.status())
  }
  setAppVpn(appId: string, choice: AppVpnChoice): Promise<Result> {
    return this.queue(async () => {
      if (this.opts.isLockedDirect(appId)) return { ok: false, error: `${this.opts.appName(appId)} always connects directly.` }
      if (this.opts.runningApp() === appId && (this.vpn().apps[appId] ?? 'direct') !== choice) {
        await this.opts.closeApp(); this.noteExited(appId)
      }
      const apps = this.vpn().apps
      if (choice === 'direct') delete apps[appId]; else apps[appId] = choice
      await this.save({ apps }); return ok
    }, () => ok)
  }
  setAllApps(choice: 'vpn-only' | 'direct'): Promise<Result> {
    return this.queue(async () => {
      const apps = this.vpn().apps, ids = this.opts.appIds().filter((id) => !this.opts.isLockedDirect(id))
      const running = this.opts.runningApp()
      if (running && ids.includes(running) && (apps[running] ?? 'direct') !== choice) {
        await this.opts.closeApp(); this.noteExited(running)
      }
      for (const id of ids) { if (choice === 'direct') delete apps[id]; else apps[id] = choice }
      await this.save({ apps }); return ok
    }, () => ok)
  }
  start(): Promise<void> {
    this.reconciling = true
    return this.queue(async () => {
      if (!await this.waitNetworkIdle()) return
      const profiles = await this.opts.backend.listProfiles().catch(() => null)
      if (this.disposed) return
      if (profiles) {
        const v = this.vpn(), locations = v.locations.filter((l) => profiles.some((p) => p.uuid === l.nmUuid))
        if (locations.length !== v.locations.length) {
          this.logger.warn('A missing VPN location was removed')
          const lostActive = !locations.some((l) => l.id === v.activeLocationId)
          await this.save({ locations, ...(lostActive ? { activeLocationId: null, enabled: false } : {}) })
        }
        for (const p of profiles) if (p.type === 'wireguard' &&
          (p.name === 'mosvpn0' || p.name.startsWith('MediaOS VPN - ')) && !locations.some((l) => l.nmUuid === p.uuid)) {
          await this.attempt(() => this.opts.backend.remove(p.uuid))
        }
      }
      const v = this.vpn(), active = this.active()
      for (const l of v.locations) if (!v.enabled || l.id !== active?.id) {
        await this.attempt(() => this.opts.backend.setAutoconnect(l.nmUuid, false))
        await this.attempt(() => this.opts.backend.down(l.nmUuid))
      }
      if (v.enabled && active) await this.bringUp(active)
      else await this.transition(this.baseState())
    }, () => undefined).finally(() => { this.reconciling = false })
  }
  deleteAllProfiles(): Promise<void> {
    return this.queue(async () => {
      this.suspended = true; this.invalidate(); this.stopTimers()
      for (const l of this.vpn().locations) {
        await this.attempt(() => this.opts.backend.down(l.nmUuid)); await this.attempt(() => this.opts.backend.remove(l.nmUuid))
      }
      this.setTunnel(null); await this.attempt(() => this.opts.proxy.stop())
    }, () => undefined)
  }
  private clearImport(): void {
    ++this.importRevision
    this.opts.upload?.close()
    if (this.importTimer !== undefined) this.clock.clearTimeout(this.importTimer)
    this.importTimer = undefined; this.config = null; this.entries = []
  }
  private importError(error: VpnImportError): VpnImportStage {
    this.clearImport(); this.stage = { stage: 'error', error }; return this.stage
  }
  private parseEntry(name: string, data: Buffer): void {
    const parsed = parseWireGuard(data)
    this.entries = []
    if (!parsed.ok) { this.importError(parsed.error); return }
    this.config = parsed.config
    this.stage = { stage: 'name', suggested: suggestLabel(name), removed: parsed.removed }
  }
  private processFile(name: string, data: Buffer): void {
    this.clearImport(); this.stage = { stage: 'checking' }; this.emit()
    if (data.length > 65536) { this.importError('too-large'); return }
    if (data.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'binary'))) {
      const zip = readZipConfs(data)
      if (!zip.ok) { this.importError(zip.error); return }
      if (zip.entries.length > 1) {
        this.entries = zip.entries; this.stage = { stage: 'choose', groups: groupServers(zip.entries.map((e) => e.name)) }; return
      }
      const entry = zip.entries[0]!
      this.parseEntry(entry.name, entry.data)
    } else this.parseEntry(name.replace(/\.conf$/i, ''), data)
  }
  startImport(): Promise<VpnImportStage> {
    return this.queue(async () => {
      this.clearImport()
      const revision = this.importRevision
      if (this.vpn().locations.length >= MAX_VPN_LOCATIONS) return this.importError('too-many-locations')
      this.stage = { stage: 'waiting', url: null, code: null, expiresAt: new Date(this.clock.now() + 300000).toISOString() }
      this.emit()
      if (this.opts.devImport) {
        try {
          const file = await this.opts.devImport()
          if (file) this.processFile(file.name, file.data); else this.importError('not-wireguard')
        } catch { this.importError('not-wireguard') }
      } else {
        if (this.opts.upload) {
          const upload = this.opts.upload
          // A throw must not leave the TV on "Getting the code ready…" with no expiry timer.
          const opened = await upload.open().catch(() => {
            upload.close(); return { ok: false, error: 'upload-unavailable' } as const
          })
          if (this.disposed || revision !== this.importRevision) {
            this.opts.upload.close(); return { stage: 'error', error: 'save-failed' }
          }
          if (!opened.ok) return this.importError(opened.error)
          this.stage = { stage: 'waiting', url: opened.url, code: opened.code, expiresAt: opened.expiresAt }
          this.emit()
        }
        const expiresAt = this.stage?.stage === 'waiting' ? this.stage.expiresAt : null
        this.importTimer = this.clock.setTimeout(() => {
          if (this.stage?.stage === 'waiting') { this.importError('expired'); this.emit() }
        }, expiresAt ? Math.max(0, Date.parse(expiresAt) - this.clock.now()) : 300000)
      }
      return structuredClone(this.stage!)
    }, () => ({ stage: 'error', error: 'save-failed' }))
  }
  /** True when the file reached the import that was waiting for it; false when that import had already ended. */
  receiveFile(name: string, data: Buffer, code?: string): Promise<boolean> {
    return this.queue(async () => {
      if (this.stage?.stage !== 'waiting' || (code !== undefined && code !== this.stage.code)) return false
      this.processFile(name, data)
      return true
    }, () => false)
  }
  uploadTooLarge(code: string): void {
    if (!this.disposed && this.stage?.stage === 'waiting' && this.stage.code === code) {
      this.importError('too-large'); this.emit()
    }
  }
  chooseImportEntry(id: string): Promise<VpnImportStage> {
    return this.queue(async () => {
      if (this.stage?.stage === 'choose' && id === 'any') {
        const entries = this.entries, selected = (this.opts.randomInt ?? randomInt)(entries.length)
        for (const entry of [entries[selected]!, ...entries.filter((_, i) => i !== selected)]) {
          this.parseEntry(entry.name, entry.data)
          if (this.config) break
        }
      }
      if (this.stage?.stage === 'choose' && /^e(?:0|[1-9]\d*)$/.test(id)) {
        const entry = this.entries[Number(id.slice(1))]
        if (entry) this.parseEntry(entry.name, entry.data)
      }
      return structuredClone(this.stage ?? { stage: 'error', error: 'not-wireguard' })
    }, () => ({ stage: 'error', error: 'save-failed' }))
  }
  async finishImport(label: string): Promise<VpnImportStage> {
    if (this.disposed) return { stage: 'error', error: 'save-failed' }
    if (await this.networkBusy()) { this.importError('save-failed'); this.emit(); return structuredClone(this.stage!) }
    return this.queue(async () => {
      // The import contract has no Result or network-busy stage; use its existing save error.
      if (await this.networkBusy()) return this.importError('save-failed')
      if (this.disposed) return { stage: 'error', error: 'save-failed' }
      if (this.stage?.stage !== 'name' || !this.config) return structuredClone(this.stage ?? this.importError('not-wireguard'))
      const cap = (s: string, length = VPN_LABEL_MAX): string => [...s].slice(0, length).join('')
      const base = cap(stripDisplayControls(label).trim() || this.stage.suggested)
      let name = base, suffix = 2
      const used = this.vpn().locations.map((l) => l.label.toLowerCase())
      while (used.includes(name.toLowerCase())) { const end = ` ${suffix++}`; name = cap(base, VPN_LABEL_MAX - end.length) + end }
      const config = this.config
      this.stage = { stage: 'saving' }; this.emit()
      let uuid: string | null = null
      try {
        if (this.vpn().locations.length >= MAX_VPN_LOCATIONS) return this.importError('too-many-locations')
        uuid = await this.opts.backend.importProfile(config, name)
        const location: Location = { id: `loc-${(this.opts.id ?? (() => randomBytes(4).toString('hex')))()}`, label: name,
          nmUuid: uuid, dns: config.dns[0] ?? null, addedAt: new Date(this.clock.now()).toISOString() }
        const v = this.vpn()
        await this.save({ locations: [...v.locations, location], activeLocationId: v.activeLocationId ?? location.id })
        this.clearImport(); this.stage = { stage: 'done', label: name }
        if (!this.vpn().enabled) await this.transition('off')
      } catch {
        if (uuid) {
          // SettingsStore updates memory before flushing. Remove that reference as well as the imported profile.
          const v = this.vpn(), locations = v.locations.filter((l) => l.nmUuid !== uuid)
          await this.attempt(async () => {
            this.opts.settings.update({ vpn: { ...v, locations,
              activeLocationId: locations.some((l) => l.id === v.activeLocationId) ? v.activeLocationId : locations[0]?.id ?? null } })
            await this.opts.settings.flush()
          })
          await this.attempt(() => this.opts.backend.remove(uuid!))
        }
        this.importError('save-failed')
      }
      return structuredClone(this.stage!)
    }, () => ({ stage: 'error', error: 'save-failed' }))
  }
  cancelImport(): Promise<Result> {
    return this.queue(async () => { this.clearImport(); this.stage = null; return ok }, () => ok)
  }
  dispose(): void {
    this.disposed = true; this.invalidate(); this.stopTimers(); this.clearImport(); this.stage = null
  }
}
