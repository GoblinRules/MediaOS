import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createLinuxSystem, type LinuxSystemOptions } from '../../src/main/system/linux/LinuxSystem'
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { fallbackZones, parseAudioOutputs, parseDisplayOutputs } from '../../src/main/system/linux/system-parse'
import { composeCore } from '../../src/main/core/compose'
import * as linuxNetwork from '../../src/main/system/linux/LinuxNetwork'
import * as linuxSystem from '../../src/main/system/linux/LinuxSystem'
import { createMockSystem } from '../../src/main/system/mock/MockSystemServices'
import { UserFacingError } from '../../src/main/system/net/texts'
import { temporary } from './helpers'

const reply = (stdout = '', code = 0): CommandResult => ({ code, stdout, stderr: '' })
const nodeName = 'alsa_output.pci-0000_02_01.0.analog-stereo'
const sink = (id = 52, props: Record<string, unknown> = {}) => ({ id, type: 'PipeWire:Interface:Node',
  info: { props: { 'media.class': 'Audio/Sink', 'node.name': nodeName,
    'node.description': 'HD Audio Controller Analog Stereo', 'device.api': 'alsa', ...props } } })
const dump = (value: unknown = { name: nodeName }) => JSON.stringify([sink(),
  { type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: [{ key: 'default.audio.sink', value }] }])
const small = { width: 1280, height: 720, refresh: 60000 }
const normal = { width: 1920, height: 1080, refresh: 59940 }
const fast = { ...normal, refresh: 60000 }
const large = { width: 3840, height: 2160, refresh: 30000 }
const screen = (extra = {}) => ({ name: 'Virtual-1', make: 'Unknown', model: 'Unknown', active: true,
  current_mode: normal, modes: [small, normal, large, fast, normal], ...extra })

class FakeRunner implements CommandRunner {
  calls: { file: string; args: string[]; timeoutMs: number }[] = []
  respond: (file: string, args: readonly string[]) => CommandResult = (file, args) => {
    if (file === 'pw-dump') return reply(dump())
    if (file === 'swaymsg' && args[0] === '-t') return reply(JSON.stringify([screen()]))
    if (file === 'wpctl' && args[0] === 'get-volume') return reply('Volume: 0.40')
    if (file === 'timedatectl' && args[0] === 'show') return reply('Timezone=Europe/London\nNTPSynchronized=yes\n')
    if (file === 'timedatectl' && args[0] === 'list-timezones') return reply('Europe/London\nEurope/Paris\nUTC\n')
    return reply()
  }
  async run(file: string, args: readonly string[], opts: { timeoutMs: number }): Promise<CommandResult> {
    this.calls.push({ file, args: [...args], ...opts })
    return this.respond(file, args)
  }
  spawnLines(): { kill(): void } { throw new Error('The system services must not start a monitor') }
}
function make(overrides: Partial<LinuxSystemOptions> = {}) {
  const runner = new FakeRunner()
  const io: NonNullable<LinuxSystemOptions['fs']> = {
    ...fs,
    access: vi.fn(async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }) }),
    readFile: vi.fn(async () => 'NAME=Debian\nPRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n'),
    readdir: vi.fn(async () => [] as string[]),
    writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => {}),
    statfs: vi.fn(async () => ({ blocks: 100 * 1024, bsize: 1048576, bavail: 40 * 1024 })),
  }
  const facts = { release: () => '6.12.0-test', cpus: () => [{ model: ' Intel(R)  Core(TM)  CPU ' }],
    totalmem: () => 8192.4 * 1048576, uptime: () => 1234.9, tmpdir: () => '/fake-tmp' }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const opts: LinuxSystemOptions = { appVersion: '2.3.4', deviceName: () => 'Snug TV', runner, fs: io, os: facts,
    clock: { now: () => Date.UTC(2026, 10, 13, 12) }, logger, ...overrides }
  const system = createLinuxSystem(opts)
  return { system, runner, io, facts, logger }
}
afterEach(() => vi.restoreAllMocks())

