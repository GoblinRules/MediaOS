import type { PlayerCommand, PlayerState } from '@shared/player-types'
import type { PlaybackPlan } from '../sources/MediaSource'
import { PlayerBase, type PlayerOptions } from './PlayerBase'
import { MpvProcess, type MpvProcessOptions } from './mpv/MpvProcess'
import { MpvTransport, type MpvEvent } from './mpv/MpvTransport'

export interface MpvControllerOptions extends PlayerOptions {
  process?: MpvProcess
  processOptions?: MpvProcessOptions
  transport?: MpvTransport
  /**
   * Remote keys pressed while mpv has the keyboard (Linux: mpv's input.conf sends `script-message mediaos-key <action>`).
   * Only the playback keys below are passed on; anything else in the message is ignored.
   */
  onKey?: (action: MpvKey) => void
}

export const MPV_KEYS = ['back', 'home', 'stop', 'playPause', 'rewind', 'fastForward'] as const
export type MpvKey = (typeof MPV_KEYS)[number]

export function mpvKey(event: MpvEvent): MpvKey | undefined {
  if (event.event !== 'client-message' || !Array.isArray(event.args) || event.args.length !== 2) return undefined
  const [name, action] = event.args as unknown[]
  return name === 'mediaos-key' && (MPV_KEYS as readonly unknown[]).includes(action) ? action as MpvKey : undefined
}

export class MpvController extends PlayerBase {
  private process: MpvProcess
  private transport?: MpvTransport
  private unsubscribe?: () => void
  private loaded = false
  private paused = false
  private buffering = false
  private subtitles: PlaybackPlan['subtitles'] = []
  private selection?: PlaybackPlan['selection']

