// Player and foreground state, pushed from core by events.
import type { Foreground } from '@shared/ipc-contract'
import type { PlayerState } from '@shared/player-types'
import { createStore } from '../lib/store'

export const IDLE_PLAYER: PlayerState = { status: 'idle', positionSec: 0, backend: 'mock', audioTracks: [], subtitleTracks: [] }

export const playerStore = createStore<PlayerState>(IDLE_PLAYER)
export const foregroundStore = createStore<Foreground>({ kind: 'shell' })

/** True while something is playing (or loading, or showing a playback error). */
export function playerActive(s: PlayerState = playerStore.get()): boolean {
  switch (s.status) {
    case 'loading':
    case 'playing':
    case 'paused':
    case 'buffering':
      return true
    case 'error':
      return Boolean(s.item)
    default:
      return false
  }
}

export function appRunning(): string | undefined {
  const f = foregroundStore.get()
  return f.kind === 'app' ? f.appId : undefined
}
