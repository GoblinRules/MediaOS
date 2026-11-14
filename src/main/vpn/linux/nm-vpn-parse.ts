import { validTunnelAddress } from '../proxy/target-policy'
import type { VpnDeviceStatus } from '../VpnBackend'
import { rows } from '../../system/linux/nmcli-parse'

export function tunnelAddress(text: string): string | null {
  const ip = text.trim().split('/')[0] ?? ''
  return validTunnelAddress(ip) ? ip : null
}
export function deviceStatus(text: string): VpnDeviceStatus {
  const [state = '', address = ''] = text.trim().split('\n')
  const code = Number(/^\d+/.exec(state)?.[0])
  return { state: code === 100 ? 'up' : code >= 40 && code <= 90 ? 'connecting' : 'absent',
    tunIp: code === 100 ? tunnelAddress(address) : null }
}
export function profiles(text: string): { uuid: string; name: string; type: string }[] | null {
  const parsed = rows(text)
  if (parsed.some((row) => row.length !== 3 || importedUuid(row[0] ?? '') !== row[0] || !row[1] || !row[2])) return null
  return parsed.map(([uuid, name, type]) => ({ uuid: uuid!, name: name!, type: type! }))
}
export function importedUuid(text: string): string | null {
  return /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.exec(text)?.[0] ?? null
}
function objects(text: string): Record<string, unknown>[] | null {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || !parsed.every((v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v))) return null
  return parsed as Record<string, unknown>[]
}
export function routingPresent(rulesText: string, routesText: string, ip: string): boolean {
  try {
    const rules = objects(rulesText), routes = objects(routesText)
    if (!rules || !routes || !validTunnelAddress(ip)) return false
    const source = (r: Record<string, unknown>): boolean => r.src === ip || r.src === `${ip}/32`
    return rules.some((r) => r.priority === 5200 && source(r) && String(r.table) === '51820') &&
      rules.some((r) => r.priority === 5201 && source(r) && r.action === 'unreachable') &&
      routes.some((r) => r.dst === 'default' && r.dev === 'mosvpn0' && (!r.type || r.type === 'unicast'))
  } catch { return false }
}
