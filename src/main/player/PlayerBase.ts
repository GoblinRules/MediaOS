import type { PlayerCommand, PlayerState } from '@shared/player-types'
import type { MediaSource, PlaybackPlan } from '../sources/MediaSource'
import { SourceError } from '../sources/MediaSource'
import type { PlayerController } from './types'
import { PlaybackSession } from './PlaybackSession'
import { runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'

export interface PlayerOptions { clock?: Runtime; logger?: Log; autoPlayNext?: () => boolean }
export const playbackError = "This video couldn't be played. The file may be damaged, or in a format that can't be played here."

export abstract class PlayerBase implements PlayerController {
  protected value: PlayerState
  protected session?: PlaybackSession
  protected clock: Runtime
  protected logger: Log
  private listeners = new Set<(state: PlayerState) => void>()
  private positionTimer?: ReturnType<typeof setTimeout>
  private lastPositionEvent = -Infinity
  private operations: Promise<void> = Promise.resolve()
  protected generation = 0
  private disposed = false
  /** Media time at player position zero (a transcode started part-way through). The screen shows media time. */
  private timeBase = 0
  private raw: { position: number; duration?: number } = { position: 0 }

  constructor(backend: 'mock' | 'mpv', protected opts: PlayerOptions = {}) {
    this.clock = opts.clock ?? runtime
    this.logger = opts.logger ?? silentLog
    this.value = { backend, status: 'idle', positionSec: 0, audioTracks: [], subtitleTracks: [] }
  }
  state(): PlayerState { return structuredClone(this.value) }
  onState(cb: (state: PlayerState) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  protected emit(positionOnly = false): void {
    if (positionOnly && this.clock.now() - this.lastPositionEvent < 250) {
      if (!this.positionTimer) this.positionTimer = this.clock.setTimeout(() => {
        this.positionTimer = undefined
        this.emit()
      }, 250 - (this.clock.now() - this.lastPositionEvent))
      return
    }
    if (this.positionTimer) this.clock.clearTimeout(this.positionTimer)
    this.positionTimer = undefined
    this.lastPositionEvent = this.clock.now()
    for (const cb of this.listeners) cb(this.state())
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.operations.then(fn)
    this.operations = job.then(() => undefined, () => undefined)
    return job
  }
  play(plan: PlaybackPlan, source: MediaSource): Promise<void> {
    return this.serial(async () => { if (!this.disposed) await this.startSession(plan, source) })
  }
  private async startSession(plan: PlaybackPlan, source: MediaSource): Promise<void> {
    await this.stopSession(true)
    this.generation++
    const generation = this.generation
    const current = () => generation === this.generation && !this.disposed
    this.value = { backend: this.value.backend, status: 'loading', positionSec: 0,
      method: plan.method, item: plan.item, audioTracks: [], subtitleTracks: [] }
    this.useTimeBase(plan)
    const loadFallback = async (fallback: PlaybackPlan) => {
      if (!current()) return
      this.value.method = fallback.method
      this.useTimeBase(fallback)
      this.value.status = 'loading'
      this.emit()
      await this.load(fallback)
    }
    const session = new PlaybackSession(plan, source, {
      clock: this.clock, logger: this.logger, autoPlayNext: this.opts.autoPlayNext,
      load: (fallback) => this.serial(() => loadFallback(fallback)),
      upNext: (item) => { if (current()) { this.value.upNext = item; this.emit() } },
      playNext: async (item) => {
        try {
          const next = await source.playback(item.id, { resume: false })
          await this.serial(async () => { if (current()) await this.startSession(next, source) })
        } catch (error) {
          await this.serial(async () => {
            if (current()) {
              await this.closePlayer()
              this.value.upNext = undefined
              this.fail(error)
            }
          })
        }
      },
    })
    this.session = session
    this.emit()
    try { await this.load(plan) } catch (error) {
      let failure = error
      // Already inside serial(): the initial load failure must not enqueue behind itself.
      try { if (await session.end('error', loadFallback) === 'fallback') return } catch (fallbackError) { failure = fallbackError }
      await session.stop()
      await this.closePlayer()
      this.fail(failure)
    }
  }
  protected abstract load(plan: PlaybackPlan): Promise<void>
  protected abstract control(cmd: PlayerCommand): Promise<void>
  protected abstract halt(): Promise<void>
  private async closePlayer(): Promise<void> {
    try { await this.halt() } catch { this.logger.warn('The player could not be closed') }
  }
  protected fail(error: unknown): void {
    this.logger.error('Playback failed', error)
    this.value.status = 'error'
    this.value.error = error instanceof SourceError && error.code === 'paywall' ? error.message : playbackError
    this.emit()
  }
  private useTimeBase(plan: PlaybackPlan): void {
    this.timeBase = Math.max(0, plan.timeBaseSec ?? 0)
    this.raw = { position: Math.max(0, plan.startSec),
      duration: plan.durationSec === undefined ? undefined : Math.max(0, plan.durationSec - this.timeBase) }
    this.value.positionSec = this.timeBase + this.raw.position
    this.value.durationSec = plan.durationSec
  }
  /** The player's own position, which differs from the media time after a part-way transcode. */
  protected get playerPositionSec(): number { return this.raw.position }
  /** Turns a media time (what the screen shows and asks for) into the player's own time. */
  protected toPlayerTime(mediaSec: number): number { return Math.max(0, mediaSec - this.timeBase) }
  /** Takes the player's own position and duration; the state keeps media time for the screen. */
  protected position(position = this.raw.position, duration = this.raw.duration): void {
    this.raw = { position: Math.max(0, position), duration }
    this.value.positionSec = this.timeBase + this.raw.position
    // A part-way transcode may report the full length or only what remains, so keep the source's full duration.
    if (!this.timeBase || this.value.durationSec === undefined) {
      this.value.durationSec = duration === undefined ? undefined : this.timeBase + duration
    }
    this.session?.update(this.raw.position, duration)
    this.emit(true)
  }
  protected status(status: PlayerState['status']): void {
    if (this.value.status === status) return
    this.value.status = status
    if (status === 'playing') this.session?.playing()
    if (status === 'paused' || status === 'buffering') this.session?.paused()
    this.emit()
  }
  protected async ended(reason: string): Promise<void> {
    const session = this.session
    const generation = this.generation
    if (!session) return
    try {
      const result = await session.end(reason)
      await this.serial(async () => {
        if (generation !== this.generation || this.disposed || result !== 'ended') return
        await this.closePlayer()
        if (reason === 'error') this.fail(new Error('mpv could not load the media'))
        else this.status(reason === 'eof' ? 'ended' : 'idle')
      })
    } catch (error) {
      await this.serial(async () => {
        if (generation !== this.generation || this.disposed) return
        await session.stop()
        await this.closePlayer()
        this.fail(error)
      })
    }
  }
  /** The player itself went away (mpv crashed or its pipe broke): end the session and shut the player down. */
  protected lost(error: unknown): void {
    const session = this.session
    const generation = this.generation
    if (!session) return
    // Stopping first means a fallback or next episode that is still being fetched never starts.
    void session.stop()
    void this.serial(async () => {
      if (generation !== this.generation || this.disposed) return
      // The programme already finished and the player was closed: losing it now is not an error worth showing.
      if (this.value.status === 'ended' || this.value.status === 'idle') return
      await session.stop()
      await this.closePlayer()
      // A load that failed with the pipe has already reported the error.
      if (this.value.status !== 'error') this.fail(error)
      this.generation++
    })
  }
  async command(cmd: PlayerCommand): Promise<void> {
    if (cmd.kind === 'stop') return this.stop()
    if (cmd.kind === 'cancelUpNext') { this.session?.cancelUpNext(); return }
    if (cmd.kind === 'playNext') { await this.session?.playNext(); return }
    await this.serial(() => this.control(cmd))
  }
  stop(): Promise<void> { return this.serial(() => this.stopSession()) }
  private async stopSession(quiet = false): Promise<void> {
    this.generation++
    const session = this.session
    this.session = undefined
    await this.closePlayer()
    session?.update(this.raw.position, this.raw.duration)
    await session?.stop()
    if (this.positionTimer) this.clock.clearTimeout(this.positionTimer)
    this.positionTimer = undefined
    if (this.value.status !== 'idle') {
      this.value.status = 'idle'; this.value.upNext = undefined
      if (!quiet) this.emit()
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    try { await this.stop() } finally { this.listeners.clear() }
  }
}
