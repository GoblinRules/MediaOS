// Keeps exactly one window filling the TV screen under sway.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { silentLog, type Log } from '../../log/Logger'

type Exec = (args: string[]) => Promise<void>
type Spawn = () => Pick<ChildProcess, 'stdout' | 'once' | 'kill'>

const exec: Exec = (args) => new Promise((resolve, reject) => {
  execFile('swaymsg', args, { timeout: 3000 }, (error) => (error ? reject(error) : resolve()))
})

/** Pause after a window appears, and between switching its full screen off and on again (proven on the VM). */
export const SETTLE_MS = 200
const MAX_RETRY_MS = 30_000

/**
 * sway's `for_window [all] fullscreen enable` makes every new window full screen. But when the new window opens over
 * one that is already full screen (an app over the home screen just after a shell start, a Chrome pop-up, the player
 * over a website), sway marks the new window as shown yet keeps drawing the old one: the screen looks stuck and the
 * remote's keys go to a window nobody can see. Switching the new window's full screen off and on again once it has
 * opened makes sway draw it. When a window closes, the one left in front is made full screen again, so it is not
 * left squeezed beside the home screen.
 */
export class SwayWindowKeeper {
  private child?: ReturnType<Spawn>
  private disposed = false
  private retryMs = 1000
  private warnedLost = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private opts: { logger?: Log; exec?: Exec; spawn?: Spawn } = {}) {}

  start(): void {
    if (this.disposed || this.child) return
    const child = (this.opts.spawn ?? (() => spawn('swaymsg', ['-t', 'subscribe', '-m', '["window"]'],
      { stdio: ['ignore', 'pipe', 'ignore'] })))()
    this.child = child
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return
      this.child = undefined
      if (error.code === 'ENOENT') { this.log().warn('sway is not available, so app windows are not kept full screen'); return }
      this.retry()
    })
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.retry() } })
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.line(line))
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    const child = this.child
    this.child = undefined
    child?.kill()
  }

  private line(line: string): void {
    let event: { change?: unknown; container?: { id?: unknown } }
    try { event = JSON.parse(line) as typeof event } catch { return }
    if (event === null || typeof event !== 'object') return
    this.retryMs = 1000
    this.warnedLost = false
    const id = event.container?.id
    if (event.change === 'new' && Number.isSafeInteger(id) && (id as number) > 0) {
      const target = `[con_id=${id as number}]`
      this.later(() => this.run([target, 'fullscreen', 'disable'])
        .then(() => this.wait())
        .then(() => this.run([target, 'fullscreen', 'enable'])))
    } else if (event.change === 'close') {
      // Whatever sway focused next (the app under a closed pop-up, or the home screen) fills the screen again.
      // Only a tiled window: a floating one (a Chrome print or file box) keeps its own size.
      this.later(() => this.run(['[tiling con_id=__focused__]', 'fullscreen', 'enable']))
    }
  }

  private later(job: () => Promise<void>): void {
    if (this.disposed) return
    const timer = setTimeout(() => { this.timers.delete(timer); void job() }, SETTLE_MS)
    this.timers.add(timer)
  }

  /**
   * Never resolves after dispose, so the "enable" half is dropped then (the shell is closing). If the enable fails or
   * times out, the window stays tiled until the next window opens or closes; that is accepted rather than retried.
   */
  private wait(): Promise<void> {
    return new Promise((resolve) => this.later(async () => resolve()))
  }

  /** A window that closed meanwhile just makes swaymsg fail; that is expected and not logged. Never throws. */
  private run(args: string[]): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return (this.opts.exec ?? exec)(args).catch(() => undefined)
  }

  private retry(): void {
    if (this.disposed) return
    // Once until sway answers again, so a sway that keeps refusing doesn't fill the log every 30 s.
    if (!this.warnedLost) this.log().warn("Lost touch with sway's window events; trying again with a growing wait")
    this.warnedLost = true
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.start() }, this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
  }

  private log(): Log { return this.opts.logger ?? silentLog }
}
