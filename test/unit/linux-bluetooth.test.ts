import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BtDevice } from '@shared/system-types'
import { createLinuxBluetooth } from '../../src/main/system/linux/LinuxBluetooth'
import { parseBluez } from '../../src/main/system/linux/bt-parse'
import { runtime } from '../../src/main/core/runtime'
import type { CommandResult, CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { deferred } from './helpers'

const address = '00:AA:01:01:00:01', adapter = '/org/bluez/hci0', path = `${adapter}/dev_00_AA_01_01_00_01`
const sample = `{"type":"a{oa{sa{sv}}}","data":[{"/org/bluez":{"org.bluez.AgentManager1":{}},
"/org/bluez/hci0":{"org.bluez.Adapter1":{"Address":{"type":"s","data":"00:AA:01:00:00:00"},
"Powered":{"type":"b","data":true},"Discoverable":{"type":"b","data":false},"Pairable":{"type":"b","data":false},
"Discovering":{"type":"b","data":false}}},
"/org/bluez/hci1":{"org.bluez.Adapter1":{"Address":{"type":"s","data":"00:AA:01:01:00:01"},
"Alias":{"type":"s","data":"Test Speaker"},"Powered":{"type":"b","data":false}}},
"/org/bluez/hci0/dev_00_AA_01_01_00_01":{"org.bluez.Device1":{"Address":{"type":"s","data":"00:AA:01:01:00:01"},
"AddressType":{"type":"s","data":"public"},"Name":{"type":"s","data":"Test Speaker"},
"Alias":{"type":"s","data":"Test Speaker"},"Class":{"type":"u","data":4194304},"Paired":{"type":"b","data":false},
"Bonded":{"type":"b","data":false},"Trusted":{"type":"b","data":false},"Blocked":{"type":"b","data":false},
"LegacyPairing":{"type":"b","data":false},"Connected":{"type":"b","data":false},
"UUIDs":{"type":"as","data":["0000110e-0000-1000-8000-00805f9b34fb"]},
"Adapter":{"type":"o","data":"/org/bluez/hci0"},"ServicesResolved":{"type":"b","data":false}},
"org.bluez.MediaControl1":{"Connected":{"type":"b","data":false}}}}]}`
const properties = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).map(([key, data]) => [key, { data }]))
function device(p: Record<string, unknown> = {}, battery?: unknown) {
  return { 'org.bluez.Device1': properties({ Address: address, Adapter: adapter, Name: 'Test Speaker', ...p }),
    'org.bluez.Battery1': properties({ Percentage: battery }) }
}
function state(devices: Record<string, unknown> = { [path]: device() }, powered = true) {
  return JSON.stringify({ type: 'a{oa{sa{sv}}}', data: [{
    [adapter]: { 'org.bluez.Adapter1': properties({ Powered: powered }) }, ...devices,
  }] })
}
const reply = (stdout = '', stderr = '', code = 0): CommandResult => ({ code, stdout, stderr })
class FakeRunner implements CommandRunner {
  calls: { file: string; args: readonly string[]; timeoutMs: number }[] = []
  monitors: { file: string; args: readonly string[]; line: (line: string) => void; exit: () => void; kill: () => void }[] = []
  output = sample
  override?: (args: readonly string[]) => CommandResult | Promise<CommandResult> | undefined
  async run(file: string, args: readonly string[], opts: { timeoutMs: number }) {
    this.calls.push({ file, args, ...opts })
    return await this.override?.(args) ?? reply(args.includes('GetManagedObjects') ? this.output : '')
  }
  spawnLines(file: string, args: readonly string[], line: (line: string) => void, exit = () => {}) {
    const monitor = { file, args, line, exit, kill: vi.fn() }; this.monitors.push(monitor)
    return monitor
  }
}
const services: ReturnType<typeof createLinuxBluetooth>[] = []
function make() {
  const runner = new FakeRunner(), logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const bt = createLinuxBluetooth({ runner, logger, timers: runtime }); services.push(bt)
  return { runner, logger, bt }
}
afterEach(() => { for (const bt of services.splice(0)) bt.dispose(); vi.useRealTimers() })

