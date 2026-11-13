import { randomUUID } from 'node:crypto'
import type { DiscoveredServer, JellyfinProbe, SignInPoll, SignInStart } from '@shared/ipc-contract'
import type { SourceInfo } from '@shared/media-types'
import { SourceConfig } from '@shared/settings-schema'
import { runtime, type Runtime } from '../core/runtime'
import type { MediaHub } from '../hub/MediaHub'
import type { Log } from '../log/Logger'
import type { SecretStore } from '../settings/SecretStore'
import type { SettingsStore } from '../settings/SettingsStore'
import { SourceError, type MediaSource } from '../sources/MediaSource'
import { PlexSource } from '../sources/plex/PlexSource'
import { PlexSignIn, type PlexAddition } from './PlexSignIn'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../sources/limits'
import { JellyfinClient, JellyfinHttpError, normaliseAddress } from '../sources/jellyfin/JellyfinClient'
import { JellyfinSource } from '../sources/jellyfin/JellyfinSource'
import { discoverJellyfin } from '../sources/jellyfin/discovery'
import type { SignInService } from './types'

interface Server extends JellyfinProbe { serverId: string }
interface Authentication { AccessToken: string; User: { Id: string; Name: string }; ServerId?: string }
interface Flow {
  server: Server; deviceId: string; secret: string; expires: number; lastPoll?: number; client: JellyfinClient
  source?: SourceInfo; pending?: Promise<SignInPoll>
}
export interface RealSignInOptions {
  hub: MediaHub; settings: SettingsStore; secrets: SecretStore; logger: Log; appVersion: string
  clock?: Runtime; fetch?: typeof fetch; discover?: () => Promise<DiscoveredServer[]>; id?: () => string
  /** The log for a source added here, so its requests are tagged like those of sources loaded at start-up. */
  sourceLogger?: (kind: 'jellyfin' | 'plex') => Log
}

interface Addition {
  fields: Omit<SourceConfig, 'id' | 'enabled'>; secret: Record<string, string>
  factory: (config: SourceConfig) => MediaSource
}