describe('Linux sound', () => {
  it.each([{ name: nodeName }, JSON.stringify({ name: nodeName })])('reads the real sink and default metadata (%j)', async (value) => {
    const { system, runner } = make()
    runner.respond = () => reply(dump(value))
    expect(await system.audio.outputs()).toEqual([
      { id: '52', name: 'HD Audio Controller Analog Stereo', kind: 'analog', active: true },
    ])
    expect(runner.calls).toEqual([{ file: 'pw-dump', args: [], timeoutMs: 4000 }])
  })
  it('classifies sinks, falls back through nick and name, and ignores malformed nodes', () => {
    const output = parseAudioOutputs(JSON.stringify([
      sink(1, { 'device.api': 'bluez5' }), sink(2, { 'node.name': 'alsa.hdmi.usb' }),
      sink(3, { 'node.name': 'alsa.usb' }), sink(4, { 'device.bus': 'usb' }),
      sink(5, { 'node.name': 'plain', 'node.description': '', 'node.nick': 'Nick' }),
      sink(6, { 'node.description': '', 'node.name': 'Name' }),
      sink(7, { 'media.class': 'Audio/Source' }), null, {}, { ...sink(), id: 'not-numeric' },
      sink(8, { 'node.name': {}, 'node.description': null }),
    ]))
    expect(output.map((item) => item.kind)).toEqual(['bluetooth', 'hdmi', 'usb', 'usb', 'other', 'other'])
    expect(output.slice(-2).map((item) => item.name)).toEqual(['Nick', 'Name'])
    expect(output.every((item) => !item.active)).toBe(true)
  })
  it.each(['broken', '{}', 'null', '[null,1,{},[]]'])('handles broken or unexpected JSON: %s', async (stdout) => {
    const { system, runner } = make()
    runner.respond = () => reply(stdout)
    expect(await system.audio.outputs()).toEqual([])
    expect(await system.display.outputs()).toEqual([])
  })
  it.each([{ fail: 'notFound' }, { fail: 'timeout' }, reply('', 1)] as CommandResult[])(
    'returns empty outputs on command failure: %j', async (failure) => {
    const { system, runner, logger } = make()
    runner.respond = () => failure
    expect(await system.audio.outputs()).toEqual([])
    expect(await system.display.outputs()).toEqual([])
    expect(logger.warn).toHaveBeenCalled()
    await expect(system.audio.volume()).rejects.toThrow("The sound volume couldn't be read.")
  })
  it.each([['Volume: 0.40', 40], ['Volume: 0.405 [MUTED]\n', 41], ['Volume: 1.50', 100], ['Volume: -0.50', 0]])(
    'reads volume and clamps it (%s)', async (stdout, expected) => {
    const { system, runner } = make()
    runner.respond = () => reply(stdout)
    expect(await system.audio.volume()).toBe(expected)
    expect(runner.calls[0]?.args).toEqual(['get-volume', '@DEFAULT_AUDIO_SINK@'])
  })
  it('hides unreadable volume and sets a clamped volume with a maximum of 1.0', async () => {
    const { system, runner } = make()
    runner.respond = () => reply('Volume: unknown')
    await expect(system.audio.volume()).rejects.toThrow("The sound volume couldn't be read.")
    for (const pct of [-20, 40.4, 150]) expect(await system.audio.setVolume(pct)).toEqual({ ok: true })
    expect(runner.calls.slice(1).map((call) => call.args)).toEqual(['0.00', '0.40', '1.00'].map((value) =>
      ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', value]))
    expect(await system.audio.setVolume(NaN)).toMatchObject({ ok: false })
    runner.respond = () => reply('', 1)
    expect(await system.audio.setVolume(40)).toMatchObject({ ok: false })
  })
  it('checks sink ids afresh before changing the default and remembers the channel layout', async () => {
    const { system, runner, logger } = make()
    expect(await system.audio.setOutput('unknown')).toMatchObject({ ok: false })
    expect(await system.audio.setOutput('52')).toEqual({ ok: true })
    expect(runner.calls.map((call) => [call.file, call.args])).toEqual([
      ['pw-dump', []], ['pw-dump', []], ['wpctl', ['set-default', '52']],
    ])
    expect(await system.audio.setChannels('7.1')).toEqual({ ok: true })
    await system.audio.testTone()
    expect(logger.debug).toHaveBeenCalledWith('Sound check requested', '7.1')
    runner.respond = () => reply('[]')
    expect(await system.audio.setOutput('52')).toMatchObject({ ok: false })
  })
  it.each([false, true])('writes a quiet WAV and always removes its unique file (play failure: %s)', async (failure) => {
    const { system, runner, io } = make()
    runner.respond = () => failure ? { fail: 'timeout' } : reply()
    expect(await system.audio.testTone()).toMatchObject({ ok: !failure })
    expect(await system.audio.testTone()).toMatchObject({ ok: !failure })
    const writes = vi.mocked(io.writeFile).mock.calls
    const wav = writes[0]?.[1] as Buffer
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(48000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.length).toBe(96044)
    let peak = 0, crossings = 0
    for (let at = 44; at < wav.length; at += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(at)))
      if (at > 44 && wav.readInt16LE(at - 2) < 0 && wav.readInt16LE(at) >= 0) crossings++
    }
    expect(peak).toBeLessThanOrEqual(6554)
    expect(peak).toBeGreaterThan(6500)
    expect(crossings).toBe(440)
    expect(writes[0]?.[0]).not.toBe(writes[1]?.[0])
    expect(runner.calls[0]).toEqual({ file: 'pw-play', args: [writes[0]?.[0]], timeoutMs: 5000 })
    expect(io.rm).toHaveBeenCalledWith(writes[0]?.[0], { force: true })
    expect(io.rm).toHaveBeenCalledWith(writes[1]?.[0], { force: true })
  })
  it('cleans up after write or runner exceptions', async () => {
    const { system, runner, io } = make()
    vi.mocked(io.writeFile).mockRejectedValueOnce(new Error('disk full'))
    expect(await system.audio.testTone()).toMatchObject({ ok: false })
    expect(io.rm).toHaveBeenCalledOnce()
    expect(runner.calls).toEqual([])
    runner.respond = () => { throw new Error('spawn failed') }
    expect(await system.audio.testTone()).toMatchObject({ ok: false })
    expect(io.rm).toHaveBeenCalledTimes(2)
    expect(await system.audio.outputs()).toEqual([])
  })
})

