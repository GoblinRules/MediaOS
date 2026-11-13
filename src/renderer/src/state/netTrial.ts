// The network trial ("Keep these settings?"): main runs it and sends its state; the dialog shows it.
// docs/design/network.md sections 2 and 4.
import { NET_RESTORE_FAILED, type IpConfig, type NetTrial, type Result } from '@shared/system-types'
import { createStore } from '../lib/store'
import { call, errorText, onEvent } from '../lib/api'
import { toast } from './toasts'

export interface TrialView {
  trial: NetTrial | null
  /** Putting the old settings back failed: main has ended the trial, but the dialog stays to offer a reset. */
  failed?: string
  /** A keep, revert or reset is running. */
  busy?: 'keep' | 'revert' | 'reset'
}

export const netTrialStore = createStore<TrialView>({ trial: null })

/** Whether the dialog shows (a trial runs, or a failed revert is waiting for the user). */
export function trialShowing(v: TrialView = netTrialStore.get()): boolean {
  return v.trial !== null || v.failed !== undefined
}

let events = 0

/** Pull the current trial and follow its changes. Returns the unsubscribe. */
export function watchNetTrial(): () => void {
  const pulledAt = events
  const off = onEvent('netTrial', ({ trial }) => {
    events += 1
    // While Put back runs, its answer decides what shows: the trial ending must not close the dialog for a moment
    // before a failure opens it again.
    netTrialStore.set((v) => (trial === null && v.busy === 'revert' ? v : { ...v, trial }))
  })
  call('network.trial').then(
    (trial) => {
      // An event that came in meanwhile is newer than this answer.
      if (events === pulledAt) netTrialStore.set((v) => ({ ...v, trial }))
    },
    () => undefined,
  )
  return off
}

let reverting: Promise<boolean> | undefined

/** Main couldn't put the old settings back: show the dialog with "Reset network". Anything else is a toast. */
function showFailure(error: string): void {
  if (error === NET_RESTORE_FAILED) netTrialStore.set({ trial: null, failed: error })
  else toast(error, 'error')
}

/** "Save and test": start a trial. True when it started. */
export async function applyIp(profileId: string, config: IpConfig): Promise<boolean> {
  const r = await result(call('network.applyIp', profileId, config))
  if (!r.ok) showFailure(r.error)
  return r.ok
}

async function result(p: Promise<Result>): Promise<Result> {
  try {
    return await p
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

/**
 * Put the old settings back if a trial runs (Put back, Back, and before Power, Recovery or a restart). True when
 * there is nothing left to undo. On failure the dialog stays with the message and a "Reset network" button.
 */
export function revertTrial(): Promise<boolean> {
  if (reverting) return reverting
  const v = netTrialStore.get()
  if (v.trial === null) return Promise.resolve(v.failed === undefined)
  // Keep is already saving, so there is nothing to undo. Main would ignore the revert, and closing the dialog here
  // would look as if the old settings were back just before "New network settings saved." shows.
  if (v.busy === 'keep') return Promise.resolve(true)
  netTrialStore.set({ ...v, busy: 'revert' })
  reverting = result(call('network.revert')).then((r) => {
    reverting = undefined
    if (r.ok) {
      netTrialStore.set({ trial: null })
      return true
    }
    netTrialStore.set({ trial: null, failed: r.error })
    return false
  })
  return reverting
}

/** Keep the new settings. Main shows the "saved" toast; a refusal is shown here. */
export async function keepTrial(): Promise<void> {
  const v = netTrialStore.get()
  if (v.trial === null || v.busy) return
  netTrialStore.set({ ...v, busy: 'keep' })
  const r = await result(call('network.keep'))
  netTrialStore.set((now) => ({ ...now, busy: undefined }))
  if (!r.ok) showFailure(r.error)
}

export const RESET_DONE = 'Network set back to automatic. It can take up to a minute to reconnect.'

/** Every connection back to Automatic (the way out when the old settings couldn't be put back). */
export async function resetNetwork(): Promise<boolean> {
  if (netTrialStore.get().busy === 'reset') return false
  netTrialStore.set((v) => ({ ...v, busy: 'reset' }))
  const r = await result(call('network.resetAll', 'AUTOMATIC'))
  if (r.ok) {
    netTrialStore.set({ trial: null })
    toast(RESET_DONE, 'ok')
    return true
  }
  netTrialStore.set((v) => ({ ...v, busy: undefined }))
  toast(r.error, 'error')
  return false
}
