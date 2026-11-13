import type { AppEntry } from '@shared/apps'
import type { AppExitReason, AppHost } from './types'
import { checkApp } from './chrome'
import { silentLog, type Log } from '../log/Logger'

export interface MockWindow { close(): void; onClosed(cb: () => void): void }
export interface MockAppOptions { openWindow: (app: AppEntry) => MockWindow; logger?: Log }

export class MockAppHost implements AppHost {
  private current?: { appId: string; window: MockWindow }
  private listeners = new Set<(id: string, reason: AppExitReason) => void>()
  private queue: Promise<void> = Promise.resolve()
  constructor(private opts: MockAppOptions) {}
  launch(app: AppEntry): Promise<void> {
    checkApp(app)
    const job = this.queue.catch(() => undefined).then(() => {
      this.closeCurrent()
      const window = this.opts.openWindow(app)
      const current = { appId: app.id, window }
      this.current = current
      window.onClosed(() => {
        if (this.current !== current) return
        this.current = undefined
        for (const cb of this.listeners) cb(app.id, 'exited')
      })
    })
    this.queue = job
    return job
  }
  private closeCurrent(): void { const old = this.current; this.current = undefined; old?.window.close() }
  close(): Promise<void> {
    const job = this.queue.catch(() => undefined).then(() => this.closeCurrent())
    this.queue = job
    return job
  }
  running(): string | undefined { return this.current?.appId }
  async resetProfile(appId: string): Promise<void> { (this.opts.logger ?? silentLog).info(`Mock profile reset: ${appId}`) }
  onExit(cb: (id: string, reason: AppExitReason) => void): () => void {
    this.listeners.add(cb); return () => { this.listeners.delete(cb) }
  }
}
