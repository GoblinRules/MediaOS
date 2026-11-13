import type { CecStatus } from '@shared/system-types'

export interface CecAdapter {
  path: string
  driver: string
  name: string
  capabilities: number
  physicalAddress: string
  logicalAddress?: number
  primaryType?: string
  osdName?: string
}
export const hasPhysicalAddress = (adapter: CecAdapter): boolean => adapter.physicalAddress !== 'f.f.f.f'
export function parseCecAdapters(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/dev\/cec\d+$/.test(line)))]
}
export function parseCecInfo(path: string, stdout: string): CecAdapter | undefined {
  const field = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'm').exec(stdout)?.[1]?.trim()
  const driver = field('Driver Name'), name = field('Adapter Name'), capabilities = field('Capabilities')
  const physicalAddress = field('Physical Address')?.toLowerCase()
  if (!driver || !name || !capabilities || !/^0x[0-9a-f]+$/i.test(capabilities) ||
      !physicalAddress || !/^[0-9a-f](\.[0-9a-f]){3}$/.test(physicalAddress)) return undefined
  const logical = /^(\d+)\b/.exec(field('Logical Address') ?? '')
  const logicalAddress = logical ? Number(logical[1]) : undefined
  return { path, driver, name, capabilities: Number(capabilities), physicalAddress,
    ...(logicalAddress !== undefined && logicalAddress <= 15 ? { logicalAddress } : {}),
    primaryType: field('Primary Device Type'), osdName: field('OSD Name')?.replace(/^'|'$/g, '') }
}
export function cecAdapterName(driver: string): string {
  return driver === 'pulse8-cec' ? 'Pulse-Eight USB-CEC' : driver === 'rainshadow-cec' ? 'RainShadow HDMI-CEC' : 'HDMI-CEC adapter'
}
export function parseTvName(stdout: string): string | undefined {
  return /SET_OSD_NAME \(0x47\):\s*\r?\n\s*name:\s*([^\r\n]+)/.exec(stdout)?.[1]?.trim() || undefined
}
export function parseTvPower(stdout: string): CecStatus['tvPower'] {
  if (/FEATURE_ABORT/.test(stdout)) return 'unknown'
  const state = /REPORT_POWER_STATUS \(0x90\):\s*\r?\n\s*pwr-state:\s*(on|standby|to-on|to-standby)\b/.exec(stdout)?.[1]
  return state === 'on' || state === 'to-on' ? 'on' : state === 'standby' || state === 'to-standby' ? 'standby' : 'unknown'
}
