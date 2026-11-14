import { execFile } from 'node:child_process'
import { silentLog, type Log } from '../log/Logger'

export interface KeyInjector {
  key(name: string): Promise<void>
  text(s: string): Promise<void>
  /** Resolves once the keyboard is safe for a new window to start (see WtypeInjector). Never throws. */
  settle(): Promise<void>
  dispose(): void
}
/** Phone keys typed into the app in front. Play, pause and seek go through Chrome's media controls (media-control.ts). */
export const APP_PHONE_KEYS = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', select: 'Return', back: 'Escape', menu: 'Menu',
} as const
/** Desktop websites ignore Escape for Back; Chrome's own Back key goes back a page. TV-style apps keep Escape. */
export const POINTER_BACK_KEY = 'XF86Back'
const KEYS = new Set<string>([...Object.values(APP_PHONE_KEYS), POINTER_BACK_KEY, 'BackSpace'])

function checkKey(name: string): void { if (!KEYS.has(name)) throw new Error('Unknown phone key') }

/** How long after the last typed key the keyboard is put back (see WtypeInjector). */
export const KEYMAP_REPAIR_DELAY_MS = 1500

/**
 * Types phone keys into the app in front with wtype.
 *
 * wtype works through a short-lived virtual keyboard with its own tiny keymap. When it goes, sway keeps that keymap
 * as the seat's keymap until a real key is pressed, and any NEW window (Chrome, mpv, the shell after a restart) then
 * crashes in libxkbcommon at start-up. So once typing stops, `swaymsg reload` puts sway's own keymap back, and
 * settle() does it straight away before anything opens a new window.
 */
export class WtypeInjector implements KeyInjector {
  private tail: Promise<void> = Promise.resolve()
  private unavailable = false
  private dirty = false
  private timer?: ReturnType<typeof setTimeout>
  constructor(private opts: { logger?: Log; display?: () => string | undefined; repairDelayMs?: number } = {}) {}
  async key(name: string): Promise<void> { checkKey(name); await this.run(['-k', name]) }
  text(s: string): Promise<void> { return this.run(['--', s]) }
  settle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const job = this.tail.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      await new Promise<void>((resolve) => {
        execFile('swaymsg', ['reload'], { timeout: 5000 }, (error) => {
          // Only the error kind: the error text itself is never logged.
          const kind = error ? (error.killed ? 'timed out' : String(error.code ?? 'failed')) : ''
          if (error) (this.opts.logger ?? silentLog).warn(`The keyboard could not be reset after phone typing (${kind})`)
          resolve()
        })
      })
    })
    this.tail = job.catch(() => undefined)
    return this.tail
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private typed(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.settle() }, this.opts.repairDelayMs ?? KEYMAP_REPAIR_DELAY_MS)
  }
  private warn(): void {
    if (!this.unavailable) (this.opts.logger ?? silentLog).warn('Phone typing is unavailable. Check Wayland and wtype are installed.')
    this.unavailable = true
  }
  private run(args: string[]): Promise<void> {
    const job = this.tail.then(async () => {
      if (this.unavailable) return
      if (!(this.opts.display ?? (() => process.env.WAYLAND_DISPLAY))()) { this.warn(); return }
      await new Promise<void>((resolve, reject) => {
        execFile('wtype', args, { timeout: 2000 }, (error) => {
          if (!error) { this.typed(); resolve(); return }
          if ('code' in error && error.code === 'ENOENT') { this.warn(); resolve(); return }
          // A failed or timed-out wtype may still have swapped the keymap.
          this.typed()
          // Child-process errors contain argv (possibly typed secrets); never propagate or log them.
          reject(new Error("Couldn't type on the TV. Try again."))
        })
      })
    })
    this.tail = job.catch(() => undefined)
    return job
  }
}

export class LogInjector implements KeyInjector {
  constructor(private logger: Log = silentLog) {}
  async key(name: string): Promise<void> { checkKey(name); this.logger.debug(`Phone key: ${name}`) }
  async text(s: string): Promise<void> { this.logger.debug(`Phone text: ${[...s].length} characters`) }
  async settle(): Promise<void> { /* Nothing typed for real, nothing to put back. */ }
  dispose(): void { /* No timers. */ }
}
