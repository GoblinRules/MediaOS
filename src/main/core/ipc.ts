import { CALLS, type CallName, type CallReply } from '@shared/ipc-contract'
import { SourceError } from '../sources/MediaSource'
import { UserFacingError } from '../system/net/texts'
import type { Core } from './Core'

export async function handleCall(core: Core, name: unknown, args: unknown): Promise<CallReply<unknown>> {
  try {
    if (typeof name !== 'string' || !Object.hasOwn(CALLS, name)) {
      core.logger.warn('Call validation failed', { call: '(unknown)', issues: [{ path: [], code: 'unknown_call' }] })
      return { ok: false, error: genericError }
    }
    const call = name as CallName
    const parsed = CALLS[call].safeParse(args)
    if (!parsed.success) {
      core.logger.warn('Call validation failed', { call,
        issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) })
      return { ok: false, error: genericError }
    }
    return { ok: true, value: await core.dispatch(call, parsed.data) }
  } catch (error) {
    // Both carry plain-English text written for the screen; anything else stays in the log.
    if (error instanceof SourceError || error instanceof UserFacingError) return { ok: false, error: error.message }
    core.logger.error('Unexpected IPC error', error)
    return { ok: false, error: genericError }
  }
}

const genericError = 'Something went wrong. Try again, or restart MediaOS from Settings.'
