import * as fs from 'node:fs/promises'
import type { Result } from '@shared/system-types'
import type { SystemServices } from '../SystemServices'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import type { CommandRunner } from './CommandRunner'
import { cecAdapterName, hasPhysicalAddress, parseCecAdapters, parseCecInfo, parseTvName, parseTvPower,
  type CecAdapter } from './cec-parse'

export interface CecFs {
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  stat(path: string): Promise<{ size: number }>
}
const ok: Result = { ok: true }
const absent = 'No TV remote adapter is connected.'
const unplugged = "The TV remote adapter can't see the TV. Check its HDMI cable goes into the TV."
const unanswered = "The TV didn't answer. Check HDMI-CEC is switched on in the TV's settings " +
  '(it may be called Anynet+, Bravia Sync or SimpLink).'
const fail = (error: string): Result => ({ ok: false, error })

export function createLinuxCec(opts: { runner: CommandRunner; logger?: Log; timers?: Runtime; fs?: CecFs }):
SystemServices['cec'] & { dispose(): void } {
  const { runner } = opts, logger = opts.logger ?? silentLog, timers = opts.timers ?? runtime, io = opts.fs ?? fs
  let disposed = false, pending = 0
  let tail: Promise<unknown> = Promise.resolve()
  // Queue whole operations, so another caller cannot transmit halfway through discovery or configuration.
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    pending++
    const next = tail.then(work).finally(() => { pending-- })
    tail = next.catch(() => undefined)
    return next
  }
  const run = async (args: string[]): Promise<string | undefined> => {
    if (disposed) return undefined
    try {
      const result = await runner.run('cec-ctl', args, { timeoutMs: 5000 })
      if ('code' in result && result.code === 0) return result.stdout
      logger.warn('TV remote adapter command failed', args, result)
    } catch (error) { logger.warn('TV remote adapter command failed', args, error) }
    return undefined
  }
  const edid = async (): Promise<string | undefined> => {
    try {
      for (const entry of (await io.readdir('/sys/class/drm')).filter((name) => /^card\d+-HDMI-A-\d+$/.test(name)).sort()) {
        const base = `/sys/class/drm/${entry}`
        try {
          if ((await io.readFile(`${base}/status`, 'utf8')).trim() === 'connected' && (await io.stat(`${base}/edid`)).size > 0) {
            return `${base}/edid`
          }
        } catch (error) { logger.debug('HDMI connector could not be read', base, error) }
      }
    } catch (error) { logger.debug('HDMI connectors could not be read', error) }
    return undefined
  }
  const adapter = async (): Promise<CecAdapter | undefined> => {
    const paths = parseCecAdapters(await run(['-A']) ?? ''), found: CecAdapter[] = []
    for (const path of paths) {
      const info = parseCecInfo(path, await run(['-d', path]) ?? '')
      if (info && info.primaryType !== 'TV') found.push(info)
    }
    let chosen = found.find(hasPhysicalAddress) ?? found[0]
    if (!chosen) return undefined
    const args = ['-d', chosen.path]
    if (chosen.primaryType !== 'Playback') args.push('--playback', '-o', 'MediaOS')
    if ((chosen.capabilities & 1) && !hasPhysicalAddress(chosen)) {
      const path = await edid()
      if (path) args.push('-e', path)
      else {
        args.push('--phys-addr', '1.0.0.0')
        logger.warn('HDMI-CEC physical address guessed as 1.0.0.0; no connected HDMI EDID was available')
      }
    }
    if (args.length > 2) {
      const configured = await run(args)
      // Read the kernel's state again: a zero exit code alone does not prove that an address was claimed.
      // A failed re-read keeps the adapter already found rather than reporting none.
      chosen = parseCecInfo(chosen.path, await run(['-d', chosen.path]) ?? '') ?? chosen
      if (configured === undefined) logger.warn('TV remote adapter could not be configured')
    }
    return chosen
  }
  const transmit = async (device: CecAdapter, args: string[]): Promise<Result> => {
    const output = await run(['-d', device.path, '-s', ...args])
    if (output === undefined) return fail(unanswered)
    if (/Tx, Aborted/.test(output)) { logger.warn('CEC transmit aborted', output); return fail(unplugged) }
    if (/Tx, Not Acknowledged|FEATURE_ABORT/.test(output)) {
      logger.warn('TV did not accept the CEC command', output); return fail(unanswered)
    }
    if (!/Sequence:\s*\d+\s+Tx Timestamp:/.test(output)) {
      logger.warn('Unexpected CEC transmit response', output); return fail(unanswered)
    }
    return ok
  }
  const active = (device: CecAdapter) => transmit(device, ['--active-source', `phys-addr=${device.physicalAddress}`])
  const action = (command: '--image-view-on' | '--standby'): Promise<Result> => queue(async () => {
    const device = await adapter()
    if (!device) return fail(absent)
    if (!hasPhysicalAddress(device)) return fail(unplugged)
    const result = await transmit(device, ['--to', '0', command])
    if (result.ok && command === '--image-view-on') {
      const source = await active(device)
      if (!source.ok) logger.warn('TV active source could not be set', source.error)
    }
    return result
  })
  const refresh = () => {
    if (!disposed && !pending) void queue(async () => { await adapter() }).catch((error: unknown) => {
      logger.warn('TV remote adapter refresh failed', error)
    })
  }
  const initial = timers.setTimeout(refresh, 0)
  const interval = timers.setInterval(refresh, 30000)
  // These background checks must not keep a Node test or a closing shell alive.
  initial.unref?.(); interval.unref?.()
  return {
    status: () => queue(async () => {
      try {
        const device = await adapter()
        if (!device) return { adapter: false }
        const base = { adapter: true, adapterName: cecAdapterName(device.driver), tvPower: 'unknown' as const }
        if (!hasPhysicalAddress(device)) return base
        const tvName = parseTvName(await run(['-d', device.path, '-s', '--to', '0', '--give-osd-name']) ?? '')
        const tvPower = parseTvPower(await run(['-d', device.path, '-s', '--to', '0', '--give-device-power-status']) ?? '')
        return { ...base, ...(tvName ? { tvName } : {}), tvPower, physicalAddress: device.physicalAddress }
      } catch (error) { logger.warn('TV remote adapter status failed', error); return { adapter: false } }
    }),
    wakeTv: () => action('--image-view-on'),
    standbyTv: () => action('--standby'),
    setActiveSource: () => queue(async () => {
      const device = await adapter()
      if (!device) return ok
      return hasPhysicalAddress(device) ? active(device) : fail(unplugged)
    }),
    dispose: () => { disposed = true; timers.clearTimeout(initial); timers.clearInterval(interval) },
  }
}
