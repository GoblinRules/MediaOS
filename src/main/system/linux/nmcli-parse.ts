import type { DnsChoice, IpConfig, NetProfile } from '@shared/system-types'
import { DNS_PRESETS } from '@shared/dns-presets'
import { parseIpv4 } from '@shared/ipv4'

/** Decode escapes while splitting; show output splits only at its first unescaped colon. */
export function terse(line: string, firstOnly = false): string[] {
  const out = ['']
  let escaped = false
  for (const char of line) {
    if (escaped) { out[out.length - 1] += char; escaped = false }
    else if (char === '\\') escaped = true
    else if (char === ':' && (!firstOnly || out.length === 1)) out.push('')
    else out[out.length - 1] += char
  }
  if (escaped) out[out.length - 1] += '\\'
  return out
}
export function rows(text: string): string[][] { return text.split(/\r?\n/).filter(Boolean).map((line) => terse(line)) }
export function properties(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => terse(line, true)).filter((r) => r.length === 2))
}
export function values(props: Record<string, string>, key: string): string[] {
  const indexed = Object.keys(props).filter((k) => k.startsWith(`${key}[`)).sort((a, b) =>
    Number(a.slice(key.length + 1, -1)) - Number(b.slice(key.length + 1, -1)))
  return (indexed.length ? indexed.map((k) => props[k] ?? '') : [props[key] ?? ''])
    .flatMap((v) => v.split(',').map((part) => part.trim()).filter(Boolean))
}
export function cidr(text: string): { address: string; prefix: number } | undefined {
  const [address = '', bits] = text.split('/')
  const prefix = Number(bits)
  return parseIpv4(address) !== undefined && bits !== undefined && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32
    ? { address, prefix } : undefined
}
export function deviceStatus(text: string) {
  return rows(text).map(([device = '', type = '', state = '', uuid = '']) => ({ device, type, state, uuid }))
}
export function deviceShow(text: string) {
  const props = properties(text)
  const address = cidr(values(props, 'IP4.ADDRESS')[0] ?? '')
  return { state: Number.parseInt(props['GENERAL.STATE'] ?? '0', 10), mac: props['GENERAL.HWADDR'],
    live: address ? { ...address, gateway: props['IP4.GATEWAY'] || undefined, dns: values(props, 'IP4.DNS') } : undefined }
}
export function connectionList(text: string) {
  return rows(text).map(([name = '', uuid = '', type = '', device = '', active]) => ({ name, uuid, type, device, active: active === 'yes' }))
}
export const connectionSettings = properties
export function configFrom(props: Record<string, string>): IpConfig | undefined {
  const method = props['ipv4.method']
  if (method !== 'auto' && method !== 'manual') return undefined
  const servers = values(props, 'ipv4.dns')
  const preset = DNS_PRESETS.find((p) => p.ipv4.length === servers.length && p.ipv4.every((v, i) => servers[i] === v))
  const dns: DnsChoice = method === 'auto' && props['ipv4.ignore-auto-dns'] !== 'yes' ? { mode: 'auto' }
    : method === 'manual' && servers.length === 1 && servers[0] === props['ipv4.gateway'] ? { mode: 'router' }
    : preset ? { mode: 'preset', preset: preset.id } : { mode: 'custom', servers }
  if (method === 'auto') return { method, dns }
  const address = cidr(values(props, 'ipv4.addresses')[0] ?? '')
  return address ? { method, ...address, gateway: props['ipv4.gateway'] ?? '', dns } : undefined
}
export function profileKind(type: string): NetProfile['kind'] | undefined {
  return type === '802-3-ethernet' ? 'ethernet' : type === '802-11-wireless' ? 'wifi' : undefined
}
function objects(text: string): Record<string, unknown>[] {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data) || data.some((v: unknown) => !v || typeof v !== 'object' || Array.isArray(v))) {
    throw new Error('Invalid network reply')
  }
  return data as Record<string, unknown>[]
}
export function routes(text: string) {
  return objects(text).filter((v) => v.dst === 'default' && typeof v.dev === 'string')
    .map((v) => ({ device: String(v.dev), gateway: typeof v.gateway === 'string' ? v.gateway : undefined,
      metric: typeof v.metric === 'number' ? v.metric : 0 }))
}
export function neighbours(text: string) {
  return objects(text).map((v) => ({ address: String(v.dst ?? ''), lladdr: typeof v.lladdr === 'string' ? v.lladdr : undefined,
    states: Array.isArray(v.state) ? v.state.filter((s): s is string => typeof s === 'string') : [] }))
}
function busData(text: string, type: string): unknown {
  // Captured create output has a separate "rc=0" annotation after the JSON line.
  const reply: unknown = JSON.parse(text.trim().split(/\r?\n/)[0] ?? '')
  if (!reply || typeof reply !== 'object' || !('type' in reply) || reply.type !== type || !('data' in reply)) {
    throw new Error('Invalid network reply')
  }
  return reply.data
}
export function busPaths(text: string): string[] {
  const data = busData(text, 'ao')
  if (!Array.isArray(data) || !data.every((v: unknown) => typeof v === 'string' && v.startsWith('/'))) {
    throw new Error('Invalid network paths')
  }
  return data as string[]
}
export function busPath(text: string): string {
  const data = busData(text, 'o')
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0] !== 'string' || !data[0].startsWith('/')) {
    throw new Error('Invalid network path')
  }
  return data[0]
}
export function busBool(text: string): boolean {
  const data = busData(text, 'b')
  if (typeof data !== 'boolean') throw new Error('Invalid network boolean')
  return data
}
export function busRollback(text: string): Record<string, number> {
  const data = busData(text, 'a{su}')
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object' || Array.isArray(data[0]) ||
    !Object.values(data[0]).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
    throw new Error('Invalid network rollback')
  }
  return data[0] as Record<string, number>
}
