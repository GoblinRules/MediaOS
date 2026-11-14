import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import type { FileSystem } from '../../settings/atomic'
import type { CommandRunner, CommandResult } from '../../system/linux/CommandRunner'
import { NetQueue } from '../../system/net/NetQueue'
import type { VpnBackend, VpnDeviceStatus } from '../VpnBackend'
import { buildImportFile, type WgConfig } from '../wg-config'
import { probe } from '../probe'
import { deviceStatus, importedUuid, profiles, routingPresent, tunnelAddress } from './nm-vpn-parse'

export interface NmWireGuardOptions { runner: CommandRunner; queue: NetQueue; runtimeDir: string | null; fs?: FileSystem }
const succeeded = (r: CommandResult): r is Extract<CommandResult, { code: number }> => 'code' in r && r.code === 0 && !r.truncated
const failure = (): Error => new Error("The VPN couldn't be changed. Restart the TV box and try again.")

export class NmWireGuard implements VpnBackend {
  private readonly io: FileSystem
  constructor(private opts: NmWireGuardOptions) { this.io = opts.fs ?? fs }
  private run(args: string[], file = 'nmcli'): Promise<CommandResult> {
    return this.opts.runner.run(file, args, { timeoutMs: 15000 })
  }
  private async write(args: string[], allowedCode?: number): Promise<void> {
    const result = await this.run(args)
    if ('fail' in result || result.truncated || (result.code !== 0 && result.code !== allowedCode)) throw failure()
  }
  importProfile(config: WgConfig, label: string): Promise<string> {
    return this.opts.queue.run(async () => {
      if (!this.opts.runtimeDir) throw failure()
      const folder = join(this.opts.runtimeDir, 'mediaos', 'vpn-import'), file = join(folder, 'mosvpn0.conf')
      let uuid: string | null = null
      try {
        await this.io.mkdir(folder, { recursive: true, mode: 0o700 }); await this.io.chmod(folder, 0o700)
        await this.io.unlink(file).catch((error: unknown) => {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
        })
        await this.io.writeFile(file, buildImportFile(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        const result = await this.run(['-t', 'connection', 'import', 'type', 'wireguard', 'file', file])
        uuid = 'stdout' in result ? importedUuid(result.stdout) : null
        if (!succeeded(result) || !uuid) throw failure()
        // An import normally starts at once, but not while another location holds mosvpn0; nmcli then exits 10 (not active).
        await this.write(['connection', 'down', 'uuid', uuid], 10)
        const ip = config.address
        await this.write(['connection', 'modify', uuid, 'connection.id', `MediaOS VPN - ${label}`, 'connection.autoconnect', 'no',
          'ipv4.route-table', '51820', 'ipv4.never-default', 'yes', 'ipv4.routes', '0.0.0.0/0 table=51820',
          'ipv4.ignore-auto-dns', 'yes', 'ipv4.dns', '', 'ipv4.dns-priority', '0', 'ipv6.method', 'disabled',
          'wireguard.ip4-auto-default-route', '0', 'wireguard.ip6-auto-default-route', '0', 'wireguard.peer-routes', 'no',
          'wireguard.private-key-flags', '0', 'ipv4.routing-rules',
          `priority 5200 from ${ip}/32 table 51820, priority 5201 from ${ip}/32 type unreachable`])
        return uuid
      } catch {
        const leftovers = uuid ? [uuid] : (await this.listProfiles() ?? [])
          .filter((p) => p.type === 'wireguard' && p.name === 'mosvpn0').map((p) => p.uuid)
        for (const id of leftovers) {
          const remove = () => this.write(['connection', 'delete', 'uuid', id], 10)
          await remove().catch(() => remove().catch(() => undefined))
        }
        throw failure()
      } finally { await this.io.unlink(file).catch(() => undefined) }
    })
  }
  async listProfiles() {
    try {
      const result = await this.run(['-t', '-f', 'UUID,NAME,TYPE', 'connection', 'show'])
      return succeeded(result) ? profiles(result.stdout) : null
    } catch { return null }
  }
  async address(uuid: string): Promise<string | null> {
    const result = await this.run(['-t', '-g', 'ipv4.addresses', 'connection', 'show', 'uuid', uuid])
    return succeeded(result) ? tunnelAddress(result.stdout) : null
  }
  setAutoconnect(uuid: string, on: boolean): Promise<void> {
    return this.opts.queue.run(() => this.write(['connection', 'modify', uuid, 'connection.autoconnect', on ? 'yes' : 'no',
      ...(on ? ['connection.autoconnect-retries', '0'] : [])]))
  }
  up(uuid: string, tunIp: string): Promise<void> {
    return this.opts.queue.run(async () => {
      try {
        await this.write(['connection', 'up', 'uuid', uuid])
        if (await this.routingOk(tunIp)) return
      } catch { /* Activation may still be running in NetworkManager; compensate below. */ }
      await this.write(['connection', 'down', 'uuid', uuid], 10).catch(() => undefined)
      throw failure()
    })
  }
  down(uuid: string): Promise<void> {
    return this.opts.queue.run(() => this.write(['connection', 'down', 'uuid', uuid], 10))
  }
  remove(uuid: string): Promise<void> {
    return this.opts.queue.run(() => this.write(['connection', 'delete', 'uuid', uuid], 10))
  }
  async status(): Promise<VpnDeviceStatus> {
    try {
      const result = await this.run(['-t', '-g', 'GENERAL.STATE,IP4.ADDRESS', 'device', 'show', 'mosvpn0'])
      if ('code' in result && result.code === 10 && !result.truncated) return { state: 'absent', tunIp: null }
      if (succeeded(result)) return deviceStatus(result.stdout)
    } catch { /* A failed read says nothing about the current tunnel. */ }
    return { state: 'unknown', tunIp: null }
  }
  async routingOk(tunIp: string): Promise<boolean> {
    try {
      const [rules, routes] = await Promise.all([this.run(['-j', 'rule', 'show'], 'ip'),
        this.run(['-j', 'route', 'show', 'table', '51820'], 'ip')])
      return succeeded(rules) && succeeded(routes) && routingPresent(rules.stdout, routes.stdout, tunIp)
    } catch { return false }
  }
  probe(tunIp: string, dns: string | null, timeoutMs: number): Promise<boolean> { return probe(tunIp, dns, timeoutMs) }
}
