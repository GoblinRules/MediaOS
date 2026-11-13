import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { relative, isAbsolute, resolve } from 'node:path'
import type { AppEntry } from '@shared/apps'
import type { AppHost } from './types'
import { chromeArgs, prepareProfile, profilePath } from './chrome'
import { runtime, type Runtime } from '../core/runtime'
import { missing, type FileSystem } from '../settings/atomic'
import type { Log } from '../log/Logger'
import { stopProfileBrowsers, type ProcessTable } from './orphans'

export interface ChromeHostOptions {
  profileDir: string
  chromePath: string
  /** Platform flags added after the usual ones (on Linux: run as a Wayland window). */
  extraArgs?: string[]
  spawn?: (file: string, args: string[]) => ChildProcess
  clock?: Runtime
  fs?: FileSystem
  logger?: Log
  /** Linux: lets the host find Chrome windows it didn't start (left over from a shell that crashed). */
  processes?: ProcessTable
}

export class ChromeAppHost implements AppHost {
  private current?: { id: string; child: ChildProcess }
  private listeners = new Set<(id: string) => void>()
  private queue: Promise<void> = Promise.resolve()
  private io: FileSystem
  private clock: Runtime
  constructor(private opts: ChromeHostOptions) { this.io = opts.fs ?? fs; this.clock = opts.clock ?? runtime }
  private serial(fn: () => Promise<void>): Promise<void> {
    const job = this.queue.catch(() => undefined).then(fn)
    this.queue = job
    return job
  }
  launch(app: AppEntry): Promise<void> {
    const args = chromeArgs(app, this.opts)
    return this.serial(async () => {
      await this.closeCurrent()
      const profile = profilePath(this.opts.profileDir, app.id)
      await this.checkPath(profile)
      await prepareProfile(profile, this.io, this.opts.logger)
      const child = (this.opts.spawn ?? ((file, argv) => spawn(file, argv, { stdio: 'ignore', windowsHide: true })))(
        this.opts.chromePath, args)
      const current = { id: app.id, child }
      this.current = current
      const exited = () => {
        if (this.current !== current) return
        this.current = undefined
        for (const cb of this.listeners) cb(app.id)
      }
      child.once('exit', exited)
      child.once('error', exited)
      await new Promise<void>((res, rej) => { child.once('spawn', res); child.once('error', rej) })
    })
  }
  private async closeCurrent(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (!current) return
    if (current.child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const child = current.child
        const done = () => { this.clock.clearTimeout(timer); child.off('exit', done); resolve() }
        const timer = this.clock.setTimeout(() => { child.kill('SIGKILL'); done() }, 3000)
        child.once('exit', done)
        if (!child.kill('SIGTERM')) done()
      })
    }
    // Chrome can hand its window to a browser process other than the one we started; make sure none is left.
    await this.stopStray(profilePath(this.opts.profileDir, current.id))
  }
  /** Close any MediaOS app window this shell didn't start, e.g. one left running when the shell crashed. */
  closeLeftovers(): Promise<void> { return this.serial(() => this.stopStray()) }
  private async stopStray(only?: string): Promise<void> {
    const table = this.opts.processes
    if (!table) return
    try {
      await stopProfileBrowsers({ table, profileDir: this.opts.profileDir, only, clock: this.clock, logger: this.opts.logger })
    } catch (error) { this.opts.logger?.warn('Could not check for app windows left running', error) }
  }
  close(): Promise<void> { return this.serial(() => this.closeCurrent()) }
  running(): string | undefined { return this.current?.id }
  resetProfile(appId: string): Promise<void> {
    return this.serial(async () => {
      const target = profilePath(this.opts.profileDir, appId)
      if (this.current?.id === appId) await this.closeCurrent()
      else await this.stopStray(target)
      await this.checkPath(target)
      await this.io.rm(target, { recursive: true, force: true })
    })
  }
  private async checkPath(target: string): Promise<void> {
    // Resolve existing links as well as checking the lexical path before any recursive removal.
    const root = await this.io.realpath(this.opts.profileDir).catch((error: unknown) => {
      if (missing(error)) return resolve(this.opts.profileDir)
      throw error
    })
    let actual: string
    try { actual = await this.io.realpath(target) } catch (error) { if (missing(error)) return; throw error }
    const rel = relative(root, actual)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Profile must be inside the profiles folder')
  }
  onExit(cb: (id: string) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
}
