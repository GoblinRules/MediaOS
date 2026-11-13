import type { MediaItem } from './media-types'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

export interface PlayerState {
  status: PlayerStatus
  item?: MediaItem
  positionSec: number
  durationSec?: number
  method?: 'direct' | 'transcode'
  /** 'mpv' = real mpv window; 'mock' = the shell draws a stand-in player (dev on Windows without mpv). */
  backend: 'mpv' | 'mock'
  audioTracks: { index: number; label: string; selected: boolean }[]
  subtitleTracks: { index: number; label: string; selected: boolean }[]
  /** Plain-English problem, e.g. "This server needs Plex Pass for remote streaming." */
  error?: string
  /** Shown 10 s before the end when another episode follows. */
  upNext?: MediaItem
}

export type PlayerCommand =
  | { kind: 'togglePause' }
  | { kind: 'seekRelative'; seconds: number }
  | { kind: 'seekTo'; seconds: number }
  | { kind: 'stop' }
  | { kind: 'setAudio'; index: number }
  | { kind: 'setSubtitle'; index: number | null }
  | { kind: 'playNext' }
  | { kind: 'cancelUpNext' }
