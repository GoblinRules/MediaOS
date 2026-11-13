import { randomUUID, randomInt } from 'node:crypto'
import type { CallResults, PlexServerChoice, SignInStart } from '@shared/ipc-contract'
import type { SourceInfo } from '@shared/media-types'
import { SourceError } from '../sources/MediaSource'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../sources/limits'
import { FixtureSource } from '../sources/fixture/FixtureSource'
import type { MediaHub } from '../hub/MediaHub'
import type { SettingsStore } from '../settings/SettingsStore'
import type { SignInService } from './types'
import { runtime, type Runtime } from '../core/runtime'

interface Flow {
  kind: 'jellyfin' | 'plex'; expires: number; polls: number
  source?: SourceInfo; choices?: PlexServerChoice[]; added?: SourceInfo[]
}
export interface MockSignInOptions { clock?: Runtime; delayMs?: number; fixtureLatencyMs?: number; id?: () => string }

export class MockSignInService implements SignInService {
  private flows = new Map<string, Flow>()
  private clock: Runtime
  private cleanup: ReturnType<typeof setInterval>
  private waiting = new Map<ReturnType<typeof setTimeout>, () => void>()
  constructor(private hub: MediaHub, private settings: SettingsStore, private opts: MockSignInOptions = {}) {
    this.clock = opts.clock ?? runtime
    this.cleanup = this.clock.setInterval(() => this.prune(), 60_000)
  }
  private prune(): void { for (const [id, flow] of this.flows) if (flow.expires <= this.clock.now()) this.flows.delete(id) }
  private id(): string { return (this.opts.id ?? randomUUID)() }
  async discover(): Promise<CallResults['jellyfin.discover']> {
    const ms = this.opts.delayMs ?? 800
    if (ms > 0) await new Promise<void>((resolve) => {
      const done = () => { this.waiting.delete(timer); resolve() }
      const timer = this.clock.setTimeout(done, ms)
      this.waiting.set(timer, done)
    })
    return [{ id: 'mock-jellyfin', name: 'Living Room Jellyfin', url: 'http://192.168.1.20:8096' }]
  }
  async probe(value: string): Promise<CallResults['jellyfin.probe']> {
    let url: URL
    try { url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bad scheme') } catch {
      throw new SourceError('That server address is not valid. Start it with http:// or https://.', 'unsupported')
    }
    if (url.hostname === 'offline.invalid') throw new SourceError(
      "Can't reach that server. Check the address and that the server is switched on.", 'offline')
    // Credentials and token queries from an entered URL must never be persisted in ordinary settings.
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return { serverName: 'Living Room Jellyfin', version: '10.11.0', quickConnect: true, url: url.toString().replace(/\/$/, '') }
  }
  private begin(kind: Flow['kind']): SignInStart {
    this.checkLimit(1)
    this.prune()
    const flowId = this.id()
    const expires = this.clock.now() + 600_000
    this.flows.set(flowId, { kind, expires, polls: 0 })
    return { flowId, code: kind === 'jellyfin' ? String(randomInt(100000, 1000000)) :
      randomInt(0, 36 ** 4).toString(36).padStart(4, '0').toUpperCase(),
    where: kind === 'jellyfin' ? 'Jellyfin > Quick Connect' : 'plex.tv/link',
    ...(kind === 'plex' ? { qrUrl: 'https://plex.tv/link' } : {}), expiresAt: new Date(expires).toISOString() }
  }
  async quickConnect(url: string): Promise<CallResults['jellyfin.quickConnect']> {
    this.checkLimit(1)
    await this.probe(url)
    return this.begin('jellyfin')
  }
  async password(url: string, _user: string, pw: string): Promise<SourceInfo> {
    this.checkLimit(1)
    await this.probe(url)
    if (pw !== 'demo') throw new SourceError("That user name or password didn't work.", 'auth')
    return this.add('Living Room Jellyfin')
  }
  async plexPin(): Promise<CallResults['plex.pin']> { return this.begin('plex') }
  async poll(flowId: string): Promise<CallResults['signin.poll']> {
    this.prune()
    const flow = this.flows.get(flowId)
    if (!flow) return { state: 'expired' }
    if (++flow.polls <= 2) return { state: 'waiting' }
    if (flow.kind === 'jellyfin') {
      flow.source ??= this.add('Living Room Jellyfin')
      return { state: 'done', source: flow.source }
    }
    flow.choices ??= [
      { id: 'home-plex', name: 'Home Plex', owned: true, reach: 'On this network' },
      { id: 'dad-plex', name: "Dad's Plex", owned: false, reach: 'Remote (needs Plex Pass to stream)' },
    ]
    return { state: 'chooseServers', servers: structuredClone(flow.choices) }
  }
  async cancel(flowId: string): Promise<CallResults['signin.cancel']> { this.flows.delete(flowId); return { ok: true } }
  async plexAddServers(flowId: string, ids: string[]): Promise<SourceInfo[]> {
    this.prune()
    const flow = this.flows.get(flowId)
    if (!flow || flow.kind !== 'plex' || !flow.choices) throw new SourceError('That sign-in has expired. Sign in again.', 'auth')
    if (ids.some((id) => !flow.choices!.some((s) => s.id === id))) throw new SourceError('Choose a server from the list.', 'notFound')
    if (!flow.added) {
      this.checkLimit(new Set(ids).size)
      flow.added = [...new Set(ids)].map((id) => this.add(flow.choices!.find((s) => s.id === id)!.name))
    }
    return structuredClone(flow.added)
  }
  private add(name: string): SourceInfo {
    this.checkLimit(1)
    const source = new FixtureSource({ id: this.id(), name, latencyMs: this.opts.fixtureLatencyMs ?? 0 })
    const sources = this.settings.get().sources
    this.settings.update({ sources: [...sources, { id: source.id, name, kind: 'fixture', enabled: true }] })
    this.hub.add(source)
    return source.info()
  }
  private checkLimit(count: number): void {
    if (this.settings.get().sources.length + count > MAX_SOURCES) throw new SourceError(SOURCE_LIMIT_MESSAGE, 'unsupported')
  }
  cancelAll(): void { this.flows.clear() }
  dispose(): void {
    this.clock.clearInterval(this.cleanup)
    for (const [timer, done] of this.waiting) { this.clock.clearTimeout(timer); done() }
    this.flows.clear()
  }
}
