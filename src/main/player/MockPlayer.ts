import type { PlayerCommand } from '@shared/player-types'
import type { PlaybackPlan } from '../sources/MediaSource'
import { PlayerBase, type PlayerOptions } from './PlayerBase'

export interface MockPlayerOptions extends PlayerOptions { loadingMs?: number; tickMs?: number }

export class MockPlayer extends PlayerBase {
  private loadingTimer?: ReturnType<typeof setTimeout>
  private tickTimer?: ReturnType<typeof setInterval>
  private lastTick = 0

  constructor(private mockOpts: MockPlayerOptions = {}) { super('mock', mockOpts) }
  protected async load(plan: PlaybackPlan): Promise<void> {
    this.value.audioTracks = structuredClone(plan.tracks?.audio ?? [
      { index: 1, label: 'English · Surround', selected: true },
      { index: 2, label: 'English · Audio description', selected: false },
    ])
    this.value.subtitleTracks = structuredClone(plan.tracks?.subtitles ?? [
      { index: 1, label: 'English', selected: false }, { index: 2, label: 'English (SDH)', selected: false },
    ])
    if (plan.selection?.audio !== undefined) {
      this.value.audioTracks.forEach((t) => { t.selected = t.index === plan.selection!.audio })
    }
    if (plan.selection?.subtitle !== undefined) {
      this.value.subtitleTracks.forEach((t) => { t.selected = t.index === plan.selection!.subtitle })
    }
    this.loadingTimer = this.clock.setTimeout(() => {
      this.loadingTimer = undefined
      this.lastTick = this.clock.now()
      this.status('playing')
      this.tickTimer = this.clock.setInterval(() => this.tick(), this.mockOpts.tickMs ?? 250)
    }, this.mockOpts.loadingMs ?? 300)
  }
  private tick(checkEnd = true): void {
    const now = this.clock.now()
    if (this.value.status === 'playing') {
      const end = this.value.durationSec === undefined ? Infinity : this.toPlayerTime(this.value.durationSec)
      const next = this.playerPositionSec + (now - this.lastTick) / 1000
      this.position(Math.min(end, next))
      if (checkEnd && next >= end) {
        if (this.tickTimer) this.clock.clearInterval(this.tickTimer)
        this.tickTimer = undefined
        void this.ended('eof')
      }
    }
    this.lastTick = now
  }
  protected async control(cmd: PlayerCommand): Promise<void> {
    if (cmd.kind === 'togglePause' && ['playing', 'paused'].includes(this.value.status)) {
      this.tick()
      this.status(this.value.status === 'playing' ? 'paused' : 'playing')
    }
    if (cmd.kind === 'seekTo' || cmd.kind === 'seekRelative') {
      const target = this.toPlayerTime(cmd.kind === 'seekTo' ? cmd.seconds : this.value.positionSec + cmd.seconds)
      const end = this.value.durationSec === undefined ? Infinity : this.toPlayerTime(this.value.durationSec)
      this.position(Math.min(end, target))
      this.lastTick = this.clock.now()
    }
    if (cmd.kind === 'setAudio') this.value.audioTracks.forEach((t) => { t.selected = t.index === cmd.index })
    if (cmd.kind === 'setSubtitle') this.value.subtitleTracks.forEach((t) => { t.selected = t.index === cmd.index })
    this.emit()
  }
  protected async halt(): Promise<void> {
    this.tick(false)
    if (this.loadingTimer) this.clock.clearTimeout(this.loadingTimer)
    if (this.tickTimer) this.clock.clearInterval(this.tickTimer)
    this.loadingTimer = undefined
    this.tickTimer = undefined
  }
}
