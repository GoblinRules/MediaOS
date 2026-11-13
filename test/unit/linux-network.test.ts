import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLinuxNetwork, withRealIp } from '../../src/main/system/linux/LinuxNetwork'
import { createMockSystem } from '../../src/main/system/mock/MockSystemServices'
import { memoryJournal } from '../../src/main/system/net/MemoryJournal'
import { runtime } from '../../src/main/core/runtime'
import { WIFI_NOT_READY } from '../../src/main/system/net/texts'
import { SNAPSHOT_KEYS } from '../../src/main/system/linux/nm-properties'
import { FakeNmRunner, fixture, NM_UUID, NM_CHECKPOINT, fakeNetworkChecks, temporary, deferred } from './helpers'

const instances: { dispose(): void }[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const net of instances.splice(0)) net.dispose(); vi.useRealTimers() })
function make(monotonic = () => Date.now()) {
  const runner = new FakeNmRunner(), network = fakeNetworkChecks(), io = memoryJournal()
  const net = createLinuxNetwork({ runner, ...network.opts, clock: runtime, monotonic,
    fs: io, journal: 'trial.json' })
  instances.push(net)
  return { net, runner, network, io }
}

describe('LinuxNetwork', () => {
  it('maps live uplink status and replaces the mock info address', async () => {
    const { net, runner, network } = make()
    expect(await net.status()).toEqual({ connected: true, kind: 'ethernet', ssid: undefined, ip: '192.168.80.137',
      prefix: 24, gateway: '192.168.80.2', dns: ['192.168.80.2'], mac: '00:0C:29:58:DD:41', internet: true,
      method: 'auto', profileId: NM_UUID })
    const mock = createMockSystem({ delayMs: 0 }); instances.push(mock)
    expect((await withRealIp(mock.info, net).get()).ip).toBe('192.168.80.137')
    expect(network.servers).toHaveLength(1)
    runner.live = fixture('device-show-manual.txt'); runner.settings['ipv4.method'] = 'shared'
    expect(await net.status()).toMatchObject({ ip: '192.168.80.150', method: 'other' })
    runner.settings['ipv4.method'] = 'manual'
    expect(await net.status()).toMatchObject({ method: 'manual' })
    runner.routes = '[]'
    expect(await net.status()).toEqual({ connected: false, kind: 'none', internet: false })
  })
  it('debounces monitor bursts at 500 ms and caches internet checks for 60 seconds', async () => {
    const { net, runner, network } = make(), changed = vi.fn()
    net.on('changed', changed)
    await net.status()
    runner.monitors[0]!.line('changed')
    await vi.advanceTimersByTimeAsync(300)
    runner.monitors[0]!.line('another')
    await vi.advanceTimersByTimeAsync(499); expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledOnce()
    expect(network.servers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60000)
    runner.monitors[0]!.line('new route')
    await vi.advanceTimersByTimeAsync(500)
    expect(changed).toHaveBeenCalledTimes(2); expect(network.servers).toHaveLength(2)
  })
  it('refreshes internet status immediately when the uplink address or device changes', async () => {
    const { net, runner, network } = make()
    expect((await net.status()).internet).toBe(true)
    runner.live = fixture('device-show-manual.txt')
    expect((await net.status()).internet).toBe(true)
    expect(network.servers).toHaveLength(2)
    runner.routes = runner.routes.replaceAll('ens160', 'wlan0')
    runner.list = runner.list.replaceAll('ens160', 'wlan0')
    runner.live = runner.live.split('\n').filter((line) => !line.startsWith('IP4.DNS')).join('\n')
    expect((await net.status()).internet).toBe(false)
    // The new device has no DNS, so the refreshed check fails without opening another socket.
    expect(network.servers).toHaveLength(2)
    runner.routes = '[]'; await net.status()
    runner.routes = fixture('route-default-1.json'); runner.list = fixture('connection-list-plain.txt')
    runner.live = fixture('device-show-dhcp.txt')
    expect((await net.status()).internet).toBe(true)
    expect(network.servers).toHaveLength(3)
  })
  it.each([false, true])('rechecks a changed uplink as soon as an in-flight check settles (rejects: %s)', async (rejects) => {
    const { net, runner } = make(), first = deferred<boolean>(), second = deferred<boolean>()
    const check = vi.spyOn(net['backend'], 'internet').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    try {
      // Exercise overlapping refresh requests directly; ordinary status calls share the serial network queue.
      const initial = net['refreshInternet']('ens160', '192.168.80.137')
      runner.live = fixture('device-show-manual.txt')
      const changed = net['refreshInternet']('ens160', '192.168.80.150')
      expect(check).toHaveBeenCalledOnce()
      if (rejects) first.reject(new Error('old check failed'))
      else first.resolve(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(check).toHaveBeenCalledTimes(2)
      second.resolve(false)
      await Promise.all([initial, changed])
      expect((await net.status()).internet).toBe(false)
      expect(check).toHaveBeenCalledTimes(2)
    } finally { check.mockRestore() }
  })
  it('uses elapsed monotonic time for the internet cache despite wall-clock jumps', async () => {
    let elapsed = 0
    const { net, network } = make(() => elapsed)
    await net.status()
    vi.setSystemTime(Date.now() + 120000)
    elapsed = 59999; await net.status()
    expect(network.servers).toHaveLength(1)
    vi.setSystemTime(Date.now() - 240000)
    elapsed = 60000; await net.status()
    expect(network.servers).toHaveLength(2)
  })
  it('restarts failed monitors with exponential back-off capped at 30 seconds', async () => {
    const { runner } = make()
    let count = 1
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      runner.monitors.at(-1)!.exit()
      await vi.advanceTimersByTimeAsync(wait - 1); expect(runner.monitors).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1); expect(runner.monitors).toHaveLength(++count)
    }
    runner.monitors.at(-1)!.line('healthy')
    runner.monitors.at(-1)!.exit()
    await vi.advanceTimersByTimeAsync(1000); expect(runner.monitors).toHaveLength(count + 1)
  })
  it('kills the monitor and cancels debounce and restart on dispose', async () => {
    const { net, runner } = make(), changed = vi.fn()
    net.on('changed', changed); runner.monitors[0]!.line('change')
    net.dispose(); net.dispose()
    expect(runner.monitors[0]!.killed).toBe(true)
    runner.monitors[0]!.exit()
    await vi.advanceTimersByTimeAsync(31000)
    expect(runner.monitors).toHaveLength(1); expect(changed).not.toHaveBeenCalled()
    const other = make(); other.runner.monitors[0]!.exit(); other.net.dispose()
    await vi.advanceTimersByTimeAsync(31000); expect(other.runner.monitors).toHaveLength(1)
  })
  it('returns the plain Wi-Fi setup message and handles a box with no Wi-Fi', async () => {
    const { net } = make()
    expect(await net.scanWifi()).toEqual([])
    expect(await net.connect('Home', 'secret')).toEqual({ ok: false, error: WIFI_NOT_READY })
    expect(await net.forget('anything')).toEqual({ ok: false, error: WIFI_NOT_READY })
  })
  it('maps synthetic Wi-Fi scan rows to known UUIDs or scan ids and merges duplicate SSIDs', async () => {
    const { net, runner } = make()
    const wifiId = '11111111-1111-4111-8111-111111111111'
    runner.list += `Home Wi-Fi:${wifiId}:802-11-wireless::no\n`
    runner.settings['802-11-wireless.ssid'] = 'Home Wi-Fi'
    runner.wifi = '*:88:Home Wi-Fi:WPA2\n:30:Home Wi-Fi:WPA2\n:40:Guest:--'
    expect(await net.scanWifi()).toEqual([
      { id: wifiId, ssid: 'Home Wi-Fi', signal: 88, secure: true, known: true, active: true },
      { id: 'scan:Guest', ssid: 'Guest', signal: 40, secure: false, known: false, active: false },
    ])
  })
  it('applies and keeps a trial end to end over the fake command runner', async () => {
    const { net, runner, io } = make(), toast = vi.fn(), trialEvent = vi.fn()
    net.onToast(toast); net.on('trial', trialEvent)
    expect(await net.recoverPending()).toEqual([])
    expect(await net.applyIp(NM_UUID, { method: 'manual', address: '192.168.80.150', prefix: 24,
      gateway: '192.168.80.2', dns: { mode: 'router' } })).toEqual({ ok: true })
    expect(runner.unsaved).toBe(true)
    const journal = JSON.parse(await io.readFile('trial.json', 'utf8')) as { state: string; checkpoint: string }
    expect(journal.state).toBe('pending'); expect(journal.checkpoint).toContain('/Checkpoint/')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await net.trial()).toMatchObject({ canKeep: true, address: '192.168.80.150', router: 'ok', dns: 'ok', internet: 'ok' })
    expect(await net.keep()).toEqual({ ok: true })
    expect(await net.trial()).toBeNull(); expect(runner.unsaved).toBe(false)
    expect(toast).toHaveBeenCalledWith({ text: 'New network settings saved.', tone: 'ok' })
    await expect(io.readFile('trial.json', 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const commands = runner.calls.filter((c) => c.file === 'busctl').map((c) => c.args)
    expect(commands.findIndex((args) => args.includes('CheckpointDestroy')))
      .toBeLessThan(commands.findIndex((args) => args.includes('Save')))
    expect(trialEvent).toHaveBeenCalled()
    expect(await net.status()).toMatchObject({ method: 'manual', ip: '192.168.80.150' })
  })
  it.each(['pending-alive', 'pending-gone', 'saving'] as const)('recovers a Linux %s journal from disk', async (mode) => {
    const temp = await temporary(), runner = new FakeNmRunner(), network = fakeNetworkChecks()
    const journal = join(temp.dir, 'net-trial.json')
    const oldSettings = { ...runner.settings }, oldLive = runner.live
    const before = { uuid: NM_UUID, device: 'ens160', properties: Object.fromEntries(
      SNAPSHOT_KEYS.map((key) => [key, oldSettings[key] ?? ''])) }
    runner.checkpointBefore = { settings: oldSettings, live: oldLive, unsaved: false }
    runner.settings = { ...oldSettings, 'ipv4.method': 'manual', 'ipv4.addresses': '192.168.80.150/24',
      'ipv4.gateway': '192.168.80.2', 'ipv4.dns': '192.168.80.2', 'ipv4.ignore-auto-dns': 'yes', 'ipv4.dad-timeout': '3000' }
    runner.live = fixture('device-show-manual.txt'); runner.unsaved = true; runner.alive = mode === 'pending-alive'
    const net = createLinuxNetwork({ runner, ...network.opts, clock: runtime, monotonic: () => Date.now(), journal })
    instances.push(net)
    try {
      await writeFile(journal, JSON.stringify({ v: 1, state: mode === 'saving' ? 'saving' : 'pending', profileId: NM_UUID,
        before, checkpoint: NM_CHECKPOINT, createdAt: '2026-11-12' }) + '\n', 'utf8')
      expect(await net.recoverPending()).toEqual(mode === 'saving' ? [] : [
        "The last network change wasn't confirmed, so MediaOS put the old settings back."])
      const calls = runner.calls.map((c) => c.args)
      if (mode === 'saving') {
        expect(calls.find((args) => args.includes('Save'))?.slice(-3)).toEqual([
          '/org/freedesktop/NetworkManager/Settings/2', 'org.freedesktop.NetworkManager.Settings.Connection', 'Save'])
        expect(runner.settings['ipv4.method']).toBe('manual')
        expect(runner.live).toBe(fixture('device-show-manual.txt'))
      } else {
        expect(Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, runner.settings[key]]))).toEqual(before.properties)
        expect(runner.live).toBe(oldLive)
        if (mode === 'pending-alive') {
          expect(calls.some((args) => args.includes('CheckpointRollback'))).toBe(true)
          expect(calls.some((args) => args.includes('modify'))).toBe(false)
        } else {
          expect(calls.filter((args) => args.includes('modify') || args.includes('up'))).toEqual([
            ['connection', 'modify', 'uuid', NM_UUID, ...SNAPSHOT_KEYS.flatMap((key) => [key, before.properties[key]!])],
            ['--wait', '20', 'connection', 'up', 'uuid', NM_UUID],
          ])
          expect(calls.some((args) => args.includes('CheckpointRollback'))).toBe(false)
        }
      }
      expect(runner.unsaved).toBe(false)
      await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { net.dispose(); await temp.dispose() }
  })
})
