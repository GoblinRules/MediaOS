import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Result, SysInfo } from '@shared/system-types'
import type { SystemServices } from '../SystemServices'
import { collectDiagnostics, type DiagnosticsIo } from '../diagnostics'
import { silentLog, type Log } from '../../log/Logger'
import { UserFacingError } from '../net/texts'
import { NodeCommandRunner, type CommandRunner } from './CommandRunner'
import { createLinuxBluetooth } from './LinuxBluetooth'
import { createLinuxFolders } from './LinuxFolders'
import { createLinuxCec, type CecFs } from './LinuxCec'
import { createLinuxUpdates, type UpdateFs } from './LinuxUpdates'
import type { Runtime } from '../../core/runtime'
import { fallbackZones, parseAudioOutputs, parseDisplayOutputs, parseOsRelease, parseTime, parseVolume,
  parseZones, safeOutputName, testToneWav } from './system-parse'

export interface LinuxSystemOptions {
  appVersion: string
  deviceName(): string
  runner?: CommandRunner
  logger?: Log
  logDir?: string
  clock?: { now(): number }
  timers?: Runtime
  fetch?: typeof fetch
  fs?: DiagnosticsIo & Partial<Pick<CecFs, 'stat'> & Pick<UpdateFs, 'access'>> & {
    statfs(path: string): Promise<{ blocks: number; bsize: number; bavail: number }>
  }
  os?: {
    release(): string; cpus(): readonly { model: string }[]; totalmem(): number; uptime(): number; tmpdir(): string
  }
}
export type LinuxSystem = Omit<SystemServices, 'network'> & { dispose(): void }
const ok: Result = { ok: true }
const fail = (error: string): Result => ({ ok: false, error })

