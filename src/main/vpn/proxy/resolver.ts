import { Resolver } from 'node:dns/promises'
import { isIPv4 } from 'node:net'
import { runtime, type Runtime } from '../../core/runtime'
import { validTunnelAddress } from './target-policy'

export interface ResolverLike {
  setLocalAddress(address: string): void
  setServers(servers: string[]): void
  resolve4(host: string, options: { ttl: true }): Promise<{ address: string; ttl: number }[]>
  cancel(): void
}

export class TunnelResolver {
  private resolver: ResolverLike | null = null
  private tunIp: string | null = null
  private dns: string | null = null
  private cache = new Map<string, { addresses: string[]; expires: number }>()

  constructor(private clock: Runtime = runtime,
    private factory: () => ResolverLike = () => new Resolver({ timeout: 3000, tries: 2 })) {}

  setTunnel({ tunIp, dns }: { tunIp: string | null; dns: string | null }): void {
    if (tunIp === this.tunIp && dns === this.dns) return
    if ((tunIp !== null && !validTunnelAddress(tunIp)) || (dns !== null && !validTunnelAddress(dns))) {
      throw new Error('Invalid tunnel address')
    }
    this.resolver?.cancel(); this.resolver = null; this.cache.clear()
    this.tunIp = tunIp; this.dns = dns
    if (tunIp) {
      const resolver = this.factory()
      resolver.setLocalAddress(tunIp); resolver.setServers([dns ?? '9.9.9.9'])
      this.resolver = resolver
    }
  }

  async resolve(host: string): Promise<string[]> {
    const resolver = this.resolver
    if (!resolver) throw new Error('Tunnel is unavailable')
    const key = host.toLowerCase(), cached = this.cache.get(key)
    if (cached && cached.expires > this.clock.now()) return [...cached.addresses]
    this.cache.delete(key)
    const records = await resolver.resolve4(key, { ttl: true })
    if (resolver !== this.resolver) throw new Error('Tunnel changed')
    const addresses = records.map((record) => record.address).filter(isIPv4)
    if (!addresses.length) throw new Error('No IPv4 answer')
    const ttl = Math.max(30, Math.min(300, ...records.map((record) => record.ttl)))
    if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, { addresses, expires: this.clock.now() + ttl * 1000 })
    return [...addresses]
  }
}
