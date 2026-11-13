import type { PlayerCommand, PlayerState } from '@shared/player-types'
import type { PlaybackPlan, MediaSource } from '../sources/MediaSource'

export interface PlayerController {
  /** Start a session (replacing any current one). Resolves once loading has begun or failed. */
  play(plan: PlaybackPlan, source: MediaSource): Promise<void>
  command(cmd: PlayerCommand): Promise<void>
  state(): PlayerState
  /** Fires on every state change (throttled to <= 4/s for position updates). */
  onState(cb: (s: PlayerState) => void): () => void
  /** Stop playback, report the final position, close mpv. */
  stop(): Promise<void>
  dispose(): Promise<void>
}
