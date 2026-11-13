// The TV picture MediaOS switched off (Power menu or the screen-off timer). The next button press or mouse move
// switches it back on; core does the same for keys it routes itself.
import { call, errorText } from '../lib/api'
import { toast } from './toasts'

let off = false
let offAt = 0

/** True for a moment after MediaOS switched the screen off, while the pointer settles. */
export function screenJustTurnedOff(): boolean {
  return off && Date.now() - offAt < 2000
}

export async function turnScreenOff(opts: { quiet?: boolean } = {}): Promise<void> {
  try {
    const result = await call('power.screenOff')
    if (!result.ok && !opts.quiet) toast(result.error, 'error')
  } catch (err) {
    if (!opts.quiet) toast(errorText(err), 'error')
  }
  // Core may think the screen is off even when the command failed; waking it then is harmless.
  off = true
  offAt = Date.now()
}

/** Cheap to call on every press: it only talks to core after MediaOS switched the screen off. True when it did. */
export function wakeScreen(): boolean {
  if (!off) return false
  off = false
  void call('power.screenOn').then((result) => { if (!result.ok) off = true }, () => { off = true })
  return true
}
