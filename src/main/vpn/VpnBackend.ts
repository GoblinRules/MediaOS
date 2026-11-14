import type { WgConfig } from './wg-config'

export interface VpnDeviceStatus { state: 'up' | 'connecting' | 'absent' | 'unknown'; tunIp: string | null }
export interface VpnBackend {
  importProfile(config: WgConfig, label: string): Promise<string>
  listProfiles(): Promise<{ uuid: string; name: string; type: string }[] | null>
  /** Read the configured address, including when the profile is inactive after a shell restart. */
  address(uuid: string): Promise<string | null>
  setAutoconnect(uuid: string, on: boolean): Promise<void>
  up(uuid: string, tunIp: string): Promise<void>
  down(uuid: string): Promise<void>
  remove(uuid: string): Promise<void>
  status(): Promise<VpnDeviceStatus>
  routingOk(tunIp: string): Promise<boolean>
  probe(tunIp: string, dns: string | null, timeoutMs: number): Promise<boolean>
}
