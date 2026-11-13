import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLinuxCec, type CecFs } from '../../src/main/system/linux/LinuxCec'
import { cecAdapterName, parseCecAdapters, parseCecInfo, parseTvPower } from '../../src/main/system/linux/cec-parse'
import { runtime } from '../../src/main/core/runtime'
import type { CommandResult, CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { deferred } from './helpers'

const listing = 'vivid (vivid-000-vid-cap0):\n\t/dev/cec0\n\nvivid (vivid-000-vid-out0):\n\t/dev/cec1\n'
const sample = `Driver Info:
  Driver Name                : vivid
  Adapter Name               : vivid-000-vid-out0
  Capabilities               : 0x000002be
    Logical Addresses
    Transmit
  Driver version             : 6.12.116
  Available Logical Addresses: 4
  Connector Info             : None
  Physical Address           : 1.0.0.0
  Logical Address Mask       : 0x0010
  CEC Version                : 2.0
  Vendor ID                  : 0x000c03 (HDMI)
  OSD Name                   : 'MediaOS'
  Logical Addresses          : 1 (Allow RC Passthrough)

    Logical Address          : 4 (Playback Device 1)
      Primary Device Type    : Playback
      Logical Address Type   : Playback
      All Device Types       : Playback
`
const unconfigured = sample.slice(0, sample.indexOf('\n    Logical Address          :')).replace('1 (Allow RC Passthrough)', '0')
const tx = 'Sequence: 7 Tx Timestamp: 123.456s\n'
const reply = (stdout = '', code = 0): CommandResult => ({ code, stdout, stderr: code ? 'failure' : '' })
class FakeRunner implements CommandRunner {
  calls: { file: string; args: readonly string[]; timeoutMs: number }[] = []
  listing = listing
  infos = new Map([['/dev/cec0', sample.replace('Primary Device Type    : Playback', 'Primary Device Type    : TV')],
    ['/dev/cec1', sample]])
  power = 'on'
  message = tx
  override?: (args: readonly string[]) => CommandResult | Promise<CommandResult> | undefined
  async run(file: string, args: readonly string[], opts: { timeoutMs: number }) {
    this.calls.push({ file, args, ...opts })
    const custom = await this.override?.(args)
    if (custom) return custom
    if (args[0] === '-A') return reply(this.listing)
    const dev = args[1]!
    if (args.length === 2) return reply(this.infos.get(dev) ?? '')
    if (args.includes('--playback') || args.includes('--phys-addr') || args.includes('-e')) {
      this.infos.set(dev, sample); return reply()
    }
    if (args.includes('--give-osd-name')) return reply('SET_OSD_NAME (0x47):\n\tname: Living TV\n')
    if (args.includes('--give-device-power-status')) return reply(`REPORT_POWER_STATUS (0x90):\n\tpwr-state: ${this.power} (0x00)\n`)
    return reply(this.message)
  }
  spawnLines(): { kill(): void } { throw new Error('CEC never spawns a monitor') }
}
const services: ReturnType<typeof createLinuxCec>[] = []
function make() {
  const runner = new FakeRunner(), logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const io: CecFs = { readdir: vi.fn(async () => []), readFile: vi.fn(async () => 'disconnected\n'),
    stat: vi.fn(async () => ({ size: 0 })) }
  const cec = createLinuxCec({ runner, logger, timers: runtime, fs: io }); services.push(cec)
  return { runner, logger, io, cec }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const cec of services.splice(0)) cec.dispose(); vi.useRealTimers() })

