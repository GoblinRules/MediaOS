import { isIPv4, isIP } from 'node:net'
import type { VpnImportError } from '../../shared/vpn-types'
import { Secret } from './secret'
import { validTunnelAddress } from './proxy/target-policy'

export interface WgConfig {
  privateKey: Secret; address: string; dns: string[]; mtu: number | null
  peer: { publicKey: string; presharedKey: Secret | null; endpointHost: string; endpointPort: number; keepalive: number }
}
type Result = { ok: true; config: WgConfig; removed: string[] } | { ok: false; error: VpnImportError }
const bad = (error: VpnImportError = 'not-wireguard'): Result => ({ ok: false, error })
const keyValid = (value: string): boolean => /^[A-Za-z0-9+/]{43}=$/.test(value) &&
  Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value
const integer = (value: string, min: number, max: number): boolean => /^\d+$/.test(value) &&
  Number(value) >= min && Number(value) <= max

export function parseWireGuard(input: Buffer): Result {
  if (input.length > 16 * 1024) return bad('too-large')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input).replace(/^\uFEFF/, '') }
  catch { return bad() }
  text = text.replace(/\r\n/g, '\n')
  if ([...text].some((c) => {
    const code = c.charCodeAt(0)
    return (code < 32 && c !== '\n' && c !== '\t') || (code >= 127 && code <= 159)
  })) return bad()
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > 200 || lines.some((line) => line.length > 1024)) return bad()
  const removed: string[] = [], notices = new Set<string>()
  const drop = (name: string): void => {
    if (removed.length < 20 && !notices.has(name.toLowerCase())) {
      notices.add(name.toLowerCase()); removed.push(name.slice(0, 40))
    }
  }
  let section = '', interfaces = 0, peers = 0
  const seen = new Set<string>(), values = new Map<string, string[]>()
  let address = '', mtu: number | null = null, keepalive = 25
  const dns: string[] = []
  for (const raw of lines) {
    const line = raw.split('#', 1)[0]!.trim()
    if (!line) continue
    const header = /^\[([A-Za-z]+)\]$/.exec(line)
    if (header) {
      section = header[1]!.toLowerCase()
      if (section === 'interface') { if (++interfaces > 1) return bad() }
      else if (section === 'peer') { if (++peers > 1) return bad('several-peers') }
      else return bad()
      continue
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !section) return bad()
    const name = match[1]!, key = name.toLowerCase(), value = match[2]!.trim(), id = `${section}.${key}`
    if (seen.has(id) && !['address', 'dns', 'allowedips'].includes(key)) return bad()
    seen.add(id)
    const allowed = section === 'interface' ? ['privatekey', 'address', 'dns', 'mtu'] :
      ['publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive']
    if (!allowed.includes(key)) { drop(name); continue }
    values.set(id, [...(values.get(id) ?? []), value])
    if (['privatekey', 'publickey', 'presharedkey'].includes(key) && !keyValid(value)) return bad()
    if (key === 'address') {
      for (const item of value.split(',').map((v) => v.trim())) {
        const parts = item.split('/'), ip = parts[0]!, version = isIP(ip)
        if (parts.length > 2 || !version || (parts[1] !== undefined &&
          !integer(parts[1], 0, version === 4 ? 32 : 128))) return bad()
        if (version === 6) drop('Address (IPv6)')
        else if (!validTunnelAddress(ip)) return bad()
        else if (address) drop('Address (extra)')
        else address = ip
      }
    }
    if (key === 'dns') {
      for (const item of value.split(',').map((v) => v.trim())) {
        if (isIPv4(item)) { if (validTunnelAddress(item)) dns.push(item); else drop('DNS (invalid)') }
        else drop('DNS (search domain)')
      }
    }
    if (key === 'mtu') { if (integer(value, 1280, 1500)) mtu = Number(value); else drop('MTU') }
    if (key === 'persistentkeepalive') {
      if (integer(value, 0, 120)) keepalive = Number(value); else drop('PersistentKeepalive')
    }
  }
  if (!interfaces) return bad()
  const get = (id: string): string => values.get(id)?.join(',') ?? ''
  if (!get('interface.privatekey')) return bad('no-private-key')
  if (!peers || !address || !get('peer.publickey')) return bad()
  const endpoint = /^([A-Za-z0-9.-]{1,253}):(\d+)$/.exec(get('peer.endpoint'))
  if (!endpoint || endpoint[1]!.split('.').some((label) => !label) || !integer(endpoint[2]!, 1, 65535)) return bad()
  const ranges = get('peer.allowedips').split(',').map((v) => v.trim())
  if (!get('peer.allowedips')) return bad('not-full-tunnel')
  for (const range of ranges) {
    const parts = range.split('/'), version = isIP(parts[0]!)
    if (parts.length !== 2 || !version || !integer(parts[1]!, 0, version === 4 ? 32 : 128)) return bad()
  }
  if (!ranges.includes('0.0.0.0/0')) return bad('not-full-tunnel')
  return { ok: true, removed, config: {
    privateKey: new Secret(get('interface.privatekey')), address, dns, mtu,
    peer: { publicKey: get('peer.publickey'), presharedKey: get('peer.presharedkey') ?
      new Secret(get('peer.presharedkey')) : null, endpointHost: endpoint[1]!, endpointPort: Number(endpoint[2]), keepalive },
  } }
}

export function buildImportFile(config: WgConfig): string {
  const peer = config.peer
  return ['[Interface]', `PrivateKey = ${config.privateKey.reveal()}`, `Address = ${config.address}/32`,
    ...(config.mtu === null ? [] : [`MTU = ${config.mtu}`]), 'Table = off', '', '[Peer]', `PublicKey = ${peer.publicKey}`,
    ...(peer.presharedKey ? [`PresharedKey = ${peer.presharedKey.reveal()}`] : []), 'AllowedIPs = 0.0.0.0/1, 128.0.0.0/1',
    `Endpoint = ${peer.endpointHost}:${peer.endpointPort}`, `PersistentKeepalive = ${peer.keepalive}`, ''].join('\n')
}
