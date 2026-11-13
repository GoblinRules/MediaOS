import { connect } from 'node:net'
import { Resolver } from 'node:dns'
import { parseIpv4 } from '@shared/ipv4'
import { runtime, type Runtime } from '../../core/runtime'
import type { CommandRunner } from './CommandRunner'
import { neighbours } from './nmcli-parse'

export interface CheckSocket {
  once(event: 'connect', cb: () => void): unknown
  once(event: 'error', cb: (error: { code?: string }) => void): unknown
  destroy(): unknown
}
export interface CheckResolver {
  setServers(servers: string[]): void
  resolve4(host: string, cb: (error: Error | null, addresses: string[]) => void): void
  cancel(): void
}
export interface CheckOptions {
  socket?: (host: string, port: number) => CheckSocket
  resolver?: () => CheckResolver
  clock?: Runtime
}
export interface CheckTarget { device: string; gateway?: string; dns: string[] }
export const NEIGHBOUR_STATES = ['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'PERMANENT']

export function tcpCheck(host: string, port: number, ms: number, refused: boolean, opts: CheckOptions): Promise<boolean> {
  const clock = opts.clock ?? runtime
  return new Promise((resolve) => {
    let socket: CheckSocket | undefined
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clock.clearTimeout(timer)
      socket?.destroy(); resolve(ok)
    }
    const timer = clock.setTimeout(() => finish(false), ms)
    try {
      socket = (opts.socket ?? ((host, port) => connect({ host, port })))(host, port)
      socket.once('connect', () => finish(true))
      socket.once('error', (error) => finish(refused && error.code === 'ECONNREFUSED'))
    } catch { finish(false) }
  })
}
export function resolveCheck(servers: string[], opts: CheckOptions): Promise<string[]> {
  if (!servers.length) return Promise.resolve([])
  const clock = opts.clock ?? runtime
  return new Promise((resolve) => {
    let resolver: CheckResolver | undefined
    let settled = false
    const finish = (addresses: string[]) => {
      if (settled) return
      settled = true; clock.clearTimeout(timer); resolver?.cancel(); resolve(addresses)
    }
    const timer = clock.setTimeout(() => finish([]), 3000)
    try {
      resolver = (opts.resolver ?? (() => new Resolver()))()
      resolver.setServers(servers)
      resolver.resolve4('deb.debian.org', (error, addresses) => finish(error ? [] : addresses))
    } catch { finish([]) }
  })
}
/** Share one effective-target read and DNS lookup between the three concurrent trial checks. */
export function networkChecks(target: () => Promise<CheckTarget>, runner: CommandRunner, opts: CheckOptions = {}) {
  let current: Promise<CheckTarget> | undefined
  let resolved: Promise<string[]> | undefined
  const read = () => current ??= target()
  const addresses = () => resolved ??= read().then((t) => resolveCheck(t.dns, opts)).catch(() => [])
  return {
    router: async (): Promise<boolean> => {
      try {
        const t = await read()
        if (!t.gateway || parseIpv4(t.gateway) === undefined) return false
        if (await tcpCheck(t.gateway, 53, 1500, true, opts) || await tcpCheck(t.gateway, 80, 1500, true, opts)) return true
        const result = await runner.run('ip', ['-j', 'neigh', 'show', t.gateway, 'dev', t.device], { timeoutMs: 5000 })
        return !('fail' in result) && result.code === 0 && neighbours(result.stdout).some((n) =>
          n.address === t.gateway && !!n.lladdr && n.states.some((s) => ['REACHABLE', 'STALE', 'DELAY'].includes(s)))
      } catch { return false }
    },
    dns: async (): Promise<boolean> => (await addresses()).length > 0,
    internet: async (): Promise<boolean> => {
      const list = await addresses()
      return list.length > 0 && tcpCheck(list[0]!, 443, 3000, false, opts)
    },
  }
}
