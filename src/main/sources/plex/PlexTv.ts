import { PlexClient, connectionUrl, type PlexClientOptions } from './PlexClient'
import { array, object, string, number, identifier, flag, records } from './guards'

export interface PlexConnection {
  uri: string; address?: string; port?: number; protocol?: string; local: boolean; relay: boolean; IPv6: boolean
}
export interface PlexServer {
  clientIdentifier: string; name: string; owned: boolean; accessToken: string; connections: PlexConnection[]
}
export interface PlexUser { userId: string; userName?: string }
export type PlexIdentity = Omit<PlexClientOptions, 'url' | 'name' | 'token' | 'onAuthError'>

export class PlexTv {
  private api: PlexClient
  private resources: PlexClient
  constructor(opts: PlexIdentity) {
    this.now = opts.clock ? () => opts.clock!.now() : () => Date.now()
    this.api = new PlexClient({ ...opts, url: 'https://plex.tv', name: 'Plex', token: undefined })
    this.resources = new PlexClient({ ...opts, url: 'https://clients.plex.tv', name: 'Plex', token: undefined })
  }
  async createPin(): Promise<{ pinId: string; code: string; expiresAt: number }> {
    const raw = object(await this.api.request('/api/v2/pins', { strong: false }, 'POST'))
    const pinId = identifier(raw?.id), code = string(raw?.code)
    const iso = string(raw?.expiresAt), seconds = number(raw?.expiresIn)
    const expiresAt = iso ? Date.parse(iso) : seconds !== undefined ? (this.now() + seconds * 1000) : NaN
    if (!pinId || !code || !Number.isFinite(expiresAt)) throw this.api.failure('server')
    return { pinId, code, expiresAt }
  }
  private now: () => number
  async checkPin(pinId: string): Promise<string | undefined> {
    const raw = object(await this.api.request(`/api/v2/pins/${encodeURIComponent(pinId)}`))
    const token = string(raw?.authToken, 8192)
    return token?.trim() ? token : undefined
  }
  async user(token: string): Promise<PlexUser> {
    const raw = object(await this.api.request('/api/v2/user', {}, 'GET', { headers: { 'X-Plex-Token': token } }))
    const userId = identifier(raw?.id)
    if (!userId) throw this.api.failure('server')
    return { userId, userName: string(raw?.username, 200) || string(raw?.title, 200) }
  }
  async servers(token: string): Promise<PlexServer[]> {
    const raw = await this.resources.request('/api/v2/resources', { includeHttps: 1, includeRelay: 1, includeIPv6: 1 },
      'GET', { headers: { 'X-Plex-Token': token } })
    if (!array(raw)) throw this.resources.failure('server')
    const seen = new Set<string>()
    return records(raw).flatMap((s) => {
      const id = identifier(s.clientIdentifier)
      if (!id || seen.has(id) || !string(s.provides)?.split(',').map((v) => v.trim()).includes('server')) return []
      const connections = records(s.connections).flatMap((c): PlexConnection[] => {
        const uri = string(c.uri, 8192), safe = uri && connectionUrl(uri)
        if (!safe) return []
        return [{ uri: safe, address: string(c.address), port: number(c.port), protocol: string(c.protocol),
          local: flag(c.local), relay: flag(c.relay), IPv6: flag(c.IPv6) }]
      })
      if (!connections.length) return []
      seen.add(id)
      return [{ clientIdentifier: id, name: string(s.name, 80) || 'Plex server', owned: flag(s.owned),
        accessToken: string(s.accessToken, 8192) || token, connections }]
    })
  }
  dispose(): void { this.api.dispose(); this.resources.dispose() }
}
