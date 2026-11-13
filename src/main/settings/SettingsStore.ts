import * as fs from 'node:fs/promises'
import { Settings, defaultSettings, migrateSettings, type SettingsPatch } from '@shared/settings-schema'
import { atomicWrite, missing, renameWithRetry, type FileSystem } from './atomic'
import { runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'
import { SourceError } from '../sources/MediaSource'

export interface SettingsOptions { debounceMs?: number; clock?: Runtime; fs?: FileSystem; logger?: Log }

export class SettingsStore {
  readonly recoveredFrom?: string
  private value: Settings
  private revision = 0
  private saved = 0
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()
  private listeners = new Set<(settings: Settings) => void>()
  private readonly io: FileSystem
  private readonly clock: Runtime
  private writeError?: unknown
  private erased = false
  private eraseFailed = false

  private constructor(readonly file: string, value: Settings, private opts: SettingsOptions, recovered?: string) {
    this.value = value
    this.recoveredFrom = recovered
    this.io = opts.fs ?? fs
    this.clock = opts.clock ?? runtime
  }

  static async open(file: string, opts: SettingsOptions = {}): Promise<SettingsStore> {
    const io = opts.fs ?? fs
    let raw: string
    try { raw = await io.readFile(file, 'utf8') } catch (error) {
      if (missing(error)) return new SettingsStore(file, defaultSettings(), opts)
      throw error
    }
    try { return new SettingsStore(file, migrateSettings(JSON.parse(raw)), opts) } catch {
      try {
        await io.rm(`${file}.bad`, { force: true })
        await renameWithRetry(io, file, `${file}.bad`)
        ;(opts.logger ?? silentLog).warn('settings file damaged; set aside')
      } catch { (opts.logger ?? silentLog).warn('settings file damaged; could not set aside') }
      return new SettingsStore(file, defaultSettings(), opts,
        'Your settings file was damaged, so MediaOS started with default settings.')
    }
  }

  get(): Settings { return structuredClone(this.value) }

  update(patch: SettingsPatch): Settings {
    if (this.erased) {
      // A running or finished erase is followed straight away by a restart; only a failed one needs the user to act.
      throw new SourceError(this.eraseFailed ? "MediaOS couldn't finish erasing everything. Restart the box and try again." :
        'MediaOS is restarting after the reset. Try again in a moment.', 'server')
    }
    const merged: Record<string, unknown> = { ...this.value }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const old = merged[key]
      merged[key] = isObject(old) && isObject(value) ? { ...old, ...value } : value
    }
    const next = Settings.parse(merged)
    if (JSON.stringify(next) === JSON.stringify(this.value)) return this.get()
    this.value = next
    this.revision++
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.flush().catch((error: unknown) => {
        this.writeError = error
        ;(this.opts.logger ?? silentLog).error('Settings could not be saved')
      })
    }, this.opts.debounceMs ?? 300)
    for (const cb of this.listeners) cb(this.get())
    return this.get()
  }

  async flush(): Promise<void> {
    if (this.erased) { await this.writing.catch(() => undefined); return }
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    const job = this.writing.catch(() => undefined).then(async () => {
      while (!this.erased && this.saved !== this.revision) {
        const revision = this.revision
        await atomicWrite(this.file, `${JSON.stringify(this.value, null, 2)}\n`, undefined, this.io)
        this.saved = revision
      }
      this.writeError = undefined
    })
    this.writing = job
    await job
  }

  onChange(cb: (settings: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  get lastWriteError(): unknown { return this.writeError }

  async erase(): Promise<void> {
    this.erased = true
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.saved = this.revision
    const job = this.writing.catch(() => undefined).then(async () => {
      const results = await Promise.allSettled([this.file, `${this.file}.bad`, `${this.file}.tmp`]
        .map((p) => this.io.rm(p, { force: true })))
      const failed = results.find((r) => r.status === 'rejected')
      if (failed?.status === 'rejected') { this.eraseFailed = true; throw failed.reason }
      // Only now: after a failed erase the screen must keep showing the settings that are still on disk,
      // or the next re-read would send the user into the setup wizard, which can't save.
      this.value = defaultSettings()
    })
    this.writing = job
    await job
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