  constructor(private mpvOpts: MpvControllerOptions = {}) {
    super('mpv', mpvOpts)
    this.process = mpvOpts.process ?? new MpvProcess({ clock: this.clock, ...mpvOpts.processOptions })
  }
  protected async load(plan: PlaybackPlan): Promise<void> {
    this.loaded = false
    this.paused = false
    this.buffering = false
    this.subtitles = plan.subtitles
    this.selection = plan.selection
    if (!this.transport) {
      this.transport = this.mpvOpts.transport ?? await this.process.start()
      if (this.mpvOpts.transport) await this.transport.connect()
      this.unsubscribe = this.transport.onEvent((event) => this.event(event))
      await Promise.all(['time-pos', 'duration', 'pause', 'track-list', 'paused-for-cache'].map((name, i) =>
        this.transport!.observe(name, i + 1)))
    }
    await this.transport.request(['set_property', 'http-header-fields', Object.entries(plan.headers).map(([k, v]) => `${k}: ${v}`)])
    await this.transport.request(['set_property', 'pause', false])
    await this.transport.request(['loadfile', plan.url, 'replace', -1, `start=${plan.startSec}`])
  }
  private event(event: MpvEvent): void {
    if (event.event === 'client-message') {
      const key = mpvKey(event)
      if (key && this.session) this.mpvOpts.onKey?.(key)
      return
    }
    if (!this.session) return
    if (event.event === 'file-loaded' || event.event === 'playback-restart') {
      if (!this.loaded && event.event === 'file-loaded') {
        void this.applySelection()
      }
      this.loaded = true
      this.status(this.paused ? 'paused' : this.buffering ? 'buffering' : 'playing')
    }
    if (event.event === 'end-file') { this.loaded = false; void this.ended(event.reason ?? 'stop') }
    if (event.event === 'disconnected') { this.loaded = false; this.lost(new Error('mpv disconnected')) }
    if (event.event !== 'property-change') return
    if (event.name === 'time-pos' && typeof event.data === 'number') this.position(event.data)
    if (event.name === 'duration' && typeof event.data === 'number') this.position(undefined, event.data)
    if (event.name === 'pause') {
      this.paused = event.data === true
      if (this.loaded) this.status(this.paused ? 'paused' : this.buffering ? 'buffering' : 'playing')
    }
    if (event.name === 'paused-for-cache') {
      this.buffering = event.data === true
      if (this.loaded) this.status(this.paused ? 'paused' : this.buffering ? 'buffering' : 'playing')
    }
    if (event.name === 'track-list' && Array.isArray(event.data)) {
      this.value.audioTracks = tracks(event.data, 'audio')
      this.value.subtitleTracks = tracks(event.data, 'sub')
      this.emit()
    }
  }
  private async applySelection(): Promise<void> {
    const transport = this.transport
    const generation = this.generation
    const selection = this.selection
    const subtitles = this.subtitles
    for (const sub of subtitles) {
      if (generation !== this.generation) return
      await transport?.request(['sub-add', sub.url, sub.default ? 'select' : 'auto', sub.title ?? '', sub.lang ?? ''])
        .catch((error: unknown) => this.logger.warn('Subtitles could not be loaded', error))
    }
    if (generation !== this.generation) return
    try {
      if (selection?.audio !== undefined) await transport?.request(['set_property', 'aid', selection.audio])
      if (generation !== this.generation) return
      let sid = selection?.subtitle
      if (typeof sid === 'number' && subtitles.length && transport) {
        const raw = await transport.request(['get_property', 'track-list'])
        if (generation !== this.generation) return
        const subs = Array.isArray(raw) ? raw.filter(isSubtitle) : []
        const embedded = subs.filter((track) => !track.external)
        const external = subtitles[sid - embedded.length - 1]
        if (sid > embedded.length) {
          const track = subs.find((track) => track.external && track['external-filename'] === external?.url)
          if (typeof track?.id !== 'number') {
            this.logger.warn('The chosen subtitles could not be loaded; keeping the player defaults')
            return
          }
          sid = track.id
        }
      }
      if (generation !== this.generation) return
      if (sid !== undefined) await transport?.request(['set_property', 'sid', sid ?? 'no'])
    } catch (error) { this.logger.warn('The chosen tracks could not be selected', error) }
  }
  protected async control(cmd: PlayerCommand): Promise<void> {
    if (!this.transport) return
    // Stopgap until the player has its own controls: mpv's built-in bar shows the time after a pause or a skip.
    if (cmd.kind === 'togglePause') {
      await this.transport.request(['cycle', 'pause'])
      await this.transport.request(['show-progress']).catch(() => undefined)
    }
    if (cmd.kind === 'seekRelative') await this.transport.request(['osd-msg-bar', 'seek', cmd.seconds, 'relative+exact'])
    if (cmd.kind === 'seekTo') await this.transport.request(['seek', this.toPlayerTime(cmd.seconds), 'absolute+exact'])
    if (cmd.kind === 'setAudio') await this.transport.request(['set_property', 'aid', cmd.index])
    if (cmd.kind === 'setSubtitle') await this.transport.request(['set_property', 'sid', cmd.index ?? 'no'])
  }
  protected async halt(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const transport = this.transport
    this.transport = undefined
    if (transport) await transport.request(['stop']).catch(() => undefined)
    transport?.close()
    if (!this.mpvOpts.transport) await this.process.dispose()
    this.loaded = false
  }
  override async dispose(): Promise<void> {
    await super.dispose()
    this.mpvOpts.transport?.dispose()
    await this.process.dispose()
  }
}

function isSubtitle(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && 'type' in raw && raw.type === 'sub'
}

function tracks(data: unknown[], type: string): PlayerState['audioTracks'] {
  return data.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const track = raw as Record<string, unknown>
    if (track.type !== type || typeof track.id !== 'number') return []
    const label = [track.title, track.lang, track.codec].filter((v) => typeof v === 'string' && v).join(' · ')
    return [{ index: track.id,
      label: label || `${type === 'audio' ? 'Audio' : 'Subtitle'} ${track.id}`, selected: track.selected === true }]
  })
}
