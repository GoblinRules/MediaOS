import { randomUUID } from 'node:crypto'
import type { PlexServerChoice, SignInPoll, SignInStart } from '@shared/ipc-contract'
import type { SourceInfo } from '@shared/media-types'
import { SourceError } from '../sources/MediaSource'
import { PlexTv, type PlexIdentity, type PlexServer, type PlexUser } from '../sources/plex/PlexTv'
import { PlexHttpError } from '../sources/plex/PlexClient'
import { raceConnections, reachText, type Connection } from '../sources/plex/connections'
import { runtime, type Runtime } from '../core/runtime'

interface Flow {
  tv: PlexTv; controller: AbortController; clientId: string; pinId: string; expires: number; lastPoll?: number
  pending?: Promise<SignInPoll>; token?: string; user?: PlexUser; servers?: PlexServer[]
  connections: Map<string, Connection>; choices?: PlexServerChoice[]; added: Map<string, SourceInfo>
}
export interface PlexAddition {
  server: PlexServer; user: PlexUser; connection?: Connection; accountToken: string; clientId: string
}
interface Options extends Omit<PlexIdentity, 'clientId'> {
  save: (items: PlexAddition[], valid: () => boolean, added: (serverId: string, source: SourceInfo) => void) => Promise<void>
  id?: () => string
}
const expired = (): SourceError => new SourceError('That sign-in has expired. Sign in again.', 'auth')

/** Main-only PIN state; replies are constructed explicitly so credentials can never cross IPC. */
export class PlexSignIn {
  private flows = new Map<string, Flow>()
  private creating = new Set<PlexTv>()
  private clock: Runtime
  private disposed = false
  private generation = 0
  constructor(private opts: Options) { this.clock = opts.clock ?? runtime }
  private id(): string { return (this.opts.id ?? randomUUID)() }
  async pin(): Promise<SignInStart> {
    if (this.disposed) throw expired()
    const generation = this.generation, clientId = this.id()
    const tv = new PlexTv({ ...this.opts, clientId })
    this.creating.add(tv)
    try {
      const pin = await tv.createPin()
      if (this.disposed || generation !== this.generation) throw expired()
      const expires = Math.min(pin.expiresAt, this.clock.now() + 30 * 60_000)
      if (expires <= this.clock.now()) throw expired()
      const flowId = this.id()
      this.flows.set(flowId, { tv, clientId, pinId: pin.pinId, expires, controller: new AbortController(),
        connections: new Map(), added: new Map() })
      return { flowId, code: pin.code, where: 'plex.tv/link', expiresAt: new Date(expires).toISOString() }
    } catch (error) { tv.dispose(); throw error } finally { this.creating.delete(tv) }
  }
  has(id: string): boolean { return this.flows.has(id) }
  prune(): void { for (const [id, flow] of this.flows) if (flow.expires <= this.clock.now()) this.cancel(id) }
  private valid(id: string, flow: Flow): boolean { return this.flows.get(id) === flow && flow.expires > this.clock.now() }
  async poll(id: string): Promise<SignInPoll> {
    this.prune()
    const flow = this.flows.get(id)
    if (!flow) return { state: 'expired' }
    if (flow.choices) return { state: 'chooseServers', servers: structuredClone(flow.choices) }
    if (flow.pending || flow.lastPoll !== undefined && this.clock.now() - flow.lastPoll < 4000) return { state: 'waiting' }
    flow.lastPoll = this.clock.now()
    flow.pending = this.pollServer(id, flow).finally(() => { flow.pending = undefined })
    return flow.pending
  }
  private async pollServer(id: string, flow: Flow): Promise<SignInPoll> {
    try {
      if (!flow.token) {
        try { flow.token = await flow.tv.checkPin(flow.pinId) } catch (error) {
          if (error instanceof PlexHttpError && error.status === 404) { this.cancel(id); return { state: 'expired' } }
          throw error
        }
      }
      if (!this.valid(id, flow)) return { state: 'expired' }
      if (!flow.token) return { state: 'waiting' }
      flow.user ??= await flow.tv.user(flow.token)
      if (!this.valid(id, flow)) return { state: 'expired' }
      flow.servers = await flow.tv.servers(flow.token)
      if (!this.valid(id, flow)) return { state: 'expired' }
      const results = await Promise.all(flow.servers.map(async (server) => {
        const connection = await raceConnections(server, { ...this.opts, clientId: flow.clientId, signal: flow.controller.signal })
        if (connection) flow.connections.set(server.clientIdentifier, connection)
        return { id: server.clientIdentifier, name: server.name, owned: server.owned, reach: reachText(connection) }
      }))
      if (!this.valid(id, flow)) return { state: 'expired' }
      flow.choices = results.sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name))
      flow.tv.dispose()
      return { state: 'chooseServers', servers: structuredClone(flow.choices) }
    } catch (error) {
      if (!this.valid(id, flow)) return { state: 'expired' }
      return { state: 'error', message: error instanceof SourceError ? error.message : "Couldn't save the sign-in. Try again." }
    }
  }
  async addServers(id: string, ids: string[]): Promise<SourceInfo[]> {
    this.prune()
    const flow = this.flows.get(id)
    if (!flow?.choices || !flow.user || !flow.token || !flow.servers) throw expired()
    if (ids.some((id) => !flow.servers!.some((s) => s.clientIdentifier === id))) {
      throw new SourceError('Choose a server from the list.', 'notFound')
    }
    const unique = [...new Set(ids)]
    const items = unique.map((id): PlexAddition => ({ server: flow.servers!.find((s) => s.clientIdentifier === id)!,
      user: flow.user!, accountToken: flow.token!, clientId: flow.clientId, connection: flow.connections.get(id) }))
    // The save queue checks the entire selection's limit before writing the first secret.
    await this.opts.save(items, () => this.valid(id, flow), (serverId, source) => { flow.added.set(serverId, source) })
    return unique.map((id) => structuredClone(flow.added.get(id)!))
  }
  /** Queried inside the shared save queue, so concurrent repeated add calls cannot write duplicates. */
  alreadyAdded(item: PlexAddition): SourceInfo | undefined {
    for (const flow of this.flows.values()) {
      if (flow.clientId === item.clientId) return flow.added.get(item.server.clientIdentifier)
    }
    return undefined
  }
  cancel(id: string): void {
    const flow = this.flows.get(id)
    flow?.controller.abort(); flow?.tv.dispose(); this.flows.delete(id)
  }
  cancelAll(): void {
    this.generation++
    for (const tv of this.creating) tv.dispose()
    this.creating.clear()
    for (const id of this.flows.keys()) this.cancel(id)
  }
  dispose(): void { this.disposed = true; this.cancelAll() }
}
