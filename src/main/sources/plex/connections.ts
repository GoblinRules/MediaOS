import { PlexClient, connectionUrl } from './PlexClient'
import type { PlexConnection, PlexIdentity, PlexServer } from './PlexTv'
import { object } from './guards'

export interface Connection { url: string; tier: 'local' | 'remote' | 'relay' }
interface Candidate extends Connection { rank: number }
export const reachText = (connection?: Connection): string => connection?.tier === 'local' ? 'On this network' :
  connection?.tier === 'remote' ? 'Over the internet' : connection?.tier === 'relay' ? 'Through Plex Relay (slow)' :
    'Not reachable right now'

function candidates(connections: PlexConnection[]): Candidate[] {
  const results = new Map<string, Candidate>()
  const add = (value: string, c: PlexConnection): void => {
    const url = connectionUrl(value)
    if (!url) return
    const rank = c.relay ? 3 : c.local ? new URL(url).protocol === 'https:' ? 0 : 1 : 2
    const existing = results.get(url)
    if (!existing || existing.rank > rank) results.set(url, { url, rank, tier: c.relay ? 'relay' : c.local ? 'local' : 'remote' })
  }
  for (const c of connections) {
    add(c.uri, c)
    const safe = connectionUrl(c.uri)
    if (safe && c.local && !c.relay && new URL(safe).hostname.endsWith('.plex.direct') && c.address &&
      c.port && Number.isInteger(c.port) && c.port > 0 && c.port <= 65535) {
      // Only literal IP addresses may receive the DNS-rebinding fallback.
      const host = c.address.replace(/^\[|\]$/g, '')
      if ((/^[\da-f:]+$/i.test(host) && host.includes(':')) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        add(`http://${host.includes(':') ? `[${host}]` : host}:${c.port}`, c)
      }
    }
  }
  return [...results.values()].sort((a, b) => a.rank - b.rank)
}

/** No credentials are sent until identity has proved which server is at each address. */
export function raceConnections(server: Pick<PlexServer, 'clientIdentifier' | 'connections'>,
  opts: PlexIdentity & { signal?: AbortSignal }): Promise<Connection | undefined> {
  const list = candidates(server.connections)
  if (!list.length || opts.signal?.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const clients = list.map((c) => new PlexClient({ ...opts, url: c.url, name: 'Plex', token: undefined }))
    const pending = new Set(list.map((_, i) => i))
    const answers = new Set<number>()
    let done = false
    const finish = (index?: number): void => {
      if (done) return
      done = true
      opts.signal?.removeEventListener('abort', cancel)
      clients.forEach((c) => c.dispose())
      const best = index === undefined ? undefined : list[index]
      resolve(best ? { url: best.url, tier: best.tier } : undefined)
    }
    const cancel = (): void => finish()
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const settle = (i: number, success: boolean): void => {
      if (done) return
      pending.delete(i)
      if (success) answers.add(i)
      const best = [...answers].sort((a, b) => list[a]!.rank - list[b]!.rank)[0]
      if (best !== undefined && ![...pending].some((p) => list[p]!.rank < list[best]!.rank)) finish(best)
      else if (!pending.size) finish()
    }
    clients.forEach((client, i) => {
      void client.request('/identity', {}, 'GET', { timeoutMs: 4000, signal: opts.signal }).then((reply) => {
        settle(i, object(object(reply)?.MediaContainer)?.machineIdentifier === server.clientIdentifier)
      }, () => settle(i, false))
    })
  })
}

export function savedConnection(url: string, serverId: string, opts: PlexIdentity & { signal?: AbortSignal }):
Promise<Connection | undefined> {
  const safe = connectionUrl(url)
  return raceConnections({ clientIdentifier: serverId, connections: safe ? [
    { uri: safe, local: true, relay: false, IPv6: false },
  ] : [] }, opts)
}
