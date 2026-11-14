import { execFile } from 'node:child_process'
import { silentLog, type Log } from '../log/Logger'

export interface KeyInjector { key(name: string): Promise<void>; text(s: string): Promise<void> }
export const APP_PHONE_KEYS = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', select: 'Return', back: 'Escape', menu: 'Menu',
  playPause: 'XF86AudioPlay', rewind: 'XF86AudioRewind', fastForward: 'XF86AudioForward',
} as const
const KEYS = new Set<string>([...Object.values(APP_PHONE_KEYS), 'BackSpace'])

function checkKey(name: string): void { if (!KEYS.has(name)) throw new Error('Unknown phone key') }

export class WtypeInjector implements KeyInjector {
  private tail: Promise<void> = Promise.resolve()
  private unavailable = false
  constructor(private opts: { logger?: Log; display?: () => string | undefined } = {}) {}
  async key(name: string): Promise<void> { checkKey(name); await this.run(['-k', name]) }
  text(s: string): Promise<void> { return this.run(['--', s]) }
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
          if (!error) { resolve(); return }
          if ('code' in error && error.code === 'ENOENT') { this.warn(); resolve(); return }
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
}