describe('CEC text parsing', () => {
  it('parses real adapter listings and driver information', () => {
    expect(parseCecAdapters(listing)).toEqual(['/dev/cec0', '/dev/cec1'])
    expect(parseCecAdapters('/dev/cec0\n/dev/cec0\n/dev/cecX\n/dev/cec1 unsafe')).toEqual(['/dev/cec0'])
    expect(parseCecInfo('/dev/cec1', sample)).toEqual({ path: '/dev/cec1', driver: 'vivid', name: 'vivid-000-vid-out0',
      capabilities: 0x2be, physicalAddress: '1.0.0.0', logicalAddress: 4, primaryType: 'Playback', osdName: 'MediaOS' })
    const empty = parseCecInfo('/dev/cec1', unconfigured)
    expect(empty).toBeDefined(); expect(empty?.logicalAddress).toBeUndefined(); expect(empty?.primaryType).toBeUndefined()
    expect(parseCecInfo('/dev/cec1', sample.replace('4 (Playback Device 1)', 'Not Allocated'))?.logicalAddress).toBeUndefined()
    expect(parseCecInfo('/dev/cec1', 'bad')).toBeUndefined()
    expect(cecAdapterName('pulse8-cec')).toBe('Pulse-Eight USB-CEC')
    expect(cecAdapterName('rainshadow-cec')).toBe('RainShadow HDMI-CEC')
    expect(cecAdapterName('vivid')).toBe('HDMI-CEC adapter')
  })
  it.each([['on', 'on'], ['to-on', 'on'], ['standby', 'standby'], ['to-standby', 'standby'], ['other', 'unknown']])(
    'maps power %s', (input, expected) => {
      expect(parseTvPower(`REPORT_POWER_STATUS (0x90):\n\tpwr-state: ${input} (0x00)`)).toBe(expected)
    })
})

