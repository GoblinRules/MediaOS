import { execFile } from 'node:child_process'
import { silentLog, type Log } from '../log/Logger'

export type AppMediaCommand = { kind: 'playPause' } | { kind: 'seek'; seconds: number }

/** Play, pause and seek in the app in front (a Chrome window), whatever the website's own keys are. */
export interface AppMediaControl {
  /** `pid` is the Chrome browser process the app runs in. Never throws: a page with nothing playing just ignores it. */
  send(pid: number | undefined, command: AppMediaCommand): Promise<void>
}

const PLAYER = 'org.mpris.MediaPlayer2.Player'

/**
 * Uses Chrome's own media controls on the session bus (MPRIS, `org.mpris.MediaPlayer2.chromium.instance<pid>`).
 * Media keys typed with wtype never reach Chrome's media handling, but MPRIS works on any page playing video or
 * audio (live streams can pause but not seek; Chrome ignores the seek).
 */
export class MprisMediaControl implements AppMediaControl {
  private warned = false
  constructor(private opts: { logger?: Log } = {}) {}
  send(pid: number | undefined, command: AppMediaCommand): Promise<void> {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve()
    const call = command.kind === 'playPause' ? ['PlayPause']
      : ['Seek', 'x', String(Math.round(command.seconds * 1_000_000))]
    // `--` before the positional arguments so a negative seek is not read as an option.
    const args = ['--user', '--timeout=2', '--', 'call', `org.mpris.MediaPlayer2.chromium.instance${pid}`,
      '/org/mpris/MediaPlayer2', PLAYER, ...call]
    return new Promise<void>((resolve) => {
      execFile('busctl', args, { timeout: 3000 }, (error) => {
        if (error && !this.warned) {
          this.warned = true
          // Usually nothing is playing yet (Chrome only registers once a page plays media). Only the kind is logged.
          const kind = error.killed ? 'timed out' : String(error.code ?? 'failed')
          ;(this.opts.logger ?? silentLog).info(`The app's video controls did not answer (${kind})`)
        }
        if (!error) this.warned = false
        resolve()
      })
    })
  }
}

export class LogMediaControl implements AppMediaControl {
  constructor(private logger: Log = silentLog) {}
  async send(pid: number | undefined, command: AppMediaCommand): Promise<void> {
    this.logger.debug(`Phone media: ${command.kind === 'seek' ? `seek ${command.seconds}s` : 'play/pause'} (pid ${pid ?? 'none'})`)
  }
}
