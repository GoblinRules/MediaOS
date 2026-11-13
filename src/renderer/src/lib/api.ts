// Thin typed wrappers over window.mediaos (the preload bridge).
import type { CallArgs, CallName, CallResults, EventName, EventPayloads } from '@shared/ipc-contract'
import type { Result } from '@shared/system-types'
import { toast } from '../state/toasts'

export const GENERIC_ERROR = 'Something went wrong. Try again, or restart MediaOS from Settings.'

export function call<N extends CallName>(name: N, ...args: CallArgs<N>): Promise<CallResults[N]> {
  return window.mediaos.call(name, ...args)
}

export function onEvent<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void): () => void {
  return window.mediaos.on(event, cb)
}

/** Plain-English text for an error thrown by a call. */
export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  }
  return GENERIC_ERROR
}

type ResultCall = { [N in CallName]: CallResults[N] extends Result ? N : never }[CallName]

/** Run a call that returns a Result. Shows a toast on failure; returns true when it worked. */
export async function run<N extends ResultCall>(name: N, ...args: CallArgs<N>): Promise<boolean> {
  try {
    const r = (await call(name, ...args)) as Result
    if (!r.ok) {
      toast(r.error, 'error')
      return false
    }
    return true
  } catch (err) {
    toast(errorText(err), 'error')
    return false
  }
}

/** Run any call; on failure show a toast and return undefined. */
export async function tryCall<N extends CallName>(name: N, ...args: CallArgs<N>): Promise<CallResults[N] | undefined> {
  try {
    return await call(name, ...args)
  } catch (err) {
    toast(errorText(err), 'error')
    return undefined
  }
}
