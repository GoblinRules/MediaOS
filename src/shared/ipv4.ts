// IPv4 helpers shared by the IP settings screen and main's validator. Pure functions, no Node or DOM.
import type { DnsChoice, IpConfig } from './system-types'

/** Dotted quad to a 32-bit unsigned number, or undefined. Leading zeros are refused (some tools read 010 as octal). */
export function parseIpv4(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    value = value * 256 + n
  }
  return value
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

function maskBits(prefix: number): number { return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0 }

/** 24 -> 255.255.255.0. */
export function prefixToMask(prefix: number): string {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Bad prefix ${prefix}`)
  return formatIpv4(maskBits(prefix))
}

/** 255.255.255.0 -> 24; undefined when the mask has gaps (255.0.255.0) or isn't an address. */
export function maskToPrefix(mask: string): number | undefined {
  const value = parseIpv4(mask)
  if (value === undefined) return undefined
  for (let prefix = 0; prefix <= 32; prefix++) if (maskBits(prefix) === value) return prefix
  return undefined
}

export function sameSubnet(a: string, b: string, prefix: number): boolean {
  const x = parseIpv4(a)
  const y = parseIpv4(b)
  if (x === undefined || y === undefined) return false
  const m = maskBits(prefix)
  return ((x & m) >>> 0) === ((y & m) >>> 0)
}

export interface IpProblem { field: 'address' | 'mask' | 'gateway' | 'dns'; message: string }

/** Addresses no home device may use: "this network", loopback, link-local, multicast and above. */
function unusable(value: number): boolean {
  const first = value >>> 24
  return first === 0 || first === 127 || first >= 224 || value >>> 16 === 169 * 256 + 254
}

// docs/design/network.md, "Validation messages".
const MALFORMED = "That isn't a complete address. It needs four numbers from 0 to 255 with dots between them."
const LEADING_ZERO = 'Leave out zeros at the start of a number: write 10.0.0.5, not 10.0.0.05.'
const RESERVED = 'That number is reserved by the network. Choose another number for the last part.'

/** Why typed text isn't a usable address, or undefined plus its value. */
function readAddress(text: string, empty: string, unusableText: string): { value?: number; message?: string } {
  if (text.trim() === '') return { message: empty }
  const value = parseIpv4(text)
  if (value === undefined) {
    const parts = text.split('.')
    const zeros = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) && parts.some((p) => /^0\d/.test(p))
    return { message: zeros ? LEADING_ZERO : MALFORMED }
  }
  return unusable(value) ? { message: unusableText } : { value }
}

function checkDns(dns: DnsChoice, method: IpConfig['method']): IpProblem | undefined {
  if (dns.mode === 'auto' && method !== 'auto') {
    return { field: 'dns', message: 'With a fixed address, choose the router or a DNS service.' }
  }
  if (dns.mode === 'router' && method !== 'manual') {
    return { field: 'dns', message: 'Choose Automatic DNS, a DNS service, or your own servers.' }
  }
  if (dns.mode === 'custom') {
    if (dns.servers.length < 1) {
      return { field: 'dns', message: 'Type at least one DNS server, or choose one of the ready-made choices.' }
    }
    if (dns.servers.length > 2) return { field: 'dns', message: 'Enter one or two DNS servers.' }
    for (const server of dns.servers) {
      const value = parseIpv4(server)
      if (value === undefined || unusable(value)) {
        return { field: 'dns', message: "That isn't a DNS server address. It looks like 1.1.1.1." }
      }
    }
  }
  return undefined
}

/** Plain-English problem with an IP config, or undefined when it can be tried. */
export function checkIpConfig(cfg: IpConfig): IpProblem | undefined {
  if (cfg.method === 'manual') {
    const { prefix } = cfg
    const address = readAddress(cfg.address, 'Type an address for the box.',
      "That address can't be used on a home network. Use one that starts the same way as your router's address.")
    if (address.value === undefined) return { field: 'address', message: address.message! }
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
      return { field: 'mask', message: "That subnet mask isn't one a home network uses. Most use 255.255.255.0." }
    }
    const hostMask = ~maskBits(prefix) >>> 0
    const host = (address.value & hostMask) >>> 0
    if (host === 0 || host === hostMask) return { field: 'address', message: RESERVED }
    const gateway = readAddress(cfg.gateway, "Type your router's address. It's often on a sticker on the router.",
      "That can't be a router's address. It's often on a sticker on the router.")
    if (gateway.value === undefined) return { field: 'gateway', message: gateway.message! }
    if (gateway.value === address.value) {
      return { field: 'address', message: "That's the router's own address. Choose a different number for the box." }
    }
    if (!sameSubnet(cfg.address, cfg.gateway, prefix)) {
      return { field: 'gateway', message:
        "The router's address doesn't match the box's address and subnet mask. Check both on your router's settings page." }
    }
    const gwHost = (gateway.value & hostMask) >>> 0
    if (gwHost === 0 || gwHost === hostMask) return { field: 'gateway', message: RESERVED }
  }
  return checkDns(cfg.dns, cfg.method)
}
