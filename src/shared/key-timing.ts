// Turns raw key down/up events into actions, adding long-press meanings:
//   Back held >= 800 ms   -> Home    (TVs often keep the real Home key for themselves)
//   Select held >= 600 ms -> Menu    (remotes without a Menu key)
//   Home held >= 1500 ms  -> Recovery menu
// Short presses of those three keys fire on release; every other key fires on press (and on auto-repeat).
import { LONG_BACK_MS, LONG_HOME_MS, LONG_SELECT_MS, type Action } from './actions'

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const HOLDABLE: Partial<Record<Action, { ms: number; long: Action }>> = {
  back: { ms: LONG_BACK_MS, long: 'home' },
  select: { ms: LONG_SELECT_MS, long: 'menu' },
  home: { ms: LONG_HOME_MS, long: 'recovery' },
}

export type Emit = (action: Action, info: { long: boolean }) => void

export class KeyTiming {
  private held: { key: Action; timer: unknown; fired: boolean } | undefined

  constructor(
    private readonly emit: Emit,
    private readonly timers: Timers = realTimers,
  ) {}

  /** Returns true when the key is one the shell handles (caller should preventDefault). */
  down(key: Action, repeat = false): boolean {
    const hold = HOLDABLE[key]
    if (!hold) {
      if (this.held && !repeat) this.cancel()
      this.emit(key, { long: false })
      return true
    }
    if (repeat) return true
    if (this.held) this.cancel()
    const entry: { key: Action; timer: unknown; fired: boolean } = { key, timer: undefined, fired: false }
    entry.timer = this.timers.set(() => {
      if (this.held !== entry) return
      entry.fired = true
      this.emit(hold.long, { long: true })
    }, hold.ms)
    this.held = entry
    return true
  }

  up(key: Action): void {
    const h = this.held
    if (!h || h.key !== key) return
    this.timers.clear(h.timer)
    this.held = undefined
    if (!h.fired) this.emit(key, { long: false })
  }

  /** Forget any held key without emitting (window lost focus, another key pressed). */
  cancel(): void {
    if (this.held) this.timers.clear(this.held.timer)
    this.held = undefined
  }

  /** True while a holdable key is down and its long action has not fired yet (for a "Hold for Home" hint). */
  pending(): Action | undefined {
    return this.held && !this.held.fired ? this.held.key : undefined
  }
}