describe('Linux screens', () => {
  it('deduplicates and sorts modes, matches current mode, and uses a plain TV name for unknown hardware', async () => {
    const { system } = make()
    expect(await system.display.outputs()).toEqual([{ id: 'Virtual-1', name: 'TV', connected: true, scale: 1,
      current: { id: '1920x1080@59940', width: 1920, height: 1080, refresh: 59.94 },
      modes: [large, fast, normal, small].map((mode) => ({ id: `${mode.width}x${mode.height}@${mode.refresh}`,
        width: mode.width, height: mode.height, refresh: mode.refresh / 1000 })),
    }])
    expect(parseDisplayOutputs(JSON.stringify([screen({ make: 'Acme', model: 'Cinema', scale: 1.5, active: false,
      modes: [null, {}, { width: -1, height: 1080, refresh: 60000 }], current_mode: normal })]))[0])
      .toMatchObject({ name: 'Acme Cinema', connected: false, scale: 1.5, modes: [], current: undefined })
    expect(parseDisplayOutputs(JSON.stringify([screen({ make: '', model: 'Model' })]))[0]?.name).toBe('TV')
  })
  it('uses separate arguments and converts mHz into three-decimal Hz', async () => {
    const { system, runner } = make()
    expect(await system.display.setMode('Virtual-1', '1920x1080@59940')).toEqual({ ok: true })
    expect(await system.display.setScale('Virtual-1', 1.5)).toEqual({ ok: true })
    expect(await system.display.power(false)).toEqual({ ok: true })
    expect(await system.display.power(true)).toEqual({ ok: true })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['-t', 'get_outputs', '--raw'], ['output', 'Virtual-1', 'mode', '1920x1080@59.940Hz'],
      ['-t', 'get_outputs', '--raw'], ['output', 'Virtual-1', 'scale', '1.5'],
      ['output', '*', 'power', 'off'], ['output', '*', 'power', 'on'],
    ])
  })
  it('refuses unknown modes, unknown outputs, unsafe names and invalid scales', async () => {
    const { system, runner } = make()
    expect(await system.display.setMode('Virtual-1', 'bogus')).toMatchObject({ ok: false })
    expect(await system.display.setMode('missing', '1920x1080@59940')).toMatchObject({ ok: false })
    for (const output of ['bad; power off', '*', 'HDMI A', '-t']) {
      expect(await system.display.setMode(output, '1920x1080@59940')).toMatchObject({ ok: false })
      expect(await system.display.setScale(output, 1)).toMatchObject({ ok: false })
    }
    for (const scale of [0.49, 3.01, NaN, Infinity]) {
      expect(await system.display.setScale('Virtual-1', scale)).toMatchObject({ ok: false })
    }
    expect(runner.calls.every((call) => call.args[0] === '-t')).toBe(true)
    expect(parseDisplayOutputs(JSON.stringify([screen({ name: 'HDMI; power off' })]))).toEqual([])
    expect(await system.display.setScale('Virtual-1', 0.5)).toEqual({ ok: true })
    expect(await system.display.setScale('Virtual-1', 3)).toEqual({ ok: true })
  })
  it('reports both non-zero status and sway command rejection', async () => {
    const { system, runner } = make()
    const respond = runner.respond
    runner.respond = (file, args) => args[0] === '-t' ? respond(file, args) : reply('', 1)
    expect(await system.display.setMode('Virtual-1', '1920x1080@59940')).toMatchObject({ ok: false })
    runner.respond = () => reply('[{"success":false,"error":"invalid"}]')
    expect(await system.display.power(false)).toMatchObject({ ok: false })
  })
})

