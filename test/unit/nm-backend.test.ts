import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { IpConfig } from '@shared/system-types'
import { NmBackend } from '../../src/main/system/linux/NmBackend'
import { NodeCommandRunner, type CommandResult } from '../../src/main/system/linux/CommandRunner'
import { networkChecks, resolveCheck, tcpCheck } from '../../src/main/system/linux/net-checks'
import { runtime } from '../../src/main/core/runtime'
import { APPLY_FAILED, NOT_ALLOWED, RESET_FAILED, UserFacingError, addressInUse } from '../../src/main/system/net/texts'
import { properties } from '../../src/main/system/linux/nmcli-parse'
import { SNAPSHOT_KEYS } from '../../src/main/system/linux/nm-properties'
import { FakeNmRunner, fixture, NM_UUID, NM_CHECKPOINT, fakeNetworkChecks } from './helpers'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
const manual: IpConfig = { method: 'manual', address: '192.168.80.150', prefix: 24, gateway: '192.168.80.2', dns: { mode: 'router' } }
const automatic: IpConfig = { method: 'auto', dns: { mode: 'auto' } }
const make = () => {
  const runner = new FakeNmRunner(), network = fakeNetworkChecks()
  const backend = new NmBackend({ runner, ...network.opts, clock: runtime, monotonic: () => Date.now() })
  return { runner, backend, network }
}
const writes = (runner: FakeNmRunner) => runner.calls.filter((c) => c.args.includes('modify') || c.args.includes('up') ||
  c.args.includes('reapply') || c.args.includes('add'))
const errorReply = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr })

// The required -1 DAD sentinel is a numeric property value, never an option. All other values reject leading '-'.
function safeValues(runner: FakeNmRunner) {
  for (const { args } of writes(runner).filter((c) => c.args.includes('modify'))) {
    for (let i = args.indexOf('uuid') + 1; i < args.length; i += 2) {
      const value = args[i]!
      expect(value.startsWith('-') && !(args[i - 1] === 'ipv4.dad-timeout' && value === '-1')).toBe(false)
    }
  }
}
describe('NmBackend writes and activation', () => {
  it.each([
    { cfg: automatic, v4: '', v6: '', ignore: 'no', dad: '-1' },
    { cfg: { method: 'auto', dns: { mode: 'preset', preset: 'cloudflare' } } as IpConfig,
      v4: '1.1.1.1,1.0.0.1', v6: '2606:4700:4700::1111,2606:4700:4700::1001', ignore: 'yes', dad: '-1' },
    { cfg: { method: 'auto', dns: { mode: 'custom', servers: ['10.0.0.53', '10.0.0.54'] } } as IpConfig,
      v4: '10.0.0.53,10.0.0.54', v6: '', ignore: 'yes', dad: '-1' },
    { cfg: manual, v4: '192.168.80.2', v6: '', ignore: 'yes', dad: '3000' },
  ])('applies $cfg with exact temporary argv', async ({ cfg, v4, v6, ignore, dad }) => {
    const { runner, backend } = make()
    expect(await backend.applyTemporary(NM_UUID, cfg, 30000)).toEqual({ ok: true })
    expect(writes(runner)[0]?.args).toEqual(['connection', 'modify', '--temporary', 'uuid', NM_UUID,
      'ipv4.method', cfg.method, 'ipv4.addresses', cfg.method === 'manual' ? '192.168.80.150/24' : '',
      'ipv4.gateway', cfg.method === 'manual' ? '192.168.80.2' : '', 'ipv4.ignore-auto-dns', ignore,
      'ipv4.dns', v4, 'ipv4.dad-timeout', dad, 'ipv6.ignore-auto-dns', ignore, 'ipv6.dns', v6])
    expect(writes(runner)[1]?.args).toEqual(cfg.method === 'auto' ? ['device', 'reapply', 'ens160']
      : ['--wait', '20', 'connection', 'up', 'uuid', NM_UUID])
    safeValues(runner)
  })
  it.each(['disabled', 'ignore'])('clears IPv6 DNS for a preset when ipv6.method is %s', async (method) => {
    const { runner, backend } = make()
    runner.settings['ipv6.method'] = method
    expect(await backend.applyTemporary(NM_UUID, { method: 'auto', dns: { mode: 'preset', preset: 'cloudflare' } }, 30000))
      .toEqual({ ok: true })
    const args = writes(runner)[0]!.args
    expect(args.slice(args.indexOf('ipv4.dns'), args.indexOf('ipv4.dns') + 2)).toEqual(['ipv4.dns', '1.1.1.1,1.0.0.1'])
    expect(args.slice(-4)).toEqual(['ipv6.ignore-auto-dns', 'yes', 'ipv6.dns', ''])
    expect(args).not.toContain('ipv6.method')
  })
  it('pre-check refuses a neighbour with an address before modifying anything', async () => {
    const { runner, backend } = make()
    runner.neighbour = fixture('neigh-192.168.80.1.json')
    const cfg = { ...manual, address: '192.168.80.1' }
    expect(await backend.applyTemporary(NM_UUID, cfg, 30000)).toEqual({ ok: false, error: addressInUse(cfg.address) })
    expect(writes(runner)).toEqual([])
    expect(runner.calls.find((c) => c.file === 'ping')?.args).toEqual(['-n', '-c', '1', '-W', '1', cfg.address])
  })
  it('does not probe an unchanged address or an address outside the current subnet', async () => {
    for (const cfg of [{ ...manual, address: '192.168.80.137' },
      { ...manual, address: '10.0.0.60', gateway: '10.0.0.1' }]) {
      const { runner, backend } = make()
      expect(await backend.applyTemporary(NM_UUID, cfg, 30000)).toEqual({ ok: true })
      expect(runner.calls.some((c) => c.file === 'ping')).toBe(false)
    }
  })
  it.each([3, 4])('checks live IPv4 before classifying manual activation exit %s', async (code) => {
    for (const hasAddress of [false, true]) {
      const { runner, backend } = make()
      let failedUp = false
      runner.override = (c) => {
        if (c.args.includes('up')) { failedUp = true; return errorReply(fixture('up-clash-host.err'), code) }
        if (failedUp && c.args.includes('device') && c.args.includes('show')) {
          return { code: 0, stdout: hasAddress ? fixture('device-show-dhcp.txt') : 'GENERAL.STATE:70 (connecting)', stderr: '' }
        }
        return undefined
      }
      expect(await backend.applyTemporary(NM_UUID, manual, 30000))
        .toEqual({ ok: false, error: hasAddress ? APPLY_FAILED : addressInUse(manual.address) })
      expect(runner.calls.filter((c) => c.args.includes('device') && c.args.includes('show'))).toHaveLength(2)
    }
  })
  it('bounds the activation-failure address read by the remaining deadline', async () => {
    const { runner, backend } = make()
    runner.override = async (c) => {
      if (c.args.includes('up')) { await vi.advanceTimersByTimeAsync(900); return errorReply('Activation failed', 4) }
      return undefined
    }
    expect(await backend.applyTemporary(NM_UUID, manual, 1000)).toEqual({ ok: false, error: APPLY_FAILED })
    expect(runner.calls.at(-1)).toMatchObject({ timeoutMs: 100 })
  })
  it('maps failures without leaking stderr and recognises polkit refusals', async () => {
    for (const [stderr, expected] of [['secret diagnostic /private/path token=hidden', APPLY_FAILED],
      ['Not authorized', NOT_ALLOWED], ['Insufficient privileges', NOT_ALLOWED]]) {
      const { runner, backend } = make()
      runner.override = (c) => c.args.includes('modify') ? errorReply(stderr!) : undefined
      expect(await backend.applyTemporary(NM_UUID, automatic, 30000)).toEqual({ ok: false, error: expected })
    }
  })
  it('bounds every step by one deadline and stops before activation when it expires', async () => {
    const { runner, backend } = make()
    runner.override = async (c) => {
      if (c.args.includes('modify')) await vi.advanceTimersByTimeAsync(1000)
      return undefined
    }
    expect(await backend.applyTemporary(NM_UUID, automatic, 1000)).toEqual({ ok: false, error: APPLY_FAILED })
    expect(runner.calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 1000)).toBe(true)
    expect(writes(runner)).toHaveLength(1)
  })
  it('polls every 500 ms and requires the requested manual address', async () => {
    const { runner, backend } = make()
    let polls = 0
    runner.override = (c) => c.args.includes('GENERAL.STATE,GENERAL.HWADDR,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS') && ++polls < 4
      ? { code: 0, stdout: fixture('device-show-dhcp.txt'), stderr: '' } : undefined
    const applying = backend.applyTemporary(NM_UUID, manual, 30000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await applying).toEqual({ ok: true })
    expect(polls).toBe(4)
  })
  it('returns a clash after manual activation never obtains an address', async () => {
    const { runner, backend } = make()
    runner.override = (c) => c.args.includes('GENERAL.STATE,GENERAL.HWADDR,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS')
      ? { code: 0, stdout: 'GENERAL.STATE:70 (connecting)', stderr: '' } : undefined
    const applying = backend.applyTemporary(NM_UUID, manual, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await applying).toEqual({ ok: false, error: addressInUse(manual.address) })
  })
  it('uses reapply for a manual DNS-only change', async () => {
    const { runner, backend } = make()
    runner.settings = properties(fixture('connection-manual.txt')); runner.live = fixture('device-show-manual.txt')
    expect(await backend.applyTemporary(NM_UUID, { ...manual, dns: { mode: 'preset', preset: 'google' } }, 30000)).toEqual({ ok: true })
    expect(writes(runner)[1]?.args).toEqual(['device', 'reapply', 'ens160'])
  })
  it('snapshots all raw fields, restores them persistently, and reactivates by uuid', async () => {
    const { runner, backend } = make()
    runner.settings = properties(fixture('connection-shared.txt'))
    const before = await backend.snapshot(NM_UUID)
    expect(before).toEqual({ uuid: NM_UUID, device: 'ens160', properties: Object.fromEntries(
      SNAPSHOT_KEYS.map((k) => [k, runner.settings[k]])) })
    expect(JSON.parse(JSON.stringify(before))).toEqual(before)
    expect(await backend.restore(before)).toEqual({ ok: true })
    expect(writes(runner).map((c) => c.args)).toEqual([
      ['connection', 'modify', 'uuid', NM_UUID, ...SNAPSHOT_KEYS.flatMap((k) => [k, before.properties[k]])],
      ['--wait', '20', 'connection', 'up', 'uuid', NM_UUID],
    ])
    safeValues(runner)
  })
  it('accepts captured snapshots, empty values, and valid multi-value properties', async () => {
    const { runner, backend } = make()
    for (const name of ['auto', 'customdns', 'manual', 'shared']) {
      runner.settings = properties(fixture(`connection-${name}.txt`))
      expect(await backend.restore(await backend.snapshot(NM_UUID))).toEqual({ ok: true })
    }
    const before = await backend.snapshot(NM_UUID)
    before.properties = { 'ipv4.method': 'link-local', 'ipv4.addresses': '10.0.0.1/8,192.168.80.150/24',
      'ipv4.gateway': '10.0.0.2', 'ipv4.dns': '1.1.1.1,1.0.0.1', 'ipv4.ignore-auto-dns': 'yes',
      'ipv4.dad-timeout': '0', 'ipv6.dns': '2606:4700:4700::1111,::1', 'ipv6.ignore-auto-dns': 'no' }
    expect(await backend.restore(before)).toEqual({ ok: true })
    before.properties = Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, '']))
    expect(await backend.restore(before)).toEqual({ ok: true })
  })
  it.each([
    ['ipv4.method', 'invalid'], ['ipv4.addresses', '10.0.0.1/33'], ['ipv4.addresses', '300.0.0.1/24'],
    ['ipv4.gateway', '10.0.0.1/24'], ['ipv4.dns', 'not-an-address'], ['ipv4.dns', '1.1.1.1,'],
    ['ipv4.ignore-auto-dns', 'true'], ['ipv6.ignore-auto-dns', 'yes\t'],
    ['ipv4.dad-timeout', '-2'], ['ipv4.dad-timeout', '1.5'], ['ipv6.dns', '1.1.1.1'],
  ])('rejects invalid snapshot %s=%s before any persistent write', async (key, value) => {
    const { runner, backend } = make(), before = await backend.snapshot(NM_UUID)
    before.properties[key!] = value!
    expect(await backend.restore(before)).toEqual({ ok: false, error: APPLY_FAILED })
    expect(writes(runner)).toEqual([])
  })
  it('resets every cable and Wi-Fi profile, leaves VPN alone, and activates the uplink', async () => {
    const { runner, backend } = make()
    const wifiId = '11111111-1111-4111-8111-111111111111'
    runner.list += `Home:${wifiId}:802-11-wireless::no\nVPN:22222222-2222-4222-8222-222222222222:wireguard:mosvpn0:yes\n`
    expect(await backend.resetAll()).toEqual({ ok: true })
    const args = ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.ignore-auto-dns', 'no',
      'ipv4.dns', '', 'ipv4.dad-timeout', '-1', 'ipv6.ignore-auto-dns', 'no', 'ipv6.dns', '']
    expect(writes(runner).map((c) => c.args)).toEqual([
      ['connection', 'modify', 'uuid', NM_UUID, ...args], ['connection', 'modify', 'uuid', wifiId, ...args],
      ['--wait', '20', 'connection', 'up', 'uuid', NM_UUID],
    ])
    safeValues(runner)
  })
  it('recreates the hand-over cable profile when none exists', async () => {
    const { runner, backend } = make()
    runner.list = ''; runner.routes = '[]'
    expect(await backend.resetAll()).toEqual({ ok: true })
    expect(writes(runner)[0]?.args).toEqual(['connection', 'add', 'type', 'ethernet', 'ifname', '*', 'con-name', 'MediaOS wired',
      'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '10', 'ipv4.method', 'auto',
      'ipv4.dhcp-client-id', 'mac', 'ipv6.method', 'auto'])
    expect(writes(runner)[1]?.args).toEqual(['--wait', '20', 'connection', 'up', 'uuid', NM_UUID])
  })
  it('resets and activates an active manual profile with no default route', async () => {
    const { runner, backend } = make()
    runner.routes = '[]'; runner.settings = properties(fixture('connection-manual.txt'))
    runner.live = fixture('device-show-manual.txt')
    expect(await backend.resetAll()).toEqual({ ok: true })
    expect(writes(runner).map((c) => c.args.includes('modify') ? 'modify' : 'up')).toEqual(['modify', 'up'])
    expect(writes(runner)[1]?.args).toEqual(['--wait', '20', 'connection', 'up', 'uuid', NM_UUID])
    expect((await backend.live('ens160')).live?.address).toBe('192.168.80.137')
  })
  it('activates every reset active profile and continues after a failed modify', async () => {
    const { runner, backend } = make(), failedId = '11111111-1111-4111-8111-111111111111'
    const wifiId = '22222222-2222-4222-8222-222222222222'
    runner.list = `Gone:${failedId}:802-11-wireless::no\n` + runner.list + `Home:${wifiId}:802-11-wireless:wlan0:yes\n`
    runner.override = (c) => c.args.includes('modify') && c.args.includes(failedId) ? errorReply('profile disappeared') : undefined
    expect(await backend.resetAll()).toEqual({ ok: false, error: RESET_FAILED })
    expect(writes(runner).filter((c) => c.args.includes('modify'))).toHaveLength(3)
    expect(writes(runner).filter((c) => c.args.includes('up')).map((c) => c.args.at(-1))).toEqual([NM_UUID, wifiId])
  })
  it('activates the first cable profile when none is active', async () => {
    const { runner, backend } = make()
    runner.list = runner.list.replace(':ens160:yes', '::no')
    expect(await backend.resetAll()).toEqual({ ok: true })
    expect(writes(runner).at(-1)?.args).toEqual(['--wait', '20', 'connection', 'up', 'uuid', NM_UUID])
  })
  it.each(['modify', 'up', 'add', 'show'])('returns the reset text for a failed %s and preserves permission refusals', async (step) => {
    for (const [stderr, error] of [['diagnostic /private/path', RESET_FAILED], ['Not authorized', NOT_ALLOWED]]) {
      const { runner, backend } = make()
      if (step === 'add') runner.list = ''
      runner.override = (c) => c.args.includes(step) ? errorReply(stderr!) : undefined
      expect(await backend.resetAll()).toEqual({ ok: false, error })
    }
  })
})

