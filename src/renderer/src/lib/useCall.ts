// Load data from core for a screen. Re-runs when the arguments change, when reload() is called, and when
// library data changes anywhere (dataVersion). The last good answer for the same call is shown meanwhile, so
// going Back or refreshing never flashes an empty screen.
import { useCallback, useEffect, useState } from 'react'
import type { CallArgs, CallName, CallResults } from '@shared/ipc-contract'
import { call, errorText } from './api'
import { createStore, useStore } from './store'

/** Bumped whenever library data may have changed (watched state, sign-in, homeChanged event). */
export const dataVersion = createStore(0)

export function invalidateData(): void {
  dataVersion.set((v) => v + 1)
}

const cache = new Map<string, { seq: number; value: unknown }>()
const CACHE_MAX = 60
let requests = 0

/** Keep an answer unless a later request for the same call has already been remembered (replies can overtake). */
function remember(key: string, seq: number, value: unknown): void {
  const had = cache.get(key)
  if (had && had.seq > seq) return
  cache.delete(key)
  cache.set(key, { seq, value })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export interface CallState<T> {
  data: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
}

interface Loaded<T> {
  run: string
  data?: T
  error?: string
}

export function useCall<N extends CallName>(name: N, args: CallArgs<N>, enabled = true): CallState<CallResults[N]> {
  const key = JSON.stringify([name, args])
  const version = useStore(dataVersion)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<Loaded<CallResults[N]>>()
  const runId = `${key}#${version}#${nonce}`

  useEffect(() => {
    if (!enabled) return
    let live = true
    const [n, a] = JSON.parse(key) as [N, CallArgs<N>]
    const seq = ++requests
    call(n, ...a).then(
      (data) => {
        remember(key, seq, data)
        if (live) setState({ run: runId, data })
      },
      (err: unknown) => {
        if (live) setState({ run: runId, error: errorText(err) })
      },
    )
    return () => {
      live = false
    }
  }, [key, runId, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const done = state?.run === runId
  const cached = cache.get(key)?.value as CallResults[N] | undefined
  return {
    data: done && state.data !== undefined ? state.data : cached,
    error: done ? state.error : undefined,
    loading: enabled && !done,
    reload,
  }
}