describe('BlueZ parsing', () => {
  it('reads the real busctl sample', () => {
    expect(parseBluez(sample)).toEqual({ adapter: { path: adapter, powered: true }, devices: [{ path, device: {
      address, name: 'Test Speaker', kind: 'other', paired: false, connected: false,
    } }] })
  })
  it('selects adapters numerically, filters noise, reads battery, and sorts devices', () => {
    const second = `${adapter}/dev_00_AA_01_01_00_02`, third = `${adapter}/dev_00_AA_01_01_00_03`
    const objects: Record<string, unknown> = {
      '/org/bluez/hci10': { 'org.bluez.Adapter1': {} }, '/org/bluez/hci2': { 'org.bluez.Adapter1': {} },
      ...JSON.parse(state({
        [path]: device({ Name: 'zulu', Bonded: true }, 89),
        [second]: device({ Address: '00:AA:01:01:00:02', Name: 'Alpha', Connected: true }),
        [third]: device({ Address: '00:AA:01:01:00:03', Name: 'beta' }),
        [`${adapter}/dev_04`]: device({ Name: '', Alias: 'Hidden' }),
        [`${adapter}/dev_05`]: device({ Adapter: '/org/bluez/hci1', Connected: true }),
        [`${adapter}/dev_06`]: device({ Address: 'bad', Paired: true }),
      })).data[0] as Record<string, unknown>,
    }
    const parsed = parseBluez(JSON.stringify({ type: 'a{oa{sa{sv}}}', data: [objects] }))
    expect(parsed.adapter?.path).toBe(adapter)
    expect(parsed.devices.map((d) => d.device.name)).toEqual(['Alpha', 'zulu', 'beta'])
    expect(parsed.devices[1]?.device).toMatchObject({ battery: 89, paired: true })
    delete objects[adapter]
    expect(parseBluez(JSON.stringify({ type: 'a{oa{sa{sv}}}', data: [objects] })).adapter?.path).toBe('/org/bluez/hci2')
    const nameless = parseBluez(state({ [path]: device({ Name: '', Paired: true }, 101) })).devices[0]?.device
    expect(nameless?.name).toBe(address); expect(nameless?.battery).toBeUndefined()
    expect(parseBluez(state({ [path]: device({ Alias: 'Living room' }, -1) })).devices[0]?.device.name).toBe('Living room')
  })
  it.each(['broken', 'null', '{}', '[]', '{"data":[null]}'])('ignores bad JSON or unexpected structures: %s', (input) => {
    expect(parseBluez(input).devices).toEqual([])
  })
  const kinds: [Record<string, unknown>, BtDevice['kind']][] = [
    [{ Appearance: 0x180 }, 'remote'], [{ Appearance: 0x1bf }, 'remote'], [{ Name: 'TV REMOTE' }, 'remote'],
    ...Object.entries({ 'input-gaming': 'gamepad', 'input-keyboard': 'keyboard', 'input-mouse': 'mouse',
      'input-tablet': 'mouse', 'audio-headphones': 'headphones', 'audio-headset': 'headphones',
      'audio-card': 'speaker', 'audio-speakers': 'speaker', phone: 'phone' })
      .map(([Icon, kind]) => [{ Icon }, kind] as [Record<string, unknown>, BtDevice['kind']]),
    [{ Class: 0x540 }, 'keyboard'], [{ Class: 0x580 }, 'mouse'], [{ Class: 0x504 }, 'gamepad'],
    [{ Class: 0x508 }, 'gamepad'], [{ Class: 0x50c }, 'remote'], [{ Class: 0x500 }, 'other'],
    [{ Class: 0x404 }, 'headphones'], [{ Class: 0x408 }, 'headphones'], [{ Class: 0x418 }, 'headphones'],
    [{ Class: 0x414 }, 'speaker'], [{ Class: 0x200 }, 'phone'], [{ Appearance: 0x1c0, Icon: 'unknown' }, 'other'],
  ]
  it.each(kinds)('classifies %j as %s', (p, expected) => {
    expect(parseBluez(state({ [path]: device(p) })).devices[0]?.device.kind).toBe(expected)
  })
  it('sorts equal connection and pairing states by case-insensitive name', () => {
    expect(parseBluez(state({ [path]: device({ Name: 'beta' }), [`${path}02`]: device({ Name: 'Alpha' }) }))
      .devices.map((d) => d.device.name)).toEqual(['Alpha', 'beta'])
  })
})

