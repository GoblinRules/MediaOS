import type { Settings } from '@shared/settings-schema'
import type { SystemServices } from '../system/SystemServices'
import type { Log } from '../log/Logger'
import { runtime, type Runtime } from './runtime'

/** Stable spread over 04:00–05:29, using the box's name and the local date. */
export function updateStartMinute(date: string, deviceName: string): number {
  let hash = 2166136261
  for (const char of `${date}:${deviceName}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return 240 + hash % 90
}

interface SchedulerOptions {
  settings(): Pick<Settings, 'updates' | 'deviceName'>
  state(): { idle: boolean; screenOff: boolean; shell: boolean }
  system: Pick<SystemServices, 'updates' | 'network'>
  logger: Log
  timers?: Runtime
}

export class UpdateScheduler {
  private timer: ReturnType<typeof setInterval>
  private timers: Runtime
  private attempted?: string
  private considering = false
  private disposed = false

  constructor(private opts: SchedulerOptions) {
    this.timers = opts.timers ?? runtime
    this.timer = this.timers.setInterval(() => { void this.consider() }, 5 * 60_000)
    this.timer.unref?.()
  }
  private eligibleDate(): string | undefined {
    const settings = this.opts.settings(), state = this.opts.state(), now = new Date(this.timers.now())
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const minute = now.getHours() * 60 + now.getMinutes()
    if (!settings.updates.auto || !state.shell || !(state.idle || state.screenOff) || this.attempted === date ||
      minute < updateStartMinute(date, settings.deviceName) || minute >= 360) return undefined
    return date
  }
  private async consider(): Promise<void> {
    if (this.disposed || this.considering || !this.eligibleDate()) return
    this.considering = true
    try {
      const status = await this.opts.system.updates.status()
      if (!status.configured || status.running || await this.opts.system.network.trial()) return
      const date = this.eligibleDate()
      if (this.disposed || !date) return
      this.attempted = date
      const result = await this.opts.system.updates.auto()
      if (result.ok) this.opts.logger.info('Overnight update finished', result)
      else this.opts.logger.warn('Overnight update failed', result.error)
    } catch (error) { this.opts.logger.warn('Overnight update failed', error) }
    finally { this.considering = false }
  }
  dispose(): void { this.disposed = true; this.timers.clearInterval(this.timer) }
}
