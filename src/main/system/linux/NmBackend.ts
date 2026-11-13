import type { IpConfig, NetProfile, Result } from '@shared/system-types'
import { dnsPreset } from '@shared/dns-presets'
import { sameSubnet } from '@shared/ipv4'
import { delay, runtime, type Runtime } from '../../core/runtime'
import type { TrialBackend } from '../net/IpTrial'
import { addressInUse, APPLY_FAILED, NOT_ALLOWED, RESET_FAILED, UserFacingError } from '../net/texts'
import type { CommandRunner } from './CommandRunner'
import * as parse from './nmcli-parse'
import { networkChecks, NEIGHBOUR_STATES, type CheckOptions } from './net-checks'
import { NM, ROOT, SETTINGS, CONNECTION, SNAPSHOT_KEYS, SETTINGS_FIELDS, LIVE_FIELDS, CommandFailed,
  configArgs, snapshotValue, uuid, device, objectPath, ok, fail, type NmSnapshot } from './nm-properties'

export interface NmOptions extends CheckOptions { runner: CommandRunner; monotonic?: () => number }
export class NmBackend implements TrialBackend {
  readonly clock: Runtime
  private checkDevice?: string
  constructor(private opts: NmOptions) { this.clock = opts.clock ?? runtime }
  private now(): number { return this.opts.monotonic?.() ?? performance.now() }
  async read(file: string, args: string[], timeoutMs = 5000): Promise<string> {
    if (timeoutMs <= 0) throw new CommandFailed({ fail: 'timeout' })
    const result = await this.opts.runner.run(file, args, { timeoutMs })
    if ('fail' in result || result.code !== 0) throw new CommandFailed(result)
    return result.stdout
  }
  nmRead(fields: string, args: string[], timeoutMs = 5000): Promise<string> {
    return this.read('nmcli', ['-t', '--escape', 'yes', '-f', fields, ...args], timeoutMs)
  }
  async connections() {
    return parse.connectionList(await this.nmRead('NAME,UUID,TYPE,DEVICE,ACTIVE', ['connection', 'show']))
      .filter((p) => parse.profileKind(p.type))
  }
  async devices() {
    return parse.deviceStatus(await this.nmRead('DEVICE,TYPE,STATE,CON-UUID', ['device', 'status']))
      .filter((d) => d.type === 'ethernet' || d.type === 'wifi')
  }
  async live(dev: string, timeoutMs = 5000) {
    return parse.deviceShow(await this.nmRead(LIVE_FIELDS, ['device', 'show', device(dev)], timeoutMs))
  }
  async settings(id: string, timeoutMs = 5000) {
    return parse.connectionSettings(await this.nmRead(SETTINGS_FIELDS, ['connection', 'show', 'uuid', uuid(id)], timeoutMs))
  }
  async uplink() {
    return parse.routes(await this.read('ip', ['-j', 'route', 'show', 'default']))
      .filter((r) => !r.device.startsWith('mosvpn')).sort((a, b) => a.metric - b.metric)[0]
  }
  async profiles(): Promise<NetProfile[]> {
    const connections = await this.connections(), devices = await this.devices()
    const profiles: NetProfile[] = []
    for (const p of connections) {
      const kind = parse.profileKind(p.type)!
      const props = await this.settings(p.uuid)
      const dev = devices.find((d) => d.device === p.device || d.uuid === p.uuid)
      const editable = dev?.state !== 'unmanaged'
      const live = p.active && p.device ? (await this.live(p.device)).live : undefined
      profiles.push({ id: p.uuid, kind, name: kind === 'ethernet' ? 'Cable' : props['802-11-wireless.ssid'] || p.name,
        active: p.active, editable, config: parse.configFrom(props), live,
        ...(!editable ? { why: "This connection is set up outside MediaOS, so its settings can't be changed here." } : {}) })
    }
    return profiles
  }
  private async profileDevice(id: string): Promise<string> {
    const p = (await this.connections()).find((p) => p.uuid === uuid(id))
    if (!p?.device) throw new Error(APPLY_FAILED)
    return device(p.device)
  }
  async snapshot(id: string): Promise<NmSnapshot> {
    const dev = await this.profileDevice(id), props = await this.settings(id)
    return { uuid: id, device: dev, properties: Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, props[k] ?? ''])) }
  }
  private bus(path: string, iface: string, method: string, args: string[] = []): Promise<string> {
    return this.read('busctl', ['--system', '--json=short', '--timeout=10', 'call', NM, objectPath(path), iface, method, ...args], 12000)
  }
  private property(path: string, iface: string, name: string): Promise<string> {
    return this.read('busctl', ['--system', '--json=short', '--timeout=10', 'get-property', NM, objectPath(path), iface, name], 12000)
  }
  async begin(id: string, timeoutSec: number): Promise<string> {
    if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) throw new Error(APPLY_FAILED)
    try {
      const dev = await this.profileDevice(id)
      const path = parse.busPath(await this.bus(ROOT, NM, 'GetDeviceByIpIface', ['s', dev]))
      return parse.busPath(await this.bus(ROOT, NM, 'CheckpointCreate', ['aouu', '1', objectPath(path), String(timeoutSec), '1']))
    } catch (error) {
      if (error instanceof CommandFailed && error.message === NOT_ALLOWED) throw new UserFacingError(NOT_ALLOWED)
      throw error
    }
  }
  async applyTemporary(id: string, cfg: IpConfig, deadlineMs: number): Promise<Result> {
    const end = this.now() + deadlineMs
    const left = (limit: number) => Math.max(0, Math.floor(Math.min(limit, end - this.now())))
    const guard = () => { if (this.now() >= end) throw new CommandFailed({ fail: 'timeout' }) }
    const read = async (file: string, args: string[], limit: number) => {
      const output = await this.read(file, args, left(limit))
      guard(); return output
    }
    try {
      configArgs(cfg)
      uuid(id)
      const list = parse.connectionList(await read('nmcli', ['-t', '--escape', 'yes', '-f',
        'NAME,UUID,TYPE,DEVICE,ACTIVE', 'connection', 'show'], 5000))
      const dev = device(list.find((p) => p.uuid === id)?.device ?? '')
      this.checkDevice = dev
      const old = await this.settings(id, left(5000))
      const args = configArgs(cfg, old['ipv6.method'])
      const current = await this.live(dev, left(5000))
      if (cfg.method === 'manual' && current.live && cfg.address !== current.live.address &&
        sameSubnet(cfg.address, current.live.address, current.live.prefix)) {
        if (!left(2000)) throw new CommandFailed({ fail: 'timeout' })
        await this.opts.runner.run('ping', ['-n', '-c', '1', '-W', '1', cfg.address], { timeoutMs: left(2000) })
        const table = parse.neighbours(await read('ip', ['-j', 'neigh', 'show', cfg.address, 'dev', dev], 5000))
        if (table.some((n) => !!n.lladdr && n.states.some((s) => NEIGHBOUR_STATES.includes(s)))) return fail(addressInUse(cfg.address))
      }
      await read('nmcli', ['connection', 'modify', '--temporary', 'uuid', id, ...args], 10000)
      const dnsOnly = old['ipv4.method'] === cfg.method &&
        (old['ipv4.addresses'] ?? '') === (cfg.method === 'manual' ? `${cfg.address}/${cfg.prefix}` : '') &&
        (old['ipv4.gateway'] ?? '') === (cfg.method === 'manual' ? cfg.gateway : '')
      try {
        await read('nmcli', dnsOnly ? ['device', 'reapply', dev] : ['--wait', '20', 'connection', 'up', 'uuid', id],
          dnsOnly ? 15000 : 25000)
      } catch (error) {
        if (cfg.method === 'manual' && !dnsOnly && error instanceof CommandFailed && !('fail' in error.result) &&
          [3, 4].includes(error.result.code) && error.message === APPLY_FAILED) {
          const current = await this.live(dev, left(5000))
          guard()
          return fail(current.live ? APPLY_FAILED : addressInUse(cfg.address))
        }
        throw error
      }
      let hasAddress = false
      while (left(5000) > 0) {
        const live = (await this.live(dev, left(5000))).live
        guard(); hasAddress = !!live
        if (live && (cfg.method === 'auto' || live.address === cfg.address)) return ok
        await delay(left(500), this.clock)
      }
      return fail(cfg.method === 'manual' && !hasAddress ? addressInUse(cfg.address) : APPLY_FAILED)
    } catch (error) { return fail(error instanceof CommandFailed ? error.message : APPLY_FAILED) }
  }
  checks(cfg: IpConfig): ReturnType<TrialBackend['checks']> {
    return networkChecks(async () => {
      const dev = this.checkDevice ?? (await this.uplink())?.device
      if (!dev) throw new Error(APPLY_FAILED)
      const live = (await this.live(dev)).live
      const gateway = cfg.method === 'manual' ? cfg.gateway : live?.gateway
      const dns = cfg.dns.mode === 'auto' ? live?.dns ?? [] : cfg.dns.mode === 'router' ? gateway ? [gateway] : []
        : cfg.dns.mode === 'preset' ? [...dnsPreset(cfg.dns.preset).ipv4] : cfg.dns.servers
      return { device: dev, gateway, dns }
    }, this.opts.runner, this.opts)
  }
  internet(): Promise<boolean> {
    return networkChecks(async () => {
      const uplink = await this.uplink()
      if (!uplink) throw new Error(APPLY_FAILED)
      const live = (await this.live(uplink.device)).live
      return { device: uplink.device, gateway: live?.gateway, dns: live?.dns ?? [] }
    }, this.opts.runner, this.opts).internet()
  }
  async commit(handle: string): Promise<'ok' | 'gone'> { return this.checkpoint('CheckpointDestroy', handle) }
  async clearCheckpoints(): Promise<void> {
    for (const handle of parse.busPaths(await this.property(ROOT, NM, 'Checkpoints'))) await this.commit(handle)
  }
  async rollback(handle: string): Promise<'ok' | 'gone'> { return this.checkpoint('CheckpointRollback', handle) }
  private async checkpoint(method: string, handle: string): Promise<'ok' | 'gone'> {
    try {
      const result = await this.bus(ROOT, NM, method, ['o', objectPath(handle)])
      if (method === 'CheckpointRollback' && Object.values(parse.busRollback(result)).some((v) => v !== 0)) {
        throw new Error(APPLY_FAILED)
      }
      return 'ok'
    } catch (error) {
      if (error instanceof CommandFailed && !('fail' in error.result) && error.result.stderr.includes('does not exist')) return 'gone'
      throw error
    }
  }
  async alive(handle: string): Promise<boolean> { return parse.busPaths(await this.property(ROOT, NM, 'Checkpoints')).includes(handle) }
  private async settingsPath(id: string): Promise<string> {
    return parse.busPath(await this.bus(SETTINGS, `${NM}.Settings`, 'GetConnectionByUuid', ['s', uuid(id)]))
  }
  async save(id: string): Promise<Result> {
    try { await this.bus(await this.settingsPath(id), CONNECTION, 'Save'); return ok }
    catch (error) { return fail(error instanceof CommandFailed ? error.message : APPLY_FAILED) }
  }
  async unsaved(id: string): Promise<boolean> {
    return parse.busBool(await this.property(await this.settingsPath(id), CONNECTION, 'Unsaved'))
  }
  async restore(value: unknown): Promise<Result> {
    try {
      const before = snapshotValue(value)
      await this.read('nmcli', ['connection', 'modify', 'uuid', before.uuid,
        ...SNAPSHOT_KEYS.flatMap((k) => [k, before.properties[k] ?? ''])], 10000)
      await this.read('nmcli', ['--wait', '20', 'connection', 'up', 'uuid', before.uuid], 25000)
      return ok
    } catch (error) { return fail(error instanceof CommandFailed ? error.message : APPLY_FAILED) }
  }
  async matches(value: unknown): Promise<boolean> {
    const before = snapshotValue(value)
    if (await this.unsaved(before.uuid)) return false
    const current = await this.settings(before.uuid)
    return SNAPSHOT_KEYS.every((k) => (current[k] ?? '') === before.properties[k])
  }
  async resetAll(): Promise<Result> {
    let failure: string | undefined
    const failed = (error: unknown) => {
      if (failure !== NOT_ALLOWED) failure = error instanceof CommandFailed && error.message === NOT_ALLOWED ? NOT_ALLOWED : RESET_FAILED
    }
    try {
      let list = await this.connections()
      const reset: typeof list = []
      for (const p of list) {
        try {
          await this.read('nmcli', ['connection', 'modify', 'uuid', uuid(p.uuid),
            ...configArgs({ method: 'auto', dns: { mode: 'auto' } })], 10000)
          reset.push(p)
        } catch (error) { failed(error) }
      }
      if (!list.some((p) => p.type === '802-3-ethernet')) {
        try {
          await this.read('nmcli', ['connection', 'add', 'type', 'ethernet', 'ifname', '*', 'con-name', 'MediaOS wired',
            'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '10', 'ipv4.method', 'auto',
            'ipv4.dhcp-client-id', 'mac', 'ipv6.method', 'auto'], 10000)
          list = await this.connections()
          const wired = list.find((p) => p.type === '802-3-ethernet')
          if (wired) reset.push(wired)
          else failed(new Error(RESET_FAILED))
        } catch (error) { failed(error) }
      }
      const active = reset.filter((p) => p.active && p.device)
      const targets = active.length ? active : reset.filter((p) => p.type === '802-3-ethernet').slice(0, 1)
      for (const p of targets) {
        try { await this.read('nmcli', ['--wait', '20', 'connection', 'up', 'uuid', uuid(p.uuid)], 25000) }
        catch (error) { failed(error) }
      }
    } catch (error) { failed(error) }
    return failure ? fail(failure) : ok
  }
}