describe('Linux services without invented hardware', () => {
  it('wires Bluetooth state reads and validation to the real service', async () => {
    const { system, runner } = make()
    runner.respond = () => reply('{"type":"a{oa{sa{sv}}}","data":[{}]}')
    const changed = vi.fn(), unsubscribe = system.bluetooth.on('changed', changed)
    expect(await system.bluetooth.devices()).toEqual([])
    expect(await system.bluetooth.startScan()).toEqual({ ok: false,
      error: 'This box has no Bluetooth. A USB Bluetooth adapter can add it.' })
    expect(await system.bluetooth.pair('any')).toEqual({ ok: false,
      error: "That device isn't available. Look for devices again and choose it from the list." })
    expect(runner.calls.every((call) => call.file === 'busctl' && call.args.includes('GetManagedObjects'))).toBe(true)
    expect(await system.bluetooth.stopScan()).toEqual({ ok: true })
    expect(await system.bluetooth.remove('any')).toEqual({ ok: true })
    unsubscribe(); system.dispose(); expect(changed).not.toHaveBeenCalled()
  })
  it('reports no CEC adapter and explains that updates are not set up', async () => {
    const { system } = make()
    expect(await system.cec.status()).toEqual({ adapter: false })
    const error = { ok: false, error: 'No TV remote adapter is connected.' }
    expect(await system.cec.wakeTv()).toEqual(error)
    expect(await system.cec.standbyTv()).toEqual(error)
    expect(await system.cec.setActiveSource()).toEqual({ ok: true })
    await expect(system.updates.check()).rejects.toThrow("Updates aren't set up on this box. It has MediaOS 2.3.4.")
    await expect(system.updates.check()).rejects.toBeInstanceOf(UserFacingError)
    expect(await system.updates.apply()).toEqual({ ok: false,
      error: "Updates aren't set up on this box. It has MediaOS 2.3.4." })
    system.dispose()
  })
  it('runs real power commands and returns plain failure messages', async () => {
    const { system, runner } = make()
    expect(await system.power.reboot()).toEqual({ ok: true })
    expect(await system.power.powerOff()).toEqual({ ok: true })
    expect(runner.calls).toEqual(['reboot', 'poweroff'].map((verb) =>
      ({ file: 'systemctl', args: [verb], timeoutMs: 4000 })))
    runner.respond = () => ({ fail: 'notFound' })
    expect(await system.power.reboot()).toEqual({ ok: false,
      error: "The box couldn't restart. Try again, or switch it off at the plug." })
    runner.respond = () => reply('', 1)
    expect(await system.power.powerOff()).toEqual({ ok: false,
      error: "The box couldn't switch off. Try again, or switch it off at the plug." })
  })
})