describe('Linux Bluetooth', () => {
  it('uses the state command and returns no devices on command failures or broken output', async () => {
    const { bt, runner } = make()
    expect(await bt.devices()).toHaveLength(1)
    expect(runner.calls[0]).toEqual({ file: 'busctl', args: ['--json=short', 'call', 'org.bluez', '/',
      'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'], timeoutMs: 5000 })
    runner.output = 'broken'; expect(await bt.devices()).toEqual([])
    runner.override = () => { throw new Error('failed') }; expect(await bt.devices()).toEqual([])
    for (const fail of ['timeout', 'notFound'] as const) {
      runner.override = () => ({ fail }); expect(await bt.devices()).toEqual([])
      expect(await bt.startScan()).toEqual({ ok: false,
        error: "Bluetooth isn't working on this box. Restart the box and try again." })
    }
  })
  it('reports no adapter, switches Bluetooth on, avoids duplicate scans and kills scans', async () => {
    const { bt, runner } = make()
    runner.output = '{}'
    expect(await bt.startScan()).toEqual({ ok: false, error: 'This box has no Bluetooth. A USB Bluetooth adapter can add it.' })
    runner.output = state(undefined, false)
    expect(await bt.startScan()).toEqual({ ok: true })
    expect(runner.calls[2]).toEqual({ file: 'busctl', args: ['set-property', 'org.bluez', adapter,
      'org.bluez.Adapter1', 'Powered', 'b', 'true'], timeoutMs: 5000 })
    expect(runner.monitors[0]).toMatchObject({ file: 'bluetoothctl', args: ['--timeout', '70', 'scan', 'on'] })
    await bt.startScan(); expect(runner.monitors).toHaveLength(1)
    await bt.stopScan(); expect(runner.monitors[0]?.kill).toHaveBeenCalledOnce()
    await bt.startScan(); bt.dispose(); expect(runner.monitors[1]?.kill).toHaveBeenCalledOnce()
  })
  it('reports power and spawn failures', async () => {
    const { bt, runner } = make(); runner.output = state(undefined, false)
    runner.override = (args) => args.includes('Powered') ? reply('', 'denied', 1) : undefined
    expect(await bt.startScan()).toEqual({ ok: false,
      error: "Bluetooth couldn't be switched on. Restart the box and try again." })
    runner.output = sample; runner.override = undefined
    vi.spyOn(runner, 'spawnLines').mockImplementation(() => { throw new Error('spawn') })
    expect(await bt.startScan()).toMatchObject({ ok: false })
  })
  it('does not restart discovery if pairing or disposal interrupts a pending scan start', async () => {
    const { bt, runner } = make(), pending = deferred<CommandResult>()
    runner.override = (args) => args.includes('GetManagedObjects') ? pending.promise : undefined
    const scan = bt.startScan(), pairing = bt.pair(address)
    pending.resolve(reply(sample))
    expect(await scan).toEqual({ ok: true }); expect(await pairing).toEqual({ ok: true })
    expect(runner.monitors).toEqual([])
    const next = deferred<CommandResult>()
    runner.override = () => next.promise
    const late = bt.startScan(); bt.dispose(); next.resolve(reply(sample))
    expect(await late).toEqual({ ok: true }); expect(runner.monitors).toEqual([])
  })
  it('throttles lines with a trailing event, emits exit, catches listeners, and clears timers', async () => {
    vi.useFakeTimers(); const { bt, runner, logger } = make(), changed = vi.fn()
    const unsub = bt.on('changed', changed)
    bt.on('changed', () => { throw new Error('listener') })
    await bt.startScan()
    const scan = runner.monitors[0]!
    scan.line('Discovery started'); scan.line('\u001b[32m[NEW] Device')
    expect(changed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(999); expect(changed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledTimes(2)
    scan.line('[CHG]'); scan.exit(); expect(changed).toHaveBeenCalledTimes(3)
    expect(logger.warn).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000); expect(changed).toHaveBeenCalledTimes(3)
    await bt.startScan(); runner.monitors[1]!.line('first'); runner.monitors[1]!.line('second')
    unsub(); bt.dispose(); await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['', 'Already Exists'])('stops scanning, pairs, trusts and connects (%s)', async (pairMessage) => {
    const { bt, runner } = make(), changed = vi.fn(); bt.on('changed', changed)
    await bt.startScan()
    runner.override = (args) => {
      if (args.includes('Pair')) {
        expect(runner.monitors[0]?.kill).toHaveBeenCalledOnce()
        return reply('', pairMessage, pairMessage ? 1 : 0)
      }
      if (args.includes('Trusted')) return reply('', 'denied', 1)
      if (args.includes('Connect')) return reply('', 'br-connection-profile-unavailable', 1)
    }
    expect(await bt.pair(address.toLowerCase())).toEqual({ ok: true })
    expect(runner.calls.slice(-3)).toEqual([
      { file: 'busctl', args: ['--timeout=60', 'call', 'org.bluez', path, 'org.bluez.Device1', 'Pair'], timeoutMs: 65000 },
      { file: 'busctl', args: ['set-property', 'org.bluez', path, 'org.bluez.Device1', 'Trusted', 'b', 'true'], timeoutMs: 5000 },
      { file: 'busctl', args: ['--timeout=30', 'call', 'org.bluez', path, 'org.bluez.Device1', 'Connect'], timeoutMs: 35000 },
    ])
    expect(changed).toHaveBeenCalledTimes(2)
  })
  const rejected = "The device didn't accept the pairing. Put it in pairing mode and try again. " +
    "Devices that ask for a PIN code can't be added yet."
  const unavailable = "That device isn't available. Look for devices again and choose it from the list."
  const busy = 'MediaOS is already adding a device. Wait a moment and try again.'
  const unanswered = "The device didn't answer. Put it in pairing mode, bring it closer and try again."
  it.each([
    ['AuthenticationFailed', rejected], ['AuthenticationRejected', rejected], ['AuthenticationCanceled', rejected],
    ['AuthenticationTimeout', rejected], ['Page Timeout', unanswered], ['Connection Timeout', unanswered],
    ['Host is down', unanswered], ['timeout', unanswered], ['In Progress', busy], ['Busy', busy],
    ['Does Not Exist', unavailable], ['Method "Pair" with signature "" on interface "org.bluez.Device1" doesn\'t exist', unavailable],
    ['other', "The device couldn't be added. Put it in pairing mode and try again."],
  ])('maps pairing error %s', async (message, error) => {
    const { bt, runner } = make()
    runner.override = (args) => args.includes('Pair')
      ? message === 'timeout' ? { fail: 'timeout' } : reply('', `Call failed: ${message}`, 1) : undefined
    expect(await bt.pair(address)).toEqual({ ok: false, error })
  })
  it('validates addresses, requires a present device and refuses concurrent pairing', async () => {
    const { bt, runner } = make()
    expect(await bt.pair('bad')).toEqual({ ok: false, error: unavailable })
    expect(runner.calls).toEqual([])
    runner.output = state({}); expect(await bt.pair(address)).toEqual({ ok: false, error: unavailable })
    runner.output = sample
    const pending = deferred<CommandResult>()
    runner.override = (args) => args.includes('Pair') ? pending.promise : undefined
    const first = bt.pair(address)
    expect(await bt.pair(address)).toEqual({ ok: false, error: busy })
    expect(await bt.remove(address)).toEqual({ ok: false, error: busy })
    expect(runner.calls.some((c) => c.args.includes('RemoveDevice'))).toBe(false)
    pending.resolve(reply()); expect(await first).toEqual({ ok: true })
  })
  it('starts a fresh scan when looking is stopped and started again before BlueZ answers', async () => {
    const { bt, runner } = make(), pending = deferred<CommandResult>()
    runner.override = (args) => args.includes('GetManagedObjects') ? pending.promise : undefined
    const first = bt.startScan()
    await bt.stopScan()
    runner.override = undefined
    const second = bt.startScan()
    expect(second).not.toBe(first)
    pending.resolve(reply(sample))
    expect(await first).toEqual({ ok: true }); expect(await second).toEqual({ ok: true })
    expect(runner.monitors).toHaveLength(1)
  })
  it('forgets by adapter and object path, tolerates missing devices and reports failures', async () => {
    const { bt, runner } = make(), changed = vi.fn(); bt.on('changed', changed)
    expect(await bt.remove('bad')).toEqual({ ok: true }); expect(runner.calls).toEqual([])
    expect(await bt.remove(address.toLowerCase())).toEqual({ ok: true })
    expect(runner.calls[1]).toEqual({ file: 'busctl', args: ['call', 'org.bluez', adapter,
      'org.bluez.Adapter1', 'RemoveDevice', 'o', path], timeoutMs: 5000 })
    for (const message of ['Does Not Exist', "doesn't exist", 'denied']) {
      runner.override = (args) => args.includes('RemoveDevice') ? reply('', message, 1) : undefined
      expect(await bt.remove(address)).toEqual(message === 'denied'
        ? { ok: false, error: "The device couldn't be forgotten. Try again." } : { ok: true })
    }
    runner.output = state({}); expect(await bt.remove(address)).toEqual({ ok: true })
    expect(changed).toHaveBeenCalledTimes(5)
  })
  it('can pair and forget a previously listed device whose name has disappeared', async () => {
    const { bt, runner } = make()
    runner.output = state({ [path]: device({ Name: '' }) })
    expect(await bt.devices()).toEqual([])
    expect(await bt.pair(address)).toEqual({ ok: true })
    expect(await bt.remove(address)).toEqual({ ok: true })
    expect(runner.calls.some((call) => call.args.includes('Pair'))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes('RemoveDevice'))).toBe(true)
  })
})