describe('Linux CEC', () => {
  it.each([['on', 'on'], ['to-on', 'on'], ['standby', 'standby'], ['to-standby', 'standby']])(
    'skips the TV adapter and reads name and power %s', async (power, expected) => {
      const { cec, runner } = make(); runner.power = power
      expect(await cec.status()).toEqual({ adapter: true, adapterName: 'HDMI-CEC adapter', tvName: 'Living TV',
        tvPower: expected, physicalAddress: '1.0.0.0' })
      expect(runner.calls.map((call) => call.args)).toEqual([
        ['-A'], ['-d', '/dev/cec0'], ['-d', '/dev/cec1'],
        ['-d', '/dev/cec1', '-s', '--to', '0', '--give-osd-name'],
        ['-d', '/dev/cec1', '-s', '--to', '0', '--give-device-power-status'],
      ])
      expect(runner.calls.every((call) => call.file === 'cec-ctl' && call.timeoutMs === 5000)).toBe(true)
    })
  it.each(['FEATURE_ABORT (0x00):\n\treason: unrecognized-op', tx, 'Tx, Not Acknowledged', 'Tx, Aborted'])(
    'treats no power reply or feature abort as unknown: %s', async (output) => {
      const { cec, runner } = make()
      runner.override = (args) => args.includes('--give-device-power-status') ? reply(output) : undefined
      expect(await cec.status()).toMatchObject({ tvPower: 'unknown' })
    })
  it.each(['missing', 'empty', 'bad-info', 'throw', 'timeout'])('handles unavailable adapter state: %s', async (mode) => {
    const { cec, runner } = make()
    if (mode === 'missing') runner.override = () => ({ fail: 'notFound' })
    if (mode === 'timeout') runner.override = () => ({ fail: 'timeout' })
    if (mode === 'empty') runner.listing = 'no adapters'
    if (mode === 'bad-info') runner.infos.clear()
    if (mode === 'throw') runner.override = () => { throw new Error('runner') }
    expect(await cec.status()).toEqual({ adapter: false })
    expect(await cec.wakeTv()).toEqual({ ok: false, error: 'No TV remote adapter is connected.' })
    expect(await cec.standbyTv()).toEqual({ ok: false, error: 'No TV remote adapter is connected.' })
    expect(await cec.setActiveSource()).toEqual({ ok: true })
  })
  it('configures an unconfigured adapter once, and prefers one with a physical address', async () => {
    const { cec, runner } = make()
    runner.infos.set('/dev/cec0', sample.replace('1.0.0.0', 'f.f.f.f'))
    runner.infos.set('/dev/cec1', unconfigured)
    await cec.status(); await cec.status()
    expect(runner.calls.filter((call) => call.args.includes('--playback')).map((call) => call.args))
      .toEqual([['-d', '/dev/cec1', '--playback', '-o', 'MediaOS']])
  })
  it('keeps the adapter it found when reading it back after configuring fails', async () => {
    const { cec, runner } = make()
    runner.listing = '\t/dev/cec1\n'; runner.infos.set('/dev/cec1', unconfigured)
    let reads = 0
    runner.override = (args) => args.length === 2 && args[0] === '-d' && ++reads === 2 ? reply('', 1) : undefined
    expect((await cec.status()).adapter).toBeTruthy()
    expect(reads).toBeGreaterThanOrEqual(2)
  })
  it.each([true, false])('sets Pulse-Eight physical address using EDID when available (%s)', async (connected) => {
    const { cec, runner, io, logger } = make()
    runner.listing = '\t/dev/cec1\n'
    runner.infos.set('/dev/cec1', unconfigured.replace('0x000002be', '0x000002bf').replace('1.0.0.0', 'f.f.f.f'))
    vi.mocked(io.readdir).mockResolvedValue(['card0-DP-1', 'card0-HDMI-A-1', 'card0-HDMI-A-2'])
    vi.mocked(io.readFile).mockResolvedValue(connected ? 'connected\n' : 'disconnected\n')
    vi.mocked(io.stat).mockResolvedValue({ size: 256 })
    await cec.status()
    expect(runner.calls.find((call) => call.args.includes('--playback'))?.args).toEqual([
      '-d', '/dev/cec1', '--playback', '-o', 'MediaOS',
      ...(connected ? ['-e', '/sys/class/drm/card0-HDMI-A-1/edid'] : ['--phys-addr', '1.0.0.0']),
    ])
    if (connected) {
      expect(io.readFile).toHaveBeenCalledWith('/sys/class/drm/card0-HDMI-A-1/status', 'utf8')
      expect(io.stat).toHaveBeenCalledWith('/sys/class/drm/card0-HDMI-A-1/edid')
    } else expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('guessed'))
  })
  it('guesses when EDID is empty or unreadable, including already configured Playback adapters', async () => {
    const { cec, runner, io } = make()
    runner.listing = '/dev/cec1'
    const info = sample.replace('0x000002be', '0x000002bf').replace('1.0.0.0', 'f.f.f.f')
    runner.infos.set('/dev/cec1', info)
    vi.mocked(io.readdir).mockResolvedValue(['card0-HDMI-A-1'])
    vi.mocked(io.readFile).mockResolvedValue('connected')
    await cec.status()
    expect(runner.calls).toContainEqual({ file: 'cec-ctl', args: ['-d', '/dev/cec1', '--phys-addr', '1.0.0.0'], timeoutMs: 5000 })
    runner.infos.set('/dev/cec1', info); vi.mocked(io.stat).mockRejectedValueOnce(new Error('missing'))
    await cec.status()
    expect(runner.calls.filter((call) => call.args.includes('--phys-addr'))).toHaveLength(2)
  })
  it('refreshes at creation and every 30 seconds, discovers hotplug and stops on disposal', async () => {
    const { cec, runner } = make(); runner.listing = ''
    await vi.advanceTimersByTimeAsync(0)
    expect(runner.calls.map((call) => call.args)).toEqual([['-A']])
    runner.listing = '/dev/cec1'; runner.infos.set('/dev/cec1', unconfigured)
    await vi.advanceTimersByTimeAsync(30000)
    expect(runner.calls.some((call) => call.args.includes('--playback'))).toBe(true)
    expect(runner.calls.some((call) => call.args.includes('--to'))).toBe(false)
    cec.dispose(); const count = runner.calls.length
    await vi.advanceTimersByTimeAsync(60000); expect(runner.calls).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('wakes and makes MediaOS active, sends standby, and broadcasts active source with exact argv', async () => {
    const { cec, runner } = make()
    expect(await cec.wakeTv()).toEqual({ ok: true })
    expect(await cec.standbyTv()).toEqual({ ok: true })
    expect(await cec.setActiveSource()).toEqual({ ok: true })
    expect(runner.calls.filter((call) => call.args.includes('-s')).map((call) => call.args)).toEqual([
      ['-d', '/dev/cec1', '-s', '--to', '0', '--image-view-on'],
      ['-d', '/dev/cec1', '-s', '--active-source', 'phys-addr=1.0.0.0'],
      ['-d', '/dev/cec1', '-s', '--to', '0', '--standby'],
      ['-d', '/dev/cec1', '-s', '--active-source', 'phys-addr=1.0.0.0'],
    ])
  })
  const unplugged = "The TV remote adapter can't see the TV. Check its HDMI cable goes into the TV."
  const unanswered = "The TV didn't answer. Check HDMI-CEC is switched on in the TV's settings " +
    '(it may be called Anynet+, Bravia Sync or SimpLink).'
  it.each([['Tx, Not Acknowledged', unanswered], ['Tx, Aborted', unplugged], ['', unanswered]])(
    'checks text despite zero exit status: %s', async (output, error) => {
      const { cec, runner } = make(); runner.message = output
      expect(await cec.wakeTv()).toEqual({ ok: false, error })
      expect(await cec.standbyTv()).toEqual({ ok: false, error })
      expect(await cec.setActiveSource()).toEqual({ ok: false, error })
    })
  it('does not ask the TV without a physical address and reports its cable', async () => {
    const { cec, runner } = make(); runner.infos.set('/dev/cec1', sample.replace('1.0.0.0', 'f.f.f.f'))
    expect(await cec.status()).toEqual({ adapter: true, adapterName: 'HDMI-CEC adapter', tvPower: 'unknown' })
    expect(await cec.wakeTv()).toEqual({ ok: false, error: unplugged })
    expect(await cec.standbyTv()).toEqual({ ok: false, error: unplugged })
    expect(await cec.setActiveSource()).toEqual({ ok: false, error: unplugged })
    expect(runner.calls.every((call) => !call.args.includes('-s'))).toBe(true)
  })
  it('logs active-source failure without failing wake', async () => {
    const { cec, runner, logger } = make()
    runner.override = (args) => args.includes('--active-source') ? reply('Tx, Aborted') : undefined
    expect(await cec.wakeTv()).toEqual({ ok: true })
    expect(logger.warn).toHaveBeenCalledWith('TV active source could not be set', unplugged)
  })
  it.each([{ fail: 'timeout' }, { fail: 'notFound' }, reply('', 1)] as CommandResult[])(
    'contains transmit command failures: %j', async (failure) => {
      const { cec, runner, logger } = make()
      runner.override = (args) => args.includes('-s') ? failure : undefined
      expect(await cec.wakeTv()).toEqual({ ok: false, error: unanswered })
      expect(await cec.standbyTv()).toEqual({ ok: false, error: unanswered })
      expect(await cec.setActiveSource()).toEqual({ ok: false, error: unanswered })
      expect(logger.warn).toHaveBeenCalled()
    })
  it('serialises all calls and skips the refresh while work is queued', async () => {
    const { cec, runner } = make(), gate = deferred<CommandResult>()
    let inFlight = 0, maximum = 0, first = true
    const run = runner.run.bind(runner)
    vi.spyOn(runner, 'run').mockImplementation(async (...args) => {
      inFlight++; maximum = Math.max(maximum, inFlight)
      try { return await run(...args) } finally { inFlight-- }
    })
    runner.override = () => { if (first) { first = false; return gate.promise } }
    const status = cec.status(), wake = cec.wakeTv(), standby = cec.standbyTv(), active = cec.setActiveSource()
    await vi.advanceTimersByTimeAsync(30000)
    expect(runner.calls).toHaveLength(1)
    gate.resolve(reply(listing)); await Promise.all([status, wake, standby, active])
    expect(maximum).toBe(1)
    expect(runner.calls.filter((call) => call.args[0] === '-A')).toHaveLength(4)
  })
})