describe('NmBackend checkpoints and reads', () => {
  it('creates a checkpoint on exactly the uplink device with DESTROY_ALL', async () => {
    const { runner, backend } = make()
    expect(await backend.begin(NM_UUID, 90)).toBe(NM_CHECKPOINT)
    expect(runner.calls.at(-1)?.args.slice(-6)).toEqual(['CheckpointCreate', 'aouu', '1',
      '/org/freedesktop/NetworkManager/Devices/2', '90', '1'])
  })
  it('classifies a refused checkpoint as a safe user-facing error', async () => {
    const { runner, backend } = make()
    runner.override = (c) => c.args.includes('CheckpointCreate') ? errorReply(fixture('busctl-denied.err')) : undefined
    await expect(backend.begin(NM_UUID, 90)).rejects.toBeInstanceOf(UserFacingError)
    await expect(backend.begin(NM_UUID, 90)).rejects.toThrow(NOT_ALLOWED)
  })
  it.each(['commit', 'rollback'] as const)('%s maps gone and throws on other failures', async (method) => {
    const { runner, backend } = make()
    runner.override = (c) => c.file === 'busctl' ? errorReply(fixture('busctl-destroy-gone.err')) : undefined
    expect(await backend[method](NM_CHECKPOINT)).toBe('gone')
    runner.override = (c) => c.file === 'busctl' ? errorReply(fixture('busctl-denied.err')) : undefined
    await expect(backend[method](NM_CHECKPOINT)).rejects.toThrow(NOT_ALLOWED)
  })
  it('destroys all checkpoints, ignores vanished ones, and accepts an empty list', async () => {
    const { runner, backend } = make()
    const second = '/org/freedesktop/NetworkManager/Checkpoint/2'
    runner.override = (c) => {
      if (c.args.includes('Checkpoints')) return { code: 0, stderr: '',
        stdout: JSON.stringify({ type: 'ao', data: [NM_CHECKPOINT, second] }) }
      if (c.args.includes('CheckpointDestroy') && c.args.at(-1) === NM_CHECKPOINT) {
        return errorReply(fixture('busctl-destroy-gone.err'))
      }
      return undefined
    }
    await backend.clearCheckpoints()
    expect(runner.calls.filter((c) => c.args.includes('CheckpointDestroy')).map((c) => c.args.slice(-3)))
      .toEqual([['CheckpointDestroy', 'o', NM_CHECKPOINT], ['CheckpointDestroy', 'o', second]])
    runner.override = undefined; runner.calls = []; runner.alive = false
    await backend.clearCheckpoints()
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args.at(-1)).toBe('Checkpoints')
  })
  it.each(['Checkpoints', 'CheckpointDestroy'])('throws when clearing checkpoints fails at %s', async (step) => {
    const { runner, backend } = make()
    runner.override = (c) => c.args.includes(step) ? errorReply(fixture('busctl-denied.err')) : undefined
    await expect(backend.clearCheckpoints()).rejects.toThrow(NOT_ALLOWED)
  })
  it('requires every rollback result to be zero', async () => {
    const { runner, backend } = make()
    expect(await backend.rollback(NM_CHECKPOINT)).toBe('ok')
    runner.override = () => ({ code: 0, stderr: '', stdout: '{"type":"a{su}","data":[{"dev":0,"other":1}]}' })
    await expect(backend.rollback(NM_CHECKPOINT)).rejects.toThrow(APPLY_FAILED)
  })
  it('reads alive and Unsaved, compares saved properties, and saves on the settings object', async () => {
    const { runner, backend } = make()
    expect(await backend.alive(NM_CHECKPOINT)).toBe(true)
    runner.alive = false; expect(await backend.alive(NM_CHECKPOINT)).toBe(false)
    const before = await backend.snapshot(NM_UUID)
    expect(await backend.matches(before)).toBe(true)
    runner.unsaved = true
    expect(await backend.unsaved(NM_UUID)).toBe(true)
    expect(await backend.matches(before)).toBe(false)
    expect(await backend.save(NM_UUID)).toEqual({ ok: true })
    expect(runner.calls.at(-1)?.args.slice(-3)).toEqual(['/org/freedesktop/NetworkManager/Settings/2',
      'org.freedesktop.NetworkManager.Settings.Connection', 'Save'])
    expect(await backend.unsaved(NM_UUID)).toBe(false)
    runner.settings['ipv4.method'] = 'shared'; expect(await backend.matches(before)).toBe(false)
  })
  it('ignores the VPN default and chooses the lowest physical metric; unmanaged profiles cannot be edited', async () => {
    const { runner, backend } = make()
    runner.routes = '[{"dst":"default","dev":"mosvpn0","metric":0},' +
      '{"dst":"default","dev":"wlan0","metric":200},{"dst":"default","dev":"ens160","metric":100}]'
    expect((await backend.uplink())?.device).toBe('ens160')
    runner.devices = runner.devices.replace('ethernet:connected', 'ethernet:unmanaged')
    expect((await backend.profiles())[0]).toMatchObject({ id: NM_UUID, name: 'Cable', editable: false,
      why: "This connection is set up outside MediaOS, so its settings can't be changed here." })
    runner.settings = properties(fixture('connection-shared.txt'))
    expect((await backend.profiles())[0]?.config).toBeUndefined()
  })
  it('rejects option-like identifiers and invalid settings without a write', async () => {
    const { runner, backend } = make()
    expect((await backend.applyTemporary('--bad', automatic, 30000)).ok).toBe(false)
    expect((await backend.applyTemporary(NM_UUID, { ...manual, address: '-danger' }, 30000)).ok).toBe(false)
    expect(writes(runner)).toEqual([])
  })
})

