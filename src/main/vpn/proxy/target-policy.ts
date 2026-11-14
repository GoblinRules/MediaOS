import { isIPv4 } from 'node:net'

export function validTunnelAddress(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const first = Number(ip.split('.')[0])
  return first > 0 && first !== 127 && first < 224
}

export function refusedIPv4(ip: string, tunIp: string | null): boolean {
  if (!isIPv4(ip) || ip === tunIp) return true
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function refusedDomain(host: string): boolean {
  const domain = host.toLowerCase().replace(/\.$/, '')
  return domain === 'localhost' || domain.endsWith('.localhost') ||
    domain.split('.').every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label))
}
