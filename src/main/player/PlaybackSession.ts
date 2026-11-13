import type { MediaItem } from '@shared/media-types'
import type { MediaSource, PlaybackPlan, ReportEvent } from '../sources/MediaSource'
import { silentLog, type Log } from '../log/Logger'
import { runtime, type Runtime } from '../core/runtime'

export interface SessionOptions {
  clock?: Runtime
  logger?: Log
  autoPlayNext?: () => boolean
  load: (plan: PlaybackPlan) => Promise<void>
  upNext: (item: MediaItem | undefined) => void
  playNext: (item: MediaItem) => Promise<void>
}

export class PlaybackSession {
  private started = false
  private stopped = false
  private fallbackUsed = false
  private cancelled = false
  private position: number
  private duration?: number
  private timer?: ReturnType<typeof setInterval>
  private reports: Promise<void> = Promise.resolve()
  private clock: Runtime
  private nextShown = false
  private nextStarted = false

  constructor(public plan: PlaybackPlan, private source: MediaSource, private opts: SessionOptions) {
    this.clock = opts.clock ?? runtime
    this.position = this.mediaPosition(plan.startSec)
    this.duration = plan.durationSec
  }

  playing(): void {
    if (this.stopped) return
    if (!this.started) { this.started = true; this.report('start') }
    if (!this.timer) this.timer = this.clock.setInterval(() => this.report('progress'), 10_000)
  }
  paused(): void {
    if (this.stopped) return
    this.clearTimer()
    if (this.started) this.report('paused')
  }
  update(position: number, duration?: number): void {
    if (Number.isFinite(position)) this.position = this.mediaPosition(position)
    if (duration !== undefined && Number.isFinite(duration)) {
      // Offset streams can report only their remaining duration. Prefer the source's full media duration.
      this.duration = this.plan.timeBaseSec ? this.plan.durationSec ?? this.mediaPosition(duration) : duration
    }
    if (!this.cancelled && !this.nextShown && this.plan.next && this.duration && this.position >= this.duration - 10) {
      this.nextShown = true
      this.opts.upNext(this.plan.next)
    }
  }
  cancelUpNext(): void { this.cancelled = true; this.opts.upNext(undefined) }
  async playNext(): Promise<void> {
    if (!this.plan.next || this.nextStarted) return
    this.nextStarted = true
    await this.stop()
    await this.opts.playNext(this.plan.next)
  }
  async end(reason: string, load = this.opts.load): Promise<'fallback' | 'ended' | 'next'> {
    if (this.stopped) return this.nextStarted ? 'next' : 'ended'
    if (reason === 'error' && !this.started && !this.fallbackUsed && this.plan.method === 'direct' && this.plan.fallback) {
      this.fallbackUsed = true
      this.plan = await this.plan.fallback()
      if (this.stopped) return 'ended'
      this.position = this.mediaPosition(this.plan.startSec)
      this.duration = this.plan.durationSec
      await load(this.plan)
      return 'fallback'
    }
    if (reason === 'eof' && this.plan.next && !this.cancelled) {
      this.opts.upNext(this.plan.next)
      if (this.opts.autoPlayNext?.()) { await this.playNext(); return 'next' }
    }
    await this.stop()
    return 'ended'
  }
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.clearTimer()
      this.report('stopped')
    }
    await this.reports
  }
  private report(state: ReportEvent['state']): void {
    const event = { state, positionSec: this.position }
    const handle = this.plan.report
    this.reports = this.reports.then(() => this.source.report(handle, event)).catch((error: unknown) => {
      ;(this.opts.logger ?? silentLog).warn('Playback progress could not be saved', error)
    })
  }
  private mediaPosition(playerPosition: number): number {
    return (this.plan.timeBaseSec ?? 0) + Math.max(0, playerPosition)
  }
  private clearTimer(): void {
    if (this.timer) this.clock.clearInterval(this.timer)
    this.timer = undefined
  }
  async dispose(): Promise<void> { await this.stop() }
}
