import { randomUUID } from 'node:crypto'
import { delay, runtime, type Runtime } from '../../core/runtime'
import type { VpnBackend, VpnDeviceStatus } from '../VpnBackend'
import type { WgConfig } from '../wg-config'

export const VPN_SCENARIOS = ['vpn-default', 'vpn-down', 'vpn-not-working', 'vpn-import-errors'] as const
export type VpnScenario = typeof VPN_SCENARIOS[number]
export class MockVpnBackend implements VpnBackend {
  private profiles = new Map<string, { name: string; address: string }>()
  private active: string | null = null
  constructor(private opts: { scenario?: VpnScenario; delayMs?: number; clock?: Runtime } = {}) {}
  async importProfile(config: WgConfig, label: string): Promise<string> {
    if (this.opts.scenario === 'vpn-import-errors') throw new Error("The VPN location couldn't be saved. Try again.")
    const uuid = randomUUID(); this.profiles.set(uuid, { name: `MediaOS VPN - ${label}`, address: config.address }); return uuid
  }
  async listProfiles() { return [...this.profiles].map(([uuid, p]) => ({ uuid, name: p.name, type: 'wireguard' })) }
  async address(uuid: string): Promise<string | null> { return this.profiles.get(uuid)?.address ?? null }
  async setAutoconnect(_uuid: string, _on: boolean): Promise<void> {}
  async up(uuid: string, _tunIp: string): Promise<void> {
    await delay(this.opts.delayMs ?? 0, this.opts.clock ?? runtime)
    this.active = uuid
  }
  async down(uuid: string): Promise<void> { if (this.active === uuid) this.active = null }
  async remove(uuid: string): Promise<void> { await this.down(uuid); this.profiles.delete(uuid) }
  async status(): Promise<VpnDeviceStatus> {
    const ip = this.active && this.profiles.get(this.active)?.address
    return ip && this.opts.scenario !== 'vpn-down' ? { state: 'up', tunIp: ip } : { state: 'absent', tunIp: null }
  }
  async routingOk(_tunIp: string): Promise<boolean> { return true }
  async probe(_tunIp: string, _dns: string | null, _timeoutMs: number): Promise<boolean> {
    return this.opts.scenario !== 'vpn-not-working'
  }
}