export class RealSignInService implements SignInService {
  private clock: Runtime
  private plex: PlexSignIn
  private flows = new Map<string, Flow>()
  private clients = new Set<JellyfinClient>()
  private discoveries = new Set<AbortController>()
  private cleanup: ReturnType<typeof setInterval>
  private disposed = false
  private generation = 0
  /** Serialise identity/limit checks with secret writes, including simultaneous password and code sign-ins. */
  private adding: Promise<unknown> = Promise.resolve()
  constructor(private opts: RealSignInOptions) {
    this.clock = opts.clock ?? runtime
    this.plex = new PlexSignIn({ deviceName: opts.settings.get().deviceName, appVersion: opts.appVersion,
      fetch: opts.fetch, clock: this.clock, logger: opts.logger, id: opts.id,
      save: (items, valid, added) => this.addPlex(items, valid, added) })
    this.cleanup = this.clock.setInterval(() => this.prune(), 60_000)
  }
  private id(): string { return (this.opts.id ?? randomUUID)() }
  private client(url: string, name: string, deviceId: string): JellyfinClient {
    if (this.disposed) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
    const client = new JellyfinClient({ url, name, deviceId, deviceName: this.opts.settings.get().deviceName,
      appVersion: this.opts.appVersion, clock: this.clock, fetch: this.opts.fetch, logger: this.opts.logger })
    this.clients.add(client)
    return client
  }
  private release(client: JellyfinClient): void { client.dispose(); this.clients.delete(client) }
  private prune(): void {
    this.plex.prune()
    for (const [id, flow] of this.flows) if (flow.expires <= this.clock.now()) {
      this.release(flow.client); this.flows.delete(id)
    }
  }
  async discover(): Promise<DiscoveredServer[]> {
    if (this.disposed) return []
    const controller = new AbortController()
    this.discoveries.add(controller)
    let stop!: () => void
    const cancelled = new Promise<DiscoveredServer[]>((resolve) => {
      stop = () => resolve([])
      controller.signal.addEventListener('abort', stop, { once: true })
    })
    try {
      const result = this.opts.discover ? this.opts.discover() : discoverJellyfin({ clock: this.clock, signal: controller.signal })
      return await Promise.race([result, cancelled])
    } catch { return [] } finally {
      controller.signal.removeEventListener('abort', stop)
      this.discoveries.delete(controller)
    }
  }
  private async inspect(value: string): Promise<Server> {
    const url = normaliseAddress(value)
    const client = this.client(url, new URL(url).hostname, this.id())
    try {
      let raw: { ServerName?: string; Version?: string; Id?: string } | undefined
      try { raw = await client.request('/System/Info/Public') } catch (error) {
        if (error instanceof SourceError && ['offline', 'timeout'].includes(error.code)) throw error
        throw new SourceError("That address isn't a Jellyfin server.", 'unsupported')
      }
      if (!raw || typeof raw.ServerName !== 'string' || !raw.ServerName || typeof raw.Version !== 'string' ||
        typeof raw.Id !== 'string' || !raw.Id) throw new SourceError("That address isn't a Jellyfin server.", 'unsupported')
      const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(raw.Version)
      if (!version) throw new SourceError("That address isn't a Jellyfin server.", 'unsupported')
      if (Number(version[1]) < 10 || (Number(version[1]) === 10 && Number(version[2]) < 9)) {
        throw new SourceError('This Jellyfin server is too old. Update it to version 10.9 or newer.', 'unsupported')
      }
      const quickConnect = await client.request<unknown>('/QuickConnect/Enabled').then((v) => v === true, () => false)
      return { url, serverName: raw.ServerName, version: raw.Version, quickConnect, serverId: raw.Id }
    } finally { this.release(client) }
  }
  async probe(value: string): Promise<JellyfinProbe> {
    const { serverId: _id, ...probe } = await this.inspect(value)
    return probe
  }
  async quickConnect(url: string): Promise<SignInStart> {
    const generation = this.generation
    const server = await this.inspect(url)
    if (!server.quickConnect) throw new SourceError(
      'Quick Connect is switched off on this server. Use a user name and password instead.', 'unsupported')
    const deviceId = this.id()
    const client = this.client(server.url, server.serverName, deviceId)
    try {
      const raw = await client.request<{ Secret?: string; Code?: string }>('/QuickConnect/Initiate', {}, 'POST')
      if (generation !== this.generation) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
      if (typeof raw?.Secret !== 'string' || !raw.Secret || typeof raw.Code !== 'string' || !raw.Code) {
        throw new SourceError(`Couldn't get a code from ${server.serverName}. Try again.`, 'server')
      }
      this.prune()
      const flowId = this.id()
      const expires = this.clock.now() + 600_000
      this.flows.set(flowId, { server, deviceId, client, secret: raw.Secret, expires })
      return { flowId, code: raw.Code, where: 'Jellyfin > Quick Connect', expiresAt: new Date(expires).toISOString() }
    } catch (error) {
      this.release(client)
      if (error instanceof JellyfinHttpError && [401, 403].includes(error.status)) {
        throw new SourceError('Quick Connect is switched off on this server. ' +
          'Use your password, or switch it on in the Jellyfin dashboard.', 'unsupported')
      }
      throw error
    }
  }
  async poll(flowId: string): Promise<SignInPoll> {
    this.prune()
    if (this.plex.has(flowId)) return this.plex.poll(flowId)
    const flow = this.flows.get(flowId)
    if (!flow) return { state: 'expired' }
    if (flow.source) return { state: 'done', source: structuredClone(flow.source) }
    if (flow.pending || (flow.lastPoll !== undefined && this.clock.now() - flow.lastPoll < 4000)) return { state: 'waiting' }
    flow.lastPoll = this.clock.now()
    flow.pending = this.pollServer(flowId, flow).finally(() => { flow.pending = undefined })
    return flow.pending
  }
  private async pollServer(id: string, flow: Flow): Promise<SignInPoll> {
    const valid = (): boolean => this.flows.get(id) === flow && flow.expires > this.clock.now()
    try {
      let connected: { Authenticated?: boolean }
      try { connected = await flow.client.request('/QuickConnect/Connect', { secret: flow.secret }) } catch (error) {
        if (error instanceof JellyfinHttpError && [401, 404].includes(error.status)) {
          await this.cancel(id); return { state: 'expired' }
        }
        throw error
      }
      if (!valid()) return { state: 'expired' }
      if (connected?.Authenticated !== true) return { state: 'waiting' }
      const auth = await flow.client.request<Authentication>('/Users/AuthenticateWithQuickConnect', {}, 'POST', { Secret: flow.secret })
      if (!valid()) return { state: 'expired' }
      flow.source = await this.add(flow.server, flow.deviceId, auth, valid)
      // No further requests use this flow; release the secret and the transport even though done remains pollable.
      flow.secret = ''; this.release(flow.client)
      return { state: 'done', source: structuredClone(flow.source) }
    } catch (error) {
      if (!valid()) return { state: 'expired' }
      return { state: 'error', message: error instanceof SourceError ? error.message : "Couldn't save the sign-in. Try again." }
    }
  }
  async password(url: string, user: string, pw: string): Promise<SourceInfo> {
    const generation = this.generation
    const server = await this.inspect(url)
    const deviceId = this.id()
    const client = this.client(server.url, server.serverName, deviceId)
    try {
      let auth: Authentication
      try { auth = await client.request('/Users/AuthenticateByName', {}, 'POST', { Username: user, Pw: pw }) } catch (error) {
        if (error instanceof JellyfinHttpError && error.status === 401) {
          throw new SourceError("That user name or password didn't work.", 'auth')
        }
        throw error
      }
      return await this.add(server, deviceId, auth, () => generation === this.generation && !this.disposed)
    } finally { this.release(client) }
  }
  private add(server: Server, deviceId: string, auth: Authentication, valid: () => boolean): Promise<SourceInfo> {
    if (!auth || typeof auth.AccessToken !== 'string' || !auth.AccessToken || typeof auth.User?.Id !== 'string' ||
      !auth.User.Id || typeof auth.User.Name !== 'string') {
      return Promise.reject(new SourceError("Couldn't save the sign-in. Try again.", 'server'))
    }
    const fields = { kind: 'jellyfin' as const, name: server.serverName, url: server.url,
      serverId: server.serverId, userId: auth.User.Id, userName: auth.User.Name }
    return this.enqueue(() => this.save({ fields, secret: { token: auth.AccessToken, deviceId },
      factory: (config) => new JellyfinSource({ ...config, url: server.url, serverId: server.serverId, userId: auth.User.Id,
        token: auth.AccessToken, deviceId, deviceName: this.opts.settings.get().deviceName, appVersion: this.opts.appVersion,
        fetch: this.opts.fetch, clock: this.clock, logger: this.sourceLog('jellyfin') }) }, valid))
  }
  private sourceLog(kind: 'jellyfin' | 'plex'): Log { return this.opts.sourceLogger?.(kind) ?? this.opts.logger }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const job = this.adding.catch(() => undefined).then(work)
    this.adding = job
    return job
  }
  private addPlex(items: PlexAddition[], valid: () => boolean,
    added: (serverId: string, source: SourceInfo) => void): Promise<void> {
    return this.enqueue(async () => {
      if (!valid()) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
      const sources = this.opts.settings.get().sources
      const pending = items.filter((item) => !this.plex.alreadyAdded(item))
      const newCount = pending.filter(({ server, user }) => !sources.some((s) => s.kind === 'plex' &&
        s.serverId === server.clientIdentifier && s.userId === user.userId)).length
      if (sources.length + newCount > MAX_SOURCES) throw new SourceError(SOURCE_LIMIT_MESSAGE, 'unsupported')
      for (const item of pending) {
        const { server, user, connection, accountToken, clientId } = item
        const secret = { token: server.accessToken, accountToken, clientId }
        const fields = { kind: 'plex' as const, name: server.name, url: connection?.url,
          serverId: server.clientIdentifier, ...user }
        const source = await this.save({ fields, secret, factory: (config) => new PlexSource({ ...config, ...secret,
          serverId: server.clientIdentifier, userId: user.userId, deviceName: this.opts.settings.get().deviceName,
          appVersion: this.opts.appVersion, fetch: this.opts.fetch, clock: this.clock, logger: this.sourceLog('plex'),
          onConnection: (url) => this.saveConnection(config.id, url) }) }, valid)
        added(server.clientIdentifier, source)
      }
    })
  }
  private saveConnection(id: string, url: string): void {
    const sources = this.opts.settings.get().sources
    if (!sources.some((s) => s.id === id && s.url !== url)) return
    try {
      this.opts.settings.update({ sources: sources.map((s) => s.id === id ? { ...s, url } : s) })
      void this.opts.settings.flush().catch(() => this.opts.logger.warn('Plex connection could not be saved'))
    } catch { this.opts.logger.warn('Plex connection could not be saved') }
  }
  /** Shared by both providers. Called only inside adding, including batch preflight checks. */
  private async save(addition: Addition, valid: () => boolean): Promise<SourceInfo> {
    if (!valid()) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
    const { fields, secret, factory } = addition
    const sources = this.opts.settings.get().sources
    const existing = sources.find((s) => s.kind === fields.kind && s.serverId === fields.serverId && s.userId === fields.userId)
    if (!existing && sources.length >= MAX_SOURCES) throw new SourceError(SOURCE_LIMIT_MESSAGE, 'unsupported')
    const id = existing?.id ?? this.id()
    let config: SourceConfig
    try {
      config = SourceConfig.parse({ ...fields, id, name: (existing?.name ?? fields.name).slice(0, 80),
        userName: fields.userName?.slice(0, 200), enabled: true })
    } catch { throw new SourceError("Couldn't save the sign-in. Try again.", 'server') }
    const previous = this.opts.secrets.get(id)
    const restore = async (): Promise<void> => {
      // SecretStore changes its memory before writing the file. Restore that too when a save fails.
      const stillSaved = this.opts.settings.get().sources.some((s) => s.id === id)
      await (previous && stillSaved ? this.opts.secrets.set(id, previous) : this.opts.secrets.delete(id)).catch(() => undefined)
    }
    try { await this.opts.secrets.set(id, secret) } catch {
      await restore()
      throw new SourceError("Couldn't save the sign-in. Try again.", 'server')
    }
    // Read the list again after the awaited write: Settings may have changed while the disk was busy.
    const current = this.opts.settings.get().sources
    const removed = existing && !current.some((s) => s.id === id)
    if (!valid() || removed || (!existing && current.length >= MAX_SOURCES)) {
      await restore()
      if (!valid() || removed) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
      throw new SourceError(SOURCE_LIMIT_MESSAGE, 'unsupported')
    }
    const written = existing ? { ...config, name: current.find((s) => s.id === id)!.name } : config
    // Undo only this sign-in. A rename, switch-off or address change made while the disk was busy is kept.
    const rollback = (s: SourceConfig): SourceConfig[] => s.id !== id ? [s] : !existing ? [] : [{ ...existing, name: s.name,
      url: s.url !== written.url ? s.url : existing.url, enabled: s.enabled !== written.enabled ? s.enabled : existing.enabled }]
    try {
      this.opts.settings.update({ sources: existing ? current.map((s) => s.id === id ? written : s) : [...current, config] })
      await this.opts.settings.flush()
    } catch {
      try {
        const latest = this.opts.settings.get().sources
        this.opts.settings.update({ sources: latest.flatMap(rollback) })
        await this.opts.settings.flush()
      } catch { /* Restore memory even if the disk still cannot be written; a reset may also have locked settings. */ }
      await restore()
      throw new SourceError("Couldn't save the sign-in. Try again.", 'server')
    }
    if (!valid() || !this.opts.settings.get().sources.some((s) => s.id === id)) {
      const latest = this.opts.settings.get().sources
      this.opts.settings.update({ sources: latest.flatMap(rollback) })
      await this.opts.settings.flush().catch(() => undefined)
      await restore()
      throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
    }
    config.name = this.opts.settings.get().sources.find((s) => s.id === id)!.name
    const source = factory(config)
    if (existing) this.opts.hub.remove(id)
    this.opts.hub.add(source)
    return source.info()
  }
  async cancel(flowId: string): Promise<{ ok: true }> {
    this.plex.cancel(flowId)
    const flow = this.flows.get(flowId)
    if (flow) this.release(flow.client)
    this.flows.delete(flowId)
    return { ok: true }
  }
  cancelAll(): void {
    this.plex.cancelAll()
    this.generation++
    for (const controller of this.discoveries) controller.abort()
    this.discoveries.clear()
    for (const client of this.clients) client.dispose()
    this.clients.clear(); this.flows.clear()
  }
  async plexPin(): Promise<SignInStart> { return this.plex.pin() }
  async plexAddServers(flowId: string, ids: string[]): Promise<SourceInfo[]> { return this.plex.addServers(flowId, ids) }
  dispose(): void { this.disposed = true; this.clock.clearInterval(this.cleanup); this.plex.dispose(); this.cancelAll() }
}