describe('Node network checks with injected factories', () => {
  it('uses effective DHCP DNS, one shared lookup, and resolved IPv4 on 443', async () => {
    const { backend, network } = make(), checks = backend.checks(automatic)
    expect(await Promise.all([checks.router(), checks.dns(), checks.internet()])).toEqual([true, true, true])
    expect(network.servers).toEqual([['192.168.80.2']])
    expect(network.sockets.map(({ host, port }) => [host, port])).toEqual([['192.168.80.2', 53], ['151.101.2.132', 443]])
  })
  it('treats refusal as a router answer but not internet access', async () => {
    const socket = () => {
      const s = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      queueMicrotask(() => s.emit('error', { code: 'ECONNREFUSED' })); return s
    }
    expect(await tcpCheck('10.0.0.1', 53, 1500, true, { socket })).toBe(true)
    expect(await tcpCheck('10.0.0.1', 443, 3000, false, { socket })).toBe(false)
  })
  it('falls back to the router neighbour after both socket timeouts', async () => {
    const { runner } = make()
    runner.neighbour = fixture('neigh-192.168.80.2.json')
    const destroyed = vi.fn(), ports: number[] = []
    const checks = networkChecks(async () => ({ device: 'ens160', gateway: '192.168.80.2', dns: [] }), runner,
      { socket: (_host, port) => { ports.push(port); return Object.assign(new EventEmitter(), { destroy: destroyed }) } })
    const checking = checks.router()
    await vi.advanceTimersByTimeAsync(3000)
    expect(await checking).toBe(true); expect(ports).toEqual([53, 80]); expect(destroyed).toHaveBeenCalledTimes(2)
    runner.neighbour = fixture('neigh-192.168.80.151.json')
    const failed = checks.router(); await vi.advanceTimersByTimeAsync(3000); expect(await failed).toBe(false)
  })
  it('cancels a stuck resolver at 3 seconds and handles empty DNS', async () => {
    const cancel = vi.fn()
    const checking = resolveCheck(['10.0.0.53'], { resolver: () => ({ setServers() {}, resolve4() {}, cancel }) })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await checking).toEqual([]); expect(cancel).toHaveBeenCalledOnce()
    expect(await resolveCheck([], {})).toEqual([])
  })
})