describe('Linux time and machine information', () => {
  it('reads the time zone and NTP with an injected clock, and falls back on failure', async () => {
    const { system, runner } = make()
    expect(await system.time.get()).toEqual({ iso: '2026-11-13T12:00:00.000Z', timezone: 'Europe/London', ntp: true })
    runner.respond = () => ({ fail: 'timeout' })
    expect(await system.time.get()).toEqual({ iso: '2026-11-13T12:00:00.000Z',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: false })
    runner.respond = () => reply('Timezone=not a zone\nNTPSynchronized=no')
    expect(await system.time.get()).toMatchObject({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: false })
  })
  it('caches a successful zone list, protects the cache and validates changes', async () => {
    const { system, runner } = make()
    const zones = await system.time.zones()
    expect(zones).toEqual(['Europe/London', 'Europe/Paris', 'UTC'])
    zones.push('injected')
    expect(await system.time.zones()).toEqual(['Europe/London', 'Europe/Paris', 'UTC'])
    expect(await system.time.setTimezone('injected')).toMatchObject({ ok: false })
    expect(await system.time.setTimezone('Europe/Paris')).toEqual({ ok: true })
    expect(runner.calls).toEqual([
      { file: 'timedatectl', args: ['list-timezones'], timeoutMs: 10000 },
      { file: 'timedatectl', args: ['set-timezone', 'Europe/Paris'], timeoutMs: 4000 },
    ])
    runner.respond = () => reply('', 1)
    expect(await system.time.setTimezone('UTC')).toEqual({ ok: false, error: "The time zone couldn't be changed. Try again." })
  })
  it.each(['failure', 'broken'])('falls back without caching unsuccessful zones (%s)', async (mode) => {
    const { system, runner } = make()
    const respond = runner.respond
    runner.respond = () => mode === 'failure' ? { fail: 'notFound' } : reply('broken output\n{}\nInvalid/Zone\n')
    expect(await system.time.zones()).toEqual(fallbackZones)
    runner.respond = respond
    expect(await system.time.zones()).toEqual(['Europe/London', 'Europe/Paris', 'UTC'])
    expect(runner.calls).toHaveLength(2)
  })
  it('reads the machine, storage, version and current saved device name without a mock IP', async () => {
    let deviceName = 'Snug TV'
    const { system, io } = make({ deviceName: () => deviceName })
    expect(await system.info.get()).toEqual({ deviceName: 'Snug TV', version: '2.3.4', os: 'Debian GNU/Linux 13 (trixie)',
      kernel: '6.12.0-test', cpu: 'Intel Core CPU', memoryMb: 8192, uptimeSec: 1234, platform: 'linux',
      storage: { totalGb: 100, freeGb: 40 } })
    expect(io.readFile).toHaveBeenCalledWith('/etc/os-release', 'utf8')
    expect(io.statfs).toHaveBeenCalledWith('/')
    deviceName = 'Bedroom'
    expect((await system.info.get()).deviceName).toBe('Bedroom')
  })
  it('uses honest fallbacks for missing distribution, CPU and storage', async () => {
    const { system, io, facts } = make()
    facts.cpus = () => []
    vi.mocked(io.readFile).mockRejectedValue(new Error('missing'))
    vi.mocked(io.statfs).mockRejectedValue(new Error('unavailable'))
    expect(await system.info.get()).toMatchObject({ os: 'Linux', cpu: 'Unknown', storage: { totalGb: 0, freeGb: 0 } })
  })
  it('shares redacted diagnostics and retains the three newest bundles without a mock screen line', async () => {
    const temp = await temporary()
    let now = 100
    const { system, io } = make({ logDir: temp.dir, clock: { now: () => now++ } })
    io.mkdir = fs.mkdir; io.writeFile = fs.writeFile; io.readdir = fs.readdir; io.rm = fs.rm
    const osRelease = io.readFile
    io.readFile = (path, options) => path === '/etc/os-release' ? osRelease(path, options) : fs.readFile(path, options)
    try {
      await fs.writeFile(join(temp.dir, 'mediaos.log.1'), 'old log\n', 'utf8')
      await fs.writeFile(join(temp.dir, 'mediaos.log'), 'token=secret-token\n', 'utf8')
      for (let i = 0; i < 4; i++) await system.info.collectDiagnostics()
      const bundles = (await fs.readdir(temp.dir)).filter((name) => name.startsWith('diagnostics-'))
      expect(bundles.sort()).toEqual(['diagnostics-101.txt', 'diagnostics-102.txt', 'diagnostics-103.txt'])
      const text = await fs.readFile(join(temp.dir, bundles[0]!), 'utf8')
      expect(text).toContain('MediaOS diagnostics\n')
      expect(text).toContain('old log\n')
      expect(text).toContain('"platform":"linux"')
      expect(text).not.toContain('Screen on:')
      expect(text).not.toContain('secret-token')
      vi.spyOn(io, 'mkdir').mockRejectedValue(new Error('disk full'))
      await expect(system.info.collectDiagnostics()).rejects.toThrow("The log bundle couldn't be saved.")
    } finally { system.dispose(); await temp.dispose() }
  })
  it('starts no persistent resources and refuses new commands after disposal', async () => {
    const { system, runner } = make()
    system.dispose(); system.dispose()
    expect(await system.audio.outputs()).toEqual([])
    expect(await system.power.reboot()).toMatchObject({ ok: false })
    expect(runner.calls).toEqual([])
  })
})

