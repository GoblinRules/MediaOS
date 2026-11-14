import type { NetworkInterfaceInfo } from 'node:os'
import { parseIpv4 } from '../../shared/ipv4'

export function normaliseAddress(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/i, '')
}
export function privateIpv4(address: string): boolean {
  const value = parseIpv4(address)
  if (value === undefined) return false
  return value >>> 24 === 10 || value >>> 20 === 0xac1 || value >>> 16 === 0xc0a8 || value >>> 16 === 0xa9fe
}
export function allowedSource(source: string | undefined, bindHost: string): boolean {
  const address = normaliseAddress(source)
  return bindHost === '127.0.0.1' ? address === bindHost : privateIpv4(address)
}
export function allowedSocket(source: string | undefined, local: string | undefined, bindHost: string): boolean {
  return allowedSource(source, bindHost) && normaliseAddress(local) === bindHost
}
export function lanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(mosvpn|docker|br-|veth|virbr)/i.test(name)) continue
    for (const info of addresses ?? []) {
      if (info.family === 'IPv4' && !info.internal && privateIpv4(info.address)) return info.address
    }
  }
  return null
}

/** At most this many sources are tracked per minute; a new source beyond it is refused but still counts in the total. */
export const MAX_TRACKED_SOURCES = 64

/** Sliding windows retain the most recent attempts needed to decide each limit, including refusals. */
export class RequestLimits {
  private sources = new Map<string, number[]>()
  private total: number[] = []
  get trackedSources(): number { return this.sources.size }
  allow(source: string, now: number): boolean {
    const since = now - 60000
    this.total = this.total.filter((time) => time > since)
    for (const [key, times] of this.sources) {
      const current = times.filter((time) => time > since)
      if (current.length) this.sources.set(key, current); else this.sources.delete(key)
    }
    const known = this.sources.get(source)
    if (!known && this.sources.size >= MAX_TRACKED_SOURCES) {
      this.total = [...this.total, now].slice(-30)
      return false
    }
    const times = known ?? []
    const allowed = times.length < 5 && this.total.length < 30
    this.sources.set(source, [...times, now].slice(-5))
    this.total = [...this.total, now].slice(-30)
    return allowed
  }
}