export function createLinuxSystem(opts: LinuxSystemOptions): LinuxSystem {
  const logger = opts.logger ?? silentLog
  const runner = opts.runner ?? new NodeCommandRunner(logger)
  const io = opts.fs ?? fs, facts = opts.os ?? os, clock = opts.clock ?? { now: Date.now }
  let disposed = false
  let channels = 'stereo'
  let cachedZones: string[] | undefined
  const run = async (file: string, args: readonly string[], timeoutMs = 4000): Promise<string | undefined> => {
    if (disposed) return undefined
    try {
      const result = await runner.run(file, args, { timeoutMs })
      if ('code' in result && result.code === 0) return result.stdout
      logger.warn('System command failed', file, result)
    } catch (error) { logger.warn('System command failed', file, error) }
    return undefined
  }
  const action = async (file: string, args: readonly string[], error: string): Promise<Result> =>
    await run(file, args) === undefined ? fail(error) : ok
  const outputs = async () => {
    const stdout = await run('pw-dump', [])
    const sinks = parseAudioOutputs(stdout ?? '')
    if (stdout !== undefined && !sinks.length) logger.debug('No sound outputs found in PipeWire response')
    return sinks
  }
  const displays = async () => {
    const stdout = await run('swaymsg', ['-t', 'get_outputs', '--raw'])
    const found = parseDisplayOutputs(stdout ?? '')
    if (stdout !== undefined && !found.length) logger.debug('No screens found in sway response')
    return found
  }
  const swayAction = async (args: string[], error: string): Promise<Result> => {
    const stdout = await run('swaymsg', args)
    if (stdout === undefined) return fail(error)
    // Some sway versions report a rejected command in JSON even with a zero exit code.
    try {
      const reply: unknown = JSON.parse(stdout)
      if (Array.isArray(reply) && reply.some((entry: unknown) =>
        entry !== null && typeof entry === 'object' && 'success' in entry && entry.success === false)) {
        logger.warn('Screen command was rejected', stdout)
        return fail(error)
      }
    } catch { /* Exit status remains authoritative when sway does not return JSON. */ }
    return ok
  }
  const zones = async (): Promise<string[]> => {
    if (cachedZones) return [...cachedZones]
    const stdout = await run('timedatectl', ['list-timezones'], 10000)
    const found = parseZones(stdout ?? '')
    if (found.length) { cachedZones = found; return [...found] }
    if (stdout !== undefined) logger.warn('Time zone list could not be read', stdout)
    return [...fallbackZones]
  }
  const bluetooth = createLinuxBluetooth({ runner, logger, timers: opts.timers })
  const updates = createLinuxUpdates({ runner, logger, appVersion: opts.appVersion, clock, fetch: opts.fetch,
    fs: { readFile: (path, encoding) => io.readFile(path, encoding),
      access: (path) => io.access ? io.access(path) : Promise.reject(new Error('Update source access is unavailable')) } })
  const cec = createLinuxCec({ runner, logger, timers: opts.timers,
    fs: { readdir: (path) => io.readdir(path), readFile: (path, encoding) => io.readFile(path, encoding),
      stat: (path) => io.stat ? io.stat(path) : Promise.reject(new Error('EDID file sizes are unavailable')) } })
  const folders = createLinuxFolders({ runner, logger, timers: opts.timers, fetch: opts.fetch })
  const system: LinuxSystem = {
    folders,
    audio: {
      outputs,
      setOutput: async (id) => {
        if (!(await outputs()).some((sink) => sink.id === id)) {
          return fail("That sound output isn't connected. Choose another output.")
        }
        return action('wpctl', ['set-default', id], "The sound output couldn't be changed. Choose another output or try again.")
      },
      volume: async () => {
        const stdout = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
        const volume = parseVolume(stdout ?? '')
        if (volume !== undefined) return volume
        logger.warn('Sound volume could not be read', stdout)
        throw new UserFacingError("The sound volume couldn't be read. Check a sound output is connected and try again.")
      },
      setVolume: async (pct) => {
        if (!Number.isFinite(pct)) return fail("That volume isn't available. Choose a volume from 0 to 100.")
        return action('wpctl', ['set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@',
          (Math.max(0, Math.min(100, pct)) / 100).toFixed(2)], "The sound volume couldn't be changed. Try again.")
      },
      setChannels: async (layout) => { channels = layout; return ok },
      testTone: async () => {
        const error = "The sound check couldn't play. Check a sound output is connected and try again."
        const file = join(facts.tmpdir(), `mediaos-sound-${randomUUID()}.wav`)
        try {
          await io.writeFile(file, testToneWav(), { flag: 'wx', mode: 0o600 })
          logger.debug('Sound check requested', channels)
          return await run('pw-play', [file], 5000) === undefined ? fail(error) : ok
        } catch (cause) { logger.warn('Sound check failed', cause); return fail(error) }
        finally {
          try { await io.rm(file, { force: true }) }
          catch (cause) { logger.warn('Sound check file could not be removed', cause) }
        }
      },
    },
    display: {
      outputs: displays,
      setMode: async (output, modeId) => {
        const error = "That picture setting isn't available. Choose another setting."
        if (!safeOutputName(output)) return fail(error)
        const display = (await displays()).find((item) => item.id === output)
        const mode = display?.modes.find((item) => item.id === modeId)
        if (!mode) return fail(error)
        return swayAction(['output', output, 'mode', `${mode.width}x${mode.height}@${mode.refresh.toFixed(3)}Hz`],
          "The picture setting couldn't be changed. Choose another setting or try again.")
      },
      setScale: async (output, scale) => {
        if (!safeOutputName(output) || !Number.isFinite(scale) || scale < 0.5 || scale > 3 ||
            !(await displays()).some((item) => item.id === output)) {
          return fail("That screen size isn't available. Choose another size or screen.")
        }
        return swayAction(['output', output, 'scale', String(scale)], "The screen size couldn't be changed. Try again.")
      },
      power: (on) => swayAction(['output', '*', 'power', on ? 'on' : 'off'],
        "The screen couldn't be switched on or off. Try the TV's power button."),
    },
    bluetooth,
    cec,
    power: {
      reboot: () => action('systemctl', ['reboot'], "The box couldn't restart. Try again, or switch it off at the plug."),
      powerOff: () => action('systemctl', ['poweroff'], "The box couldn't switch off. Try again, or switch it off at the plug."),
    },
    time: {
      get: async () => {
        const stdout = await run('timedatectl', ['show'])
        const parsed = parseTime(stdout ?? '')
        return { iso: new Date(clock.now()).toISOString(),
          timezone: parsed.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, ntp: parsed.ntp }
      },
      zones,
      setTimezone: async (tz) => {
        if (!(await zones()).includes(tz)) return fail("That time zone isn't recognised. Choose one from the list.")
        return action('timedatectl', ['set-timezone', tz], "The time zone couldn't be changed. Try again.")
      },
    },
    updates,
    info: {
      get: async (): Promise<SysInfo> => {
        let distribution = 'Linux'
        try { distribution = parseOsRelease(await io.readFile('/etc/os-release', 'utf8')) }
        catch (error) { logger.warn('Linux version could not be read', error) }
        let storage = { totalGb: 0, freeGb: 0 }
        try {
          const stats = await io.statfs('/')
          const gb = (blocks: number) => Math.round(blocks * stats.bsize / 1024 ** 3 * 10) / 10
          storage = { totalGb: gb(stats.blocks), freeGb: gb(stats.bavail) }
        } catch (error) { logger.warn('Storage space could not be read', error) }
        const cpu = (facts.cpus()[0]?.model ?? '').replace(/\((?:R|TM)\)/gi, '').replace(/\s+/g, ' ').trim() || 'Unknown'
        return { deviceName: opts.deviceName(), version: opts.appVersion, os: distribution, kernel: facts.release(), cpu,
          memoryMb: Math.round(facts.totalmem() / 1048576), uptimeSec: Math.floor(facts.uptime()), platform: 'linux', storage }
      },
      collectDiagnostics: async () => {
        try {
          return await collectDiagnostics({ logDir: opts.logDir, now: () => clock.now(), info: () => system.info.get(), fs: io })
        } catch (error) {
          logger.warn('Diagnostics could not be saved', error)
          throw new UserFacingError("The log bundle couldn't be saved. Check there is space on the box and try again.", { cause: error })
        }
      },
    },
    dispose: () => { disposed = true; folders.dispose(); bluetooth.dispose(); cec.dispose(); updates.dispose() },
  }
  return system
}