describe('system composition', () => {
  it.each(['linux', 'mock'] as const)('chooses %s services without opting into real networking', async (platform) => {
    const temp = await temporary(), runner = new FakeRunner()
    vi.spyOn(NodeCommandRunner.prototype, 'run').mockImplementation((file, args, opts) => runner.run(file, args, opts))
    const create = vi.spyOn(linuxSystem, 'createLinuxSystem')
    const composed = await composeCore({ platform, dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      appVersion: '9.8.7', forceMockPlayer: true, mockDelayMs: 0, processes: { list: async () => [], signal: () => false },
      restartShell() {} })
    const dispose = platform === 'linux' ? vi.spyOn(create.mock.results[0]!.value as linuxSystem.LinuxSystem, 'dispose') : undefined
    try {
      const system = composed.core.system
      expect((await system.info.get()).platform).toBe(platform)
      expect((await system.info.get()).version).toBe(platform === 'linux' ? '9.8.7' : '0.1.0')
      expect((await system.audio.outputs())[0]?.id).toBe(platform === 'linux' ? '52' : 'hdmi')
      expect((await system.network.status()).ip).toBe('192.168.1.42')
      if (platform === 'linux') {
        expect(await system.bluetooth.devices()).toEqual([])
        expect(await system.cec.status()).toEqual({ adapter: false })
        expect(await system.time.get()).toMatchObject({ timezone: 'Europe/London' })
      } else expect(create).not.toHaveBeenCalled()
    } finally { await composed.dispose(); await temp.dispose() }
    if (dispose) expect(dispose).toHaveBeenCalledOnce()
  })
  it('keeps real-network selection, the info IP wrapper and disposal', async () => {
    const temp = await temporary(), net = createMockSystem({ delayMs: 0 })
    const dispose = vi.fn(() => net.dispose())
    const network = { ...net.network, status: async () => ({ ...await net.network.status(), ip: '10.20.30.40' }), dispose }
    // Only the public service contract is needed at the composition boundary; no real network monitor is started.
    vi.spyOn(linuxNetwork, 'createLinuxNetwork').mockReturnValue(network as unknown as linuxNetwork.LinuxNetwork)
    vi.spyOn(NodeCommandRunner.prototype, 'run').mockResolvedValue(reply('[]'))
    const composed = await composeCore({ platform: 'linux', realSystem: ['network'], dataDir: temp.dir,
      logDir: join(temp.dir, 'logs'), forceMockPlayer: true, processes: { list: async () => [], signal: () => false },
      restartShell() {} })
    try {
      expect(composed.core.system.network).toBe(network)
      expect(await composed.core.system.info.get()).toMatchObject({ platform: 'linux', ip: '10.20.30.40' })
    } finally { await composed.dispose(); await temp.dispose() }
    expect(dispose).toHaveBeenCalledOnce()
  })
})
