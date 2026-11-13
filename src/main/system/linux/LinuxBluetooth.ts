import type { Result } from '@shared/system-types'
import type { SystemServices } from '../SystemServices'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import type { CommandResult, CommandRunner } from './CommandRunner'
import { parseBluez, validBtAddress } from './bt-parse'

const ok: Result = { ok: true }
const fail = (error: string): Result => ({ ok: false, error })
const unavailable = "That device isn't available. Look for devices again and choose it from the list."
const busy = 'MediaOS is already adding a device. Wait a moment and try again.'
const broken = "Bluetooth isn't working on this box. Restart the box and try again."
const noAdapter = 'This box has no Bluetooth. A USB Bluetooth adapter can add it.'
function pairError(result: CommandResult): string {
  const detail = 'fail' in result ? result.fail : result.stderr
  if (/Authentication/i.test(detail)) return "The device didn't accept the pairing. Put it in pairing mode and try again. " +
    "Devices that ask for a PIN code can't be added yet."
  if (/Page Timeout|Connection Timeout|Host is down|^timeout$/i.test(detail)) {
    return "The device didn't answer. Put it in pairing mode, bring it closer and try again."
  }
  if (/In Progress|Busy/i.test(detail)) return busy
  if (/Does Not Exist|doesn't exist/i.test(detail)) return unavailable
  return "The device couldn't be added. Put it in pairing mode and try again."
}
const success = (r: CommandResult): boolean => 'code' in r && r.code === 0

export function createLinuxBluetooth(opts: { runner: CommandRunner; logger?: Log; timers?: Runtime }):
SystemServices['bluetooth'] & { dispose(): void } {
  const { runner } = opts, logger = opts.logger ?? silentLog, timers = opts.timers ?? runtime
  const listeners = new Set<() => void>()
  let disposed = false, pairing = false, lastEmit = -Infinity
  let trailing: ReturnType<typeof setTimeout> | undefined
  let scan: { process?: { kill(): void } } | undefined
  let starting: Promise<Result> | undefined
  let scanGeneration = 0
  const emit = () => {
    if (disposed) return
    lastEmit = timers.now()
    for (const cb of listeners) {
      try { cb() } catch (error) { logger.warn('Bluetooth listener failed', error) }
    }
  }
  const changed = () => {
    if (disposed) return
    const remaining = 1000 - (timers.now() - lastEmit)
    if (remaining <= 0) { emit(); return }
    trailing ??= timers.setTimeout(() => { trailing = undefined; emit() }, remaining)
  }
  const flush = () => {
    if (trailing !== undefined) timers.clearTimeout(trailing)
    trailing = undefined; emit()
  }
  const run = async (args: string[], timeoutMs = 5000): Promise<CommandResult> => {
    if (disposed) return { fail: 'notFound' }
    try {
      const result = await runner.run('busctl', args, { timeoutMs })
      if (!('code' in result) || result.code !== 0) logger.warn('Bluetooth command failed', args, result)
      return result
    } catch (error) { logger.warn('Bluetooth command failed', args, error); return { code: 1, stdout: '', stderr: '' } }
  }
  const state = async (includeUnnamed = false) => {
    const result = await run(['--json=short', 'call', 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'])
    return 'code' in result && result.code === 0 ? parseBluez(result.stdout, includeUnnamed) : undefined
  }
  const stop = () => {
    // A start still waiting on BlueZ won't open a scan any more, so a later startScan must begin afresh.
    scanGeneration++; starting = undefined
    const previous = scan; scan = undefined
    previous?.process?.kill()
    if (previous) flush()
  }
  const start = async (): Promise<Result> => {
    const generation = scanGeneration, found = await state()
    if (!found) return fail(broken)
    if (!found.adapter) return fail(noAdapter)
    if (!found.adapter.powered && !success(await run(['set-property', 'org.bluez', found.adapter.path,
      'org.bluez.Adapter1', 'Powered', 'b', 'true']))) {
      return fail("Bluetooth couldn't be switched on. Restart the box and try again.")
    }
    if (disposed || generation !== scanGeneration || scan) return ok
    const current: { process?: { kill(): void } } = {}; scan = current
    try {
      current.process = runner.spawnLines('bluetoothctl', ['--timeout', '70', 'scan', 'on'],
        () => { if (scan === current) changed() }, () => {
          if (scan === current) { scan = undefined; flush() }
        })
      if (scan !== current) current.process.kill()
      return ok
    } catch (error) { scan = undefined; logger.warn('Bluetooth discovery failed', error); flush(); return fail(broken) }
  }
  return {
    devices: async () => (await state())?.devices.map((d) => d.device) ?? [],
    startScan: () => {
      if (starting) return starting
      const current: Promise<Result> = start().finally(() => { if (starting === current) starting = undefined })
      starting = current
      return current
    },
    stopScan: async () => { stop(); return ok },
    pair: async (input) => {
      const address = input.toUpperCase()
      if (!validBtAddress(address)) return fail(unavailable)
      if (pairing) return fail(busy)
      pairing = true
      try {
        stop()
        const found = await state(true)
        if (!found) return fail(broken)
        const path = found.devices.find((d) => d.device.address === address)?.path
        if (!path) return fail(unavailable)
        const result = await run(['--timeout=60', 'call', 'org.bluez', path, 'org.bluez.Device1', 'Pair'], 65000)
        if (!success(result) && !('code' in result && /Already Exists/i.test(result.stderr))) return fail(pairError(result))
        await run(['set-property', 'org.bluez', path, 'org.bluez.Device1', 'Trusted', 'b', 'true'])
        await run(['--timeout=30', 'call', 'org.bluez', path, 'org.bluez.Device1', 'Connect'], 35000)
        return ok
      } finally { pairing = false; flush() }
    },
    remove: async (input) => {
      const address = input.toUpperCase()
      if (!validBtAddress(address)) return ok
      // Forgetting a device while one is being added would break that pairing part way.
      if (pairing) return fail(busy)
      try {
        const found = await state(true)
        if (!found) return fail("The device couldn't be forgotten. Try again.")
        const path = found.devices.find((d) => d.device.address === address)?.path
        if (!path || !found.adapter) return ok
        const result = await run(['call', 'org.bluez', found.adapter.path, 'org.bluez.Adapter1', 'RemoveDevice', 'o', path])
        if (success(result) || ('code' in result && /Does Not Exist|doesn't exist/i.test(result.stderr))) return ok
        return fail("The device couldn't be forgotten. Try again.")
      } finally { flush() }
    },
    on: (_event, cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    dispose: () => {
      disposed = true; stop()
      if (trailing !== undefined) timers.clearTimeout(trailing)
      trailing = undefined; listeners.clear()
    },
  }
}
