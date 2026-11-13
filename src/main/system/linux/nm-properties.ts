import type { IpConfig } from '@shared/system-types'
import { isIPv6 } from 'node:net'
import { dnsPreset } from '@shared/dns-presets'
import { checkIpConfig, parseIpv4 } from '@shared/ipv4'
import { APPLY_FAILED, NOT_ALLOWED } from '../net/texts'
import type { CommandResult } from './CommandRunner'

export const SNAPSHOT_KEYS = ['ipv4.method', 'ipv4.addresses', 'ipv4.gateway', 'ipv4.dns', 'ipv4.ignore-auto-dns',
  'ipv4.dad-timeout', 'ipv6.dns', 'ipv6.ignore-auto-dns'] as const
export const SETTINGS_FIELDS = ['connection.id', '802-11-wireless.ssid', 'ipv6.method', ...SNAPSHOT_KEYS].join(',')
export const LIVE_FIELDS = 'GENERAL.STATE,GENERAL.HWADDR,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS'
export const NM = 'org.freedesktop.NetworkManager'
export const ROOT = '/org/freedesktop/NetworkManager'
export const SETTINGS = `${ROOT}/Settings`
export const CONNECTION = `${NM}.Settings.Connection`
export const ok = { ok: true } as const
export const fail = (error = APPLY_FAILED) => ({ ok: false, error }) as const
export function uuid(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error(APPLY_FAILED)
  return value
}
export function device(value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,14}$/.test(value) || value.startsWith('mosvpn')) throw new Error(APPLY_FAILED)
  return value
}
export function objectPath(value: string): string {
  if (!/^\/(?:[a-zA-Z0-9_]+\/)*[a-zA-Z0-9_]+$/.test(value)) throw new Error(APPLY_FAILED)
  return value
}
export function configArgs(cfg: IpConfig, ipv6Method?: string): string[] {
  const problem = checkIpConfig(cfg)
  if (problem) throw new Error(problem.message)
  const preset = cfg.dns.mode === 'preset' ? dnsPreset(cfg.dns.preset) : undefined
  const auto = cfg.dns.mode === 'auto'
  const dns = preset?.ipv4 ?? (cfg.dns.mode === 'custom' ? cfg.dns.servers
    : cfg.method === 'manual' && cfg.dns.mode === 'router' ? [cfg.gateway] : [])
  return ['ipv4.method', cfg.method, 'ipv4.addresses', cfg.method === 'manual' ? `${cfg.address}/${cfg.prefix}` : '',
    'ipv4.gateway', cfg.method === 'manual' ? cfg.gateway : '', 'ipv4.ignore-auto-dns', auto ? 'no' : 'yes',
    'ipv4.dns', dns.join(','), 'ipv4.dad-timeout', cfg.method === 'manual' ? '3000' : '-1',
    'ipv6.ignore-auto-dns', auto ? 'no' : 'yes', 'ipv6.dns',
    ipv6Method === 'disabled' || ipv6Method === 'ignore' ? '' : preset?.ipv6.join(',') ?? '']
}
export class CommandFailed extends Error {
  constructor(readonly result: CommandResult) {
    super(!('fail' in result) && /Not authorized|Insufficient privileges|PermissionDenied/i.test(result.stderr)
      ? NOT_ALLOWED : APPLY_FAILED)
  }
}
export interface NmSnapshot { uuid: string; device: string; properties: Record<string, string> }
export function snapshotValue(value: unknown): NmSnapshot {
  if (!value || typeof value !== 'object' || !('uuid' in value) || typeof value.uuid !== 'string' ||
    !('device' in value) || typeof value.device !== 'string' || !('properties' in value) ||
    !value.properties || typeof value.properties !== 'object') throw new Error(APPLY_FAILED)
  uuid(value.uuid)
  if (value.device) device(value.device)
  const props = value.properties as Record<string, unknown>
  for (const key of SNAPSHOT_KEYS) {
    const v = props[key]
    if (typeof v !== 'string' || [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || !validProperty(key, v)) {
      throw new Error(APPLY_FAILED)
    }
  }
  return { uuid: value.uuid, device: value.device, properties: props as Record<string, string> }
}

function validProperty(key: typeof SNAPSHOT_KEYS[number], value: string): boolean {
  if (value === '') return true
  const ipv4 = (part: string) => parseIpv4(part) !== undefined
  switch (key) {
    case 'ipv4.method': return ['auto', 'manual', 'link-local', 'shared', 'disabled'].includes(value)
    case 'ipv4.addresses': return value.split(',').every((part) => {
      const match = /^(.+)\/(\d{1,2})$/.exec(part)
      return !!match && ipv4(match[1]!) && Number(match[2]) <= 32
    })
    case 'ipv4.gateway': return ipv4(value)
    case 'ipv4.dns': return value.split(',').every(ipv4)
    case 'ipv4.ignore-auto-dns':
    case 'ipv6.ignore-auto-dns': return value === 'yes' || value === 'no'
    case 'ipv4.dad-timeout': return /^(?:-1|\d+)$/.test(value) && Number.isInteger(Number(value))
    case 'ipv6.dns': return value.split(',').every(isIPv6)
  }
}