describe('NodeCommandRunner (mock child processes)', () => {
  it('uses execFile argv, a bounded buffer and C locale; normalises failures without throwing', async () => {
    const runner = new NodeCommandRunner()
    for (const [error, expected] of [[null, { code: 0, stdout: 'out', stderr: 'err' }],
      [{ code: 4 }, { code: 4, stdout: 'out', stderr: 'err' }], [{ code: 'ENOENT' }, { fail: 'notFound' }],
      [{ killed: true }, { fail: 'timeout' }]] as const) {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cb = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void
        cb(error, 'out', 'err'); return undefined as unknown as ReturnType<typeof execFile>
      })
      expect(await runner.run('nmcli', ['connection', 'show'], { timeoutMs: 1234 })).toEqual(expected)
    }
    expect(execFile).toHaveBeenLastCalledWith('nmcli', ['connection', 'show'], expect.objectContaining({
      shell: false, maxBuffer: 1048576, timeout: 1234, env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C' }),
    }), expect.any(Function))
    vi.mocked(execFile).mockImplementation(() => { throw new Error('spawn error') })
    expect(await runner.run('missing', [], { timeoutMs: 1 })).toEqual({ fail: 'notFound' })
  })
  it('streams lines, reports one exit and kills the monitor', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    const line = vi.fn(), exit = vi.fn(), monitor = new NodeCommandRunner().spawnLines('nmcli', ['monitor'], line, exit)
    child.stdout.write('first\nsec'); child.stdout.write('ond\n')
    expect(line.mock.calls).toEqual([['first'], ['second']])
    child.emit('error', new Error('stopped')); child.emit('close', 1)
    expect(exit).toHaveBeenCalledOnce(); monitor.kill(); expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
