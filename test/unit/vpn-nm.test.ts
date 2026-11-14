import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NmWireGuard } from '../../src/main/vpn/linux/NmWireGuard'
import { deviceStatus, importedUuid, profiles, routingPresent } from '../../src/main/vpn/linux/nm-vpn-parse'
import type { FileSystem } from '../../src/main/settings/atomic'
import { NetQueue } from '../../src/main/system/net/NetQueue'
import type { CommandRunner, CommandResult } from '../../src/main/system/linux/CommandRunner'
import { buildImportFile, parseWireGuard } from '../../src/main/vpn/wg-config'
import { deferred, fixture, temporary } from './helpers'

const uuid = 'bb83ad2c-12dc-49dd-95b1-ded361199a06'
const success = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const failed: CommandResult = { code: 1, stdout: '', stderr: 'failed' }
const config = () => {
  const key = randomBytes(32).toString('base64')
  const parsed = parseWireGuard(Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\nDNS = 10.64.0.1\n` +
    `[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`))
  if (!parsed.ok) throw new Error('Invalid test config')
  return parsed.config
}
function runner() {
  const run = vi.fn<CommandRunner['run']>(async (file, args) => {
    if (file === 'ip') return success(fixture(args.includes('rule') ? 'ip-vpn-rules.json' : 'ip-vpn-routes.json'))
    if (args.includes('import')) return success(fixture('nmcli-vpn-import.txt'))
    if (args.includes('UUID,NAME,TYPE')) return success(fixture('nmcli-vpn-profiles.txt'))
    if (args.includes('GENERAL.STATE,IP4.ADDRESS')) return success(fixture('nmcli-vpn-up.txt'))
    if (args.includes('ipv4.addresses')) return success('10.64.0.2/32\n')
    return success()
  })
  return { run, spawnLines: () => ({ kill() {} }) } satisfies CommandRunner
}
describe('VPN nmcli and ip parsers', () => {
  it('parses import UUID, escaped connection names, status and route fixtures', () => {
    expect(importedUuid(fixture('nmcli-vpn-import.txt'))).toBe(uuid)
    expect(importedUuid('no uuid')).toBeNull()
    expect(profiles('malformed output')).toBeNull()
    expect(profiles(fixture('nmcli-vpn-profiles.txt'))).toEqual([
      { uuid, name: 'MediaOS VPN - UK', type: 'wireguard' },
      { uuid: '315016c3-14f1-4ccd-9ebd-257ce92fcbae', name: 'MediaOS VPN - France: Paris', type: 'wireguard' },
      { uuid: '142be7a3-d9fb-485d-bf09-8f7742f9f08e', name: 'Wired connection 1', type: '802-3-ethernet' },
    ])
    expect(deviceStatus(fixture('nmcli-vpn-up.txt'))).toEqual({ state: 'up', tunIp: '10.64.0.2' })
    expect(deviceStatus(fixture('nmcli-vpn-connecting.txt'))).toEqual({ state: 'connecting', tunIp: null })
    expect(routingPresent(fixture('ip-vpn-rules.json'), fixture('ip-vpn-routes.json'), '10.64.0.2')).toBe(true)
  })
  it.each([40, 50, 60, 70, 80, 90])('maps device state %i to connecting', (n) => {
    expect(deviceStatus(`${n} (connecting)\n`)).toEqual({ state: 'connecting', tunIp: null })
  })
  it.each(['', '20 (unavailable)', '30 (disconnected)', '120 (failed)', 'garbage'])('maps %s to absent', (text) => {
    expect(deviceStatus(text)).toEqual({ state: 'absent', tunIp: null })
  })
  it.each(['127.0.0.1/32', '0.0.0.0/32', 'not an address', '::1'])('rejects tunnel address %s', (ip) => {
    expect(deviceStatus(`100 (connected)\n${ip}`)).toEqual({ state: 'up', tunIp: null })
  })
  it('requires the exact source, table, unreachable rule and tunnel default route', () => {
    const rules = fixture('ip-vpn-rules.json'), routes = fixture('ip-vpn-routes.json')
    for (const bad of ['garbage', '{}', rules.replace('5200', '5300'), rules.replace('5201', '5301'),
      rules.replace('unreachable', 'blackhole'), rules.replace('51820', 'main')]) {
      expect(routingPresent(bad, routes, '10.64.0.2')).toBe(false)
    }
    expect(routingPresent(rules, routes, '10.64.0.3')).toBe(false)
    for (const bad of ['garbage', '{}', '[]', routes.replace('mosvpn0', 'eth0'), routes.replace('default', '10.0.0.0/8')]) {
      expect(routingPresent(rules, bad, '10.64.0.2')).toBe(false)
    }
    expect(routingPresent(rules.replaceAll('10.64.0.2', '10.64.0.2/32'), routes, '10.64.0.2')).toBe(true)
  })
})

describe('NetworkManager WireGuard backend', () => {
  it('removes a stale import file before the exclusive write', async () => {
    const r = runner(), temp = await temporary(), folder = join(temp.dir, 'mediaos', 'vpn-import')
    const backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: temp.dir })
    try {
      await fs.mkdir(folder, { recursive: true }); await fs.writeFile(join(folder, 'mosvpn0.conf'), 'stale', 'utf8')
      expect(await backend.importProfile(config(), 'UK')).toBe(uuid)
    } finally { await temp.dispose() }
  })
  it('cleans up a UUID returned by a failed import and retries deletion once', async () => {
    const r = runner(), normal = r.run.getMockImplementation()!, temp = await temporary()
    let deletions = 0
    r.run.mockImplementation(async (file, args, opts) => {
      if (args.includes('import')) return { ...failed, stdout: fixture('nmcli-vpn-import.txt') }
      if (args.includes('delete') && ++deletions === 1) return failed
      return normal(file, args, opts)
    })
    const backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: temp.dir })
    try {
      await expect(backend.importProfile(config(), 'UK')).rejects.toThrow()
      expect(r.run.mock.calls.filter(([, args]) => args.includes('delete')).map(([, args]) => args))
        .toEqual([['connection', 'delete', 'uuid', uuid], ['connection', 'delete', 'uuid', uuid]])
    } finally { await temp.dispose() }
  })
  it('finds only owned mosvpn0 WireGuard profiles after an import with no UUID', async () => {
    const r = runner(), normal = r.run.getMockImplementation()!, temp = await temporary()
    r.run.mockImplementation(async (file, args, opts) => {
      if (args.includes('import')) return { fail: 'timeout' }
      if (args.includes('UUID,NAME,TYPE')) return success(`${uuid}:mosvpn0:wireguard\n` +
        '315016c3-14f1-4ccd-9ebd-257ce92fcbae:mosvpn0:802-3-ethernet\n' +
        '142be7a3-d9fb-485d-bf09-8f7742f9f08e:Personal VPN:wireguard\n')
      return normal(file, args, opts)
    })
    const backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: temp.dir })
    try {
      await expect(backend.importProfile(config(), 'UK')).rejects.toThrow()
      expect(r.run.mock.calls.filter(([, args]) => args.includes('delete')).map(([, args]) => args))
        .toEqual([['connection', 'delete', 'uuid', uuid]])
    } finally { await temp.dispose() }
  })
  it.each(['failure', 'timeout', 'throw'] as const)('compensates a failed up with down: %s', async (mode) => {
    const r = runner(), normal = r.run.getMockImplementation()!
    r.run.mockImplementation(async (file, args, opts) => {
      if (args.includes('up')) {
        if (mode === 'throw') throw new Error('spawn failed')
        return mode === 'timeout' ? { fail: 'timeout' } : failed
      }
      if (args.includes('down')) return { code: 10, stdout: '', stderr: '' }
      return normal(file, args, opts)
    })
    const backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    await expect(backend.up(uuid, '10.64.0.2')).rejects.toThrow()
    expect(r.run.mock.calls.map(([, args]) => args)).toEqual([
      ['connection', 'up', 'uuid', uuid], ['connection', 'down', 'uuid', uuid],
    ])
  })
  it('imports a defanged 0600 file in a 0700 folder, configures exact properties and removes the file', async () => {
    const r = runner(), queue = new NetQueue(), temp = await temporary(), cfg = config()
    const mkdir = vi.fn(fs.mkdir), chmod = vi.fn(fs.chmod), writeFile = vi.fn(fs.writeFile), unlink = vi.fn(fs.unlink)
    const backend = new NmWireGuard({ runner: r, queue, runtimeDir: temp.dir,
      fs: { ...fs, mkdir, chmod, writeFile, unlink } as FileSystem })
    const file = join(temp.dir, 'mediaos', 'vpn-import', 'mosvpn0.conf')
    try {
      expect(await backend.importProfile(cfg, 'UK')).toBe(uuid)
      expect(mkdir).toHaveBeenCalledWith(join(temp.dir, 'mediaos', 'vpn-import'), { recursive: true, mode: 0o700 })
      expect(chmod).toHaveBeenCalledWith(join(temp.dir, 'mediaos', 'vpn-import'), 0o700)
      expect(writeFile).toHaveBeenCalledWith(file, buildImportFile(cfg), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      expect(unlink).toHaveBeenCalledWith(file); await expect(fs.stat(file)).rejects.toThrow()
      expect(r.run.mock.calls).toEqual([
        ['nmcli', ['-t', 'connection', 'import', 'type', 'wireguard', 'file', file], { timeoutMs: 15000 }],
        ['nmcli', ['connection', 'down', 'uuid', uuid], { timeoutMs: 15000 }],
        ['nmcli', ['connection', 'modify', uuid, 'connection.id', 'MediaOS VPN - UK', 'connection.autoconnect', 'no',
          'ipv4.route-table', '51820', 'ipv4.never-default', 'yes', 'ipv4.routes', '0.0.0.0/0 table=51820',
          'ipv4.ignore-auto-dns', 'yes', 'ipv4.dns', '', 'ipv4.dns-priority', '0', 'ipv6.method', 'disabled',
          'wireguard.ip4-auto-default-route', '0', 'wireguard.ip6-auto-default-route', '0', 'wireguard.peer-routes', 'no',
          'wireguard.private-key-flags', '0', 'ipv4.routing-rules',
          'priority 5200 from 10.64.0.2/32 table 51820, priority 5201 from 10.64.0.2/32 type unreachable'], { timeoutMs: 15000 }],
      ])
      expect(JSON.stringify(r.run.mock.calls)).not.toContain(cfg.privateKey.reveal())
    } finally { await temp.dispose() }
  })
  it.each(['import', 'down', 'modify'] as const)('always unlinks the import file and cleans up on %s failure', async (step) => {
    const r = runner(), normal = r.run.getMockImplementation()!, temp = await temporary()
    r.run.mockImplementation(async (file, args, opts) => args.includes(step) ? failed : normal(file, args, opts))
    const backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: temp.dir })
    try {
      await expect(backend.importProfile(config(), 'UK')).rejects.toThrow("The VPN couldn't be changed.")
      await expect(fs.stat(join(temp.dir, 'mediaos', 'vpn-import', 'mosvpn0.conf'))).rejects.toThrow()
      expect(r.run.mock.calls.some(([, args]) => args.includes('delete'))).toBe(step !== 'import')
    } finally { await temp.dispose() }
  })
  it('cannot import without a runtime directory', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    await expect(backend.importProfile(config(), 'UK')).rejects.toThrow(); expect(r.run).not.toHaveBeenCalled()
  })
  it('uses exact up, down, delete and autoconnect argv and checks routing after up', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    await backend.setAutoconnect(uuid, true); await backend.setAutoconnect(uuid, false)
    await backend.up(uuid, '10.64.0.2'); await backend.down(uuid); await backend.remove(uuid)
    expect(r.run.mock.calls).toEqual([
      ['nmcli', ['connection', 'modify', uuid, 'connection.autoconnect', 'yes', 'connection.autoconnect-retries', '0'],
        { timeoutMs: 15000 }],
      ['nmcli', ['connection', 'modify', uuid, 'connection.autoconnect', 'no'], { timeoutMs: 15000 }],
      ['nmcli', ['connection', 'up', 'uuid', uuid], { timeoutMs: 15000 }],
      ['ip', ['-j', 'rule', 'show'], { timeoutMs: 15000 }],
      ['ip', ['-j', 'route', 'show', 'table', '51820'], { timeoutMs: 15000 }],
      ['nmcli', ['connection', 'down', 'uuid', uuid], { timeoutMs: 15000 }],
      ['nmcli', ['connection', 'delete', 'uuid', uuid], { timeoutMs: 15000 }],
    ])
  })
  it('takes a tunnel with missing routing down again and throws', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    vi.spyOn(backend, 'routingOk').mockResolvedValue(false)
    await expect(backend.up(uuid, '10.64.0.2')).rejects.toThrow()
    expect(r.run.mock.calls.map(([, args]) => args)).toEqual([
      ['connection', 'up', 'uuid', uuid], ['connection', 'down', 'uuid', uuid],
    ])
  })
  it('treats inactive/missing profiles as idempotent down/delete but propagates other failures', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    r.run.mockResolvedValue({ code: 10, stdout: '', stderr: '' })
    await backend.down(uuid); await backend.remove(uuid)
    r.run.mockResolvedValue(failed); await expect(backend.down(uuid)).rejects.toThrow()
  })
  it('parses reads and contains failed status, list and routing commands', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    expect(await backend.listProfiles()).toHaveLength(3); expect(await backend.address(uuid)).toBe('10.64.0.2')
    expect(await backend.status()).toEqual({ state: 'up', tunIp: '10.64.0.2' })
    r.run.mockResolvedValue({ fail: 'timeout' })
    expect(await backend.status()).toEqual({ state: 'unknown', tunIp: null }); expect(await backend.listProfiles()).toBeNull()
    expect(await backend.routingOk('10.64.0.2')).toBe(false)
    r.run.mockRejectedValue(new Error('spawn failed'))
    expect(await backend.status()).toEqual({ state: 'unknown', tunIp: null }); expect(await backend.listProfiles()).toBeNull()
    expect(await backend.routingOk('10.64.0.2')).toBe(false)
  })
  it('reports a confirmed missing device as absent', async () => {
    const r = runner(), backend = new NmWireGuard({ runner: r, queue: new NetQueue(), runtimeDir: null })
    r.run.mockResolvedValue({ code: 10, stdout: '', stderr: '' })
    expect(await backend.status()).toEqual({ state: 'absent', tunIp: null })
  })
  it('queues all writes behind the shared network queue, while reads proceed', async () => {
    const r = runner(), queue = new NetQueue(), pending = deferred<void>()
    const trial = queue.run(() => pending.promise), backend = new NmWireGuard({ runner: r, queue, runtimeDir: null })
    const write = backend.setAutoconnect(uuid, true)
    await backend.status(); expect(r.run).toHaveBeenCalledTimes(1)
    pending.resolve(); await trial; await write; expect(r.run).toHaveBeenCalledTimes(2)
  })
})
