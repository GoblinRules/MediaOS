import * as fs from 'node:fs/promises'
import { NET_RESTORE_FAILED, type IpConfig, type NetProfile, type NetTrial, type Result } from '@shared/system-types'
import { checkIpConfig } from '@shared/ipv4'
import type { Runtime } from '../../core/runtime'
import type { Log } from '../../log/Logger'
import { atomicWrite, missing, type FileSystem } from '../../settings/atomic'
import type { Unsub } from '../SystemServices'
import type { NetQueue } from './NetQueue'
import { NETWORK_BUSY, RESET_FAILED, UserFacingError } from './texts'

export const TRIAL_SEC = 45
export const CHECKPOINT_SEC = 90
export const MIN_KEEP_MS = 2000
export const APPLY_DEADLINE_MS = 30_000
export const ALIVE_POLL_MS = 5000
export const RECOVER_DEADLINE_MS = 20_000

export interface TrialBackend {
  profiles(): Promise<NetProfile[]>
  snapshot(profileId: string): Promise<unknown>
  begin(profileId: string, timeoutSec: number): Promise<string>
  applyTemporary(profileId: string, cfg: IpConfig, deadlineMs: number): Promise<Result>
  checks(cfg: IpConfig): { router(): Promise<boolean>; dns(): Promise<boolean>; internet(): Promise<boolean> }
  commit(handle: string): Promise<'ok' | 'gone'>
  save(profileId: string): Promise<Result>
  unsaved(profileId: string): Promise<boolean>
  rollback(handle: string): Promise<'ok' | 'gone'>
  alive(handle: string): Promise<boolean>
  restore(snapshot: unknown): Promise<Result>
  matches(snapshot: unknown): Promise<boolean>
  resetAll(): Promise<Result>
  clearCheckpoints(): Promise<void>
}

interface Options {
  backend: TrialBackend; queue: NetQueue; clock: Runtime; fs?: FileSystem; journalPath: string; logger: Log
  trialSec?: number; now?: () => string
  /** Milliseconds that never jump (the wall clock can, when the new network lets NTP set it). */
  monotonic?: () => number
}
interface Journal {
  v: 1; state: 'pending' | 'saving'; profileId: string; device?: string; checkpoint?: string
  before: unknown; createdAt: string
}
interface Active {
  view: NetTrial; journal: Journal; started?: number; deadline?: number; finishing: boolean
}
type Toast = { text: string; tone: 'info' | 'warn' | 'ok' | 'error' }
const ok: Result = { ok: true }
const fail = (error: string): Result => ({ ok: false, error })
const NO_TRIAL = "There's no network change waiting. The old settings may already be back."
const WAIT = 'Wait until the checks finish.'
const APPLY_FAILED = "Those settings didn't work, so the box went back to its previous settings. " +
  'Check the address and router, then try again.'
// Said while a Put back is already on its way: the old settings aren't back yet.
const APPLY_FAILED_REVERTING = "Those settings didn't work. Check the address and router, then try again."
const RESTORE_FAILED = NET_RESTORE_FAILED
const RECOVER_FAILED = "Couldn't check the last network change. If the box is offline, " +
  'hold Home and choose Reset network to automatic.'

class Deadline extends Error {}

export class IpTrial {
  private readonly io: FileSystem
  private active?: Active
  private cooldownUntil = -Infinity
  private starting = false
  private disposed = false
  private listeners = new Set<() => void>()
  private toasts = new Set<(toast: Toast) => void>()
  private tick?: ReturnType<typeof setInterval>
  private poll?: ReturnType<typeof setInterval>
  private polling = false
  private resetting?: Promise<Result>
  private deadlines = new Map<ReturnType<typeof setTimeout>, () => void>()

  constructor(private opts: Options) { this.io = opts.fs ?? fs }

  private mono(): number { return this.opts.monotonic ? this.opts.monotonic() : performance.now() }

  pending(): boolean { return this.starting || !!this.active }
  async trial(): Promise<NetTrial | null> { return this.active ? structuredClone(this.active.view) : null }
  on(_ev: 'trial', cb: () => void): Unsub { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  onToast(cb: (toast: Toast) => void): Unsub { this.toasts.add(cb); return () => { this.toasts.delete(cb) } }

  apply(profileId: string, cfg: IpConfig): Promise<Result> {
    if (this.mono() < this.cooldownUntil) return Promise.resolve(fail(NETWORK_BUSY))
    const problem = checkIpConfig(cfg)
    if (problem) return Promise.resolve(fail(problem.message))
    if (this.disposed) return Promise.resolve(fail(NO_TRIAL))
    if (this.pending() || this.resetting) {
      return Promise.resolve(fail('Another network change is still waiting. Keep it or put it back first.'))
    }
    this.starting = true
    const config = structuredClone(cfg)
    return this.opts.queue.run(async () => {
      let current: Active | undefined
      try {
        this.live()
        const profile = (await this.opts.backend.profiles()).find((p) => p.id === profileId)
        this.live()
        if (!profile) return fail("That network isn't saved any more. Go back and choose it again.")
        if (!profile.editable) return fail(profile.why ?? "This connection's settings can't be changed here.")
        if (!profile.active) return fail(`Connect to ${profile.name} first, then change its IP settings.`)
        const before = await this.opts.backend.snapshot(profileId)
        this.live()
        const journal: Journal = { v: 1, state: 'pending', profileId, before,
          createdAt: this.opts.now?.() ?? new Date(this.opts.clock.now()).toISOString() }
        current = { journal, finishing: false, view: { profileId, name: profile.name, phase: 'applying',
          secondsLeft: this.opts.trialSec ?? TRIAL_SEC, router: 'checking', dns: 'checking', internet: 'checking', canKeep: false } }
        this.active = current
        await this.write(journal)
        this.live()
        journal.checkpoint = await this.begin(profileId)
        this.live()
        await this.write(journal)
        this.live()
        this.emit()
        const result = await this.bounded(
          this.opts.backend.applyTemporary(profileId, config, APPLY_DEADLINE_MS), APPLY_DEADLINE_MS)
        this.live()
        if (!result.ok) {
          if (current.finishing) return result
          await this.undo(current)
          await this.forget()
          this.finish(current)
          return result
        }
        const started = this.mono()
        current.started = started
        current.deadline = started + (this.opts.trialSec ?? TRIAL_SEC) * 1000
        const applied = (await this.opts.backend.profiles()).find((p) => p.id === profileId)
        this.live()
        current.view.address = applied?.live?.address
        if (!current.finishing) this.start(current, config)
        return ok
      } catch (error) {
        this.opts.logger.warn('Network apply failed', error)
        let restored = true
        if (current && !current.finishing && !this.disposed) {
          try { await this.undo(current) }
          catch (restoreError) { restored = false; this.opts.logger.error('Network restore failed', restoreError) }
          if (restored) await this.forget()
          this.finish(current)
        } else if (current?.finishing) return fail(APPLY_FAILED_REVERTING)
        // Saying "went back to its previous settings" when that failed would send the user the wrong way.
        return fail(restored ? error instanceof UserFacingError ? error.message : APPLY_FAILED : RESTORE_FAILED)
      } finally { this.starting = false }
    })
  }

  private async begin(profileId: string): Promise<string> {
    const work = this.opts.backend.begin(profileId, CHECKPOINT_SEC)
    try { return await this.bounded(work, 20_000) }
    catch (error) {
      if (error instanceof Deadline && !this.disposed) {
        this.cooldownUntil = this.mono() + (CHECKPOINT_SEC + 30) * 1000
        // NetworkManager may finish after busctl is killed. Destroy that checkpoint without rolling back a later reset.
        void work.then(async (handle) => {
          try { await this.opts.backend.commit(handle) }
          catch (cleanupError) { this.opts.logger.warn('Late network checkpoint not cleared', cleanupError) }
        }, () => undefined)
      }
      throw error
    }
  }

  keep(): Promise<Result> {
    const current = this.active
    if (!current || current.finishing || current.deadline !== undefined && this.mono() >= current.deadline) {
      return Promise.resolve(fail(NO_TRIAL))
    }
    if (current.view.router === 'failed') {
      return Promise.resolve(fail("These settings can't reach the router, so they can't be kept. Put back the old settings."))
    }
    this.refresh(current)
    if (!current.view.canKeep) return Promise.resolve(fail(WAIT))
    this.claim(current)
    return this.opts.queue.run(async () => {
      try {
        this.live()
        current.journal.state = 'saving'
        await this.write(current.journal)
        this.live()
        const committed = await this.opts.backend.commit(current.journal.checkpoint!)
        this.live()
        if (committed === 'gone') {
          await this.restoreUnlessMatching(current.journal.before)
          await this.forget()
          return fail(NO_TRIAL)
        }
        let saved: Result
        try { saved = await this.opts.backend.save(current.view.profileId) }
        catch { saved = fail('Save failed') }
        this.live()
        if (!saved.ok) {
          this.require(await this.opts.backend.restore(current.journal.before))
          this.live()
          await this.forget()
          return fail("Couldn't save the new settings, so the old ones are back.")
        }
        await this.forget()
        this.toast('New network settings saved.', 'ok')
        return ok
      } catch (error) {
        this.opts.logger.error('Network keep failed', error)
        if (!this.disposed) {
          try { await this.undo(current) }
          catch (restoreError) { this.opts.logger.error('Network restore failed', restoreError); return fail(RESTORE_FAILED) }
          await this.forget()
        }
        return fail("Couldn't save the new settings, so the old ones are back.")
      } finally { this.finish(current) }
    })
  }

  revert(): Promise<Result> {
    const current = this.active
    if (!current) {
      // An apply may still be taking its snapshot. Wait behind it before looking again.
      if (this.starting) return this.opts.queue.run(async () => this.active).then(() => this.revert())
      return Promise.resolve(ok)
    }
    if (current.finishing || this.disposed) return this.opts.queue.run(async () => ok)
    this.claim(current)
    // The caller shows a failure (the renderer's dialog), so no toast for it here as well.
    return this.end(current, 'The old network settings are back.', 'info', false)
  }

  resetAll(): Promise<Result> {
    if (this.resetting) return this.resetting
    const reset = async () => {
      await this.revert()
      return this.opts.queue.run(async () => {
        try {
          this.live()
          const result = await this.opts.backend.resetAll()
          this.live()
          if (result.ok) {
            try { await this.opts.backend.clearCheckpoints() }
            catch (error) { this.opts.logger.warn('Network checkpoints not cleared after reset', error) }
            await this.forget()
          }
          return result
        } catch (error) { this.opts.logger.error('Network reset failed', error); return fail(RESET_FAILED) }
      })
    }
    this.resetting = reset().finally(() => { this.resetting = undefined })
    return this.resetting
  }

  private start(current: Active, cfg: IpConfig): void {
    this.refresh(current); this.emit()
    this.tick = this.opts.clock.setInterval(() => {
      if (!this.ours(current)) return
      this.refresh(current)
      if (current.view.secondsLeft <= 0) {
        this.claim(current)
        void this.end(current, 'No answer, so MediaOS put the old network settings back.', 'warn', true)
      } else this.emit()
    }, 1000)
    this.poll = this.opts.clock.setInterval(() => this.checkAlive(current), ALIVE_POLL_MS)
    const checks = this.opts.backend.checks(cfg)
    for (const key of ['router', 'dns', 'internet'] as const) {
      // Start all three reads inside the queue job, then let them settle independently of later writes.
      let check: Promise<boolean>
      try { check = checks[key]() } catch { check = Promise.resolve(false) }
      void check.catch(() => false).then((passed) => {
        if (!this.ours(current)) return
        current.view[key] = passed ? 'ok' : 'failed'
        this.refresh(current); this.emit()
      })
    }
  }

  private refresh(current: Active): void {
    const settled = ![current.view.router, current.view.dns, current.view.internet].includes('checking')
    if (current.started === undefined || current.deadline === undefined) return
    const now = this.mono()
    current.view.phase = settled ? 'ready' : 'checking'
    current.view.secondsLeft = Math.max(0, Math.ceil((current.deadline - now) / 1000))
    current.view.canKeep = settled && now - current.started >= MIN_KEEP_MS && now < current.deadline &&
      !!current.view.address && current.view.router === 'ok'
  }

  private checkAlive(current: Active): void {
    if (!this.ours(current) || this.polling) return
    this.polling = true
    void this.opts.queue.run(async () => {
      if (!this.ours(current)) return
      if (await this.opts.backend.alive(current.journal.checkpoint!)) return
      if (!this.ours(current)) return
      this.claim(current)
      try {
        await this.restoreUnlessMatching(current.journal.before)
        await this.forget()
        this.toast('The network restarted before you chose, so MediaOS put the old settings back.', 'warn')
      } catch (error) {
        this.opts.logger.error('Network restart restore failed', error)
        this.toast(RESTORE_FAILED, 'error')
      } finally { this.finish(current) }
    }).catch((error: unknown) => this.opts.logger.warn('Network checkpoint check failed', error))
      .finally(() => { this.polling = false })
  }

  private end(current: Active, text: string, tone: Toast['tone'], toastFailure: boolean): Promise<Result> {
    return this.opts.queue.run(async () => {
      try {
        try {
          this.live()
          await this.undo(current)
        } catch (error) {
          this.opts.logger.error('Network revert failed', error)
          if (toastFailure) this.toast(RESTORE_FAILED, 'error')
          return fail(RESTORE_FAILED)
        }
        await this.forget()
        this.toast(text, tone)
        return ok
      } finally { this.finish(current) }
    })
  }

  private async undo(current: Active): Promise<void> {
    this.live()
    let rolledBack = false
    if (current.journal.checkpoint) {
      try { rolledBack = await this.opts.backend.rollback(current.journal.checkpoint) === 'ok' }
      catch { /* A vanished checkpoint still has the persistent snapshot as a fallback. */ }
    }
    this.live()
    if (!rolledBack) this.require(await this.opts.backend.restore(current.journal.before))
    this.live()
  }

  private async restoreUnlessMatching(before: unknown): Promise<void> {
    const matches = await this.opts.backend.matches(before)
    this.live()
    if (!matches) this.require(await this.opts.backend.restore(before))
    this.live()
  }

  async recoverPending(): Promise<string[]> {
    let expired = false
    const guard = () => { this.live(); if (expired) throw new Deadline() }
    // The deadline includes time waiting for the shared queue. Late completions cannot delete the journal.
    const recover = async (): Promise<string[]> => {
      let journal: Journal
      try {
        guard()
        let raw: string
        try { raw = await this.io.readFile(this.opts.journalPath, 'utf8') }
        catch (error) {
          if (missing(error)) return []
          this.opts.logger.warn('Unreadable network journal', error)
          guard(); await this.remove(); return []
        }
        guard()
        try {
          const parsed: unknown = JSON.parse(raw)
          if (!isJournal(parsed)) throw new Error('Invalid network journal')
          journal = parsed
        } catch (error) {
          this.opts.logger.warn('Invalid network journal', error)
          guard(); await this.remove(); return []
        }
        if (journal.state === 'saving') {
          // A checkpoint still running would undo, later on, whatever this saves; the user chose Keep, so end it.
          if (journal.checkpoint && await this.opts.backend.alive(journal.checkpoint)) {
            guard(); await this.opts.backend.commit(journal.checkpoint)
          }
          guard()
          // "Keep" was pressed. Live settings that still differ from the old ones are the new ones: save them if
          // that didn't finish, and say nothing either way. Only when the old ones are live again is a notice due.
          const unsaved = await this.opts.backend.unsaved(journal.profileId)
          guard()
          const matches = await this.opts.backend.matches(journal.before)
          guard()
          if (!matches) {
            if (unsaved) { this.require(await this.opts.backend.save(journal.profileId)); guard() }
            await this.remove(); return []
          }
          await this.remove()
          return ["The last network change wasn't saved, so the old settings are back."]
        }
        let alive = false
        if (journal.checkpoint) { alive = await this.opts.backend.alive(journal.checkpoint); guard() }
        if (alive) {
          const rolledBack = await this.opts.backend.rollback(journal.checkpoint!)
          guard()
          if (rolledBack === 'gone') await recoverRestore()
        } else await recoverRestore()
        guard(); await this.remove()
        return ["The last network change wasn't confirmed, so MediaOS put the old settings back."]
      } catch (error) {
        this.opts.logger.warn('Network journal recovery failed', error)
        return [RECOVER_FAILED]
      }
      async function recoverRestore(): Promise<void> {
        const matches = await backend.matches(journal.before)
        guard()
        if (!matches) {
          const restored = await backend.restore(journal.before)
          guard()
          if (!restored.ok) throw new Error(restored.error)
        }
      }
    }
    const backend = this.opts.backend
    const ends = this.opts.clock.now() + RECOVER_DEADLINE_MS
    const work = this.opts.queue.run(() => {
      guard()
      return this.bounded(recover(), Math.max(0, ends - this.opts.clock.now()))
    })
    try { return await this.bounded(work, RECOVER_DEADLINE_MS) }
    catch (error) {
      expired = true
      this.opts.logger.warn('Network recovery deadline reached', error)
      // Nothing was put back yet, so don't say it was.
      return [RECOVER_FAILED]
    }
  }

  private require(result: Result): void { if (!result.ok) throw new Error(result.error) }
  private live(): void { if (this.disposed) throw new Error('Network trial disposed') }
  private ours(current: Active): boolean { return !this.disposed && this.active === current && !current.finishing }
  private claim(current: Active): void { current.finishing = true; current.view.canKeep = false; this.stop() }
  private finish(current: Active): void {
    if (this.active !== current) return
    this.stop(); this.active = undefined; this.emit()
  }
  private stop(): void {
    if (this.tick !== undefined) this.opts.clock.clearInterval(this.tick)
    if (this.poll !== undefined) this.opts.clock.clearInterval(this.poll)
    this.tick = undefined; this.poll = undefined
  }
  private emit(): void { if (!this.disposed) this.deliver(this.listeners, (cb) => cb()) }
  private toast(text: string, tone: Toast['tone']): void {
    if (!this.disposed) this.deliver(this.toasts, (cb) => cb({ text, tone }))
  }
  private deliver<T>(listeners: Set<T>, invoke: (cb: T) => void): void {
    for (const cb of listeners) {
      try { invoke(cb) } catch (error) { this.opts.logger.warn('Network listener failed', error) }
    }
  }
  private write(journal: Journal): Promise<void> {
    return atomicWrite(this.opts.journalPath, JSON.stringify(journal) + '\n', undefined, this.io)
  }
  /** Deletes the journal after the change itself is done. A failure only matters at the next start-up, so log it. */
  private async forget(): Promise<void> {
    try { await this.remove() } catch (error) { this.opts.logger.warn('Network journal not deleted', error) }
  }
  private async remove(): Promise<void> {
    this.live()
    try { await this.io.unlink(this.opts.journalPath) } catch (error) { if (!missing(error)) throw error }
  }
  private async bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new Deadline())
      timer = this.opts.clock.setTimeout(cancel, ms)
      this.deadlines.set(timer, cancel)
    })
    try { return await Promise.race([work, deadline]) }
    finally { this.opts.clock.clearTimeout(timer); this.deadlines.delete(timer) }
  }
  dispose(): void {
    this.disposed = true; this.stop()
    for (const [timer, cancel] of this.deadlines) { this.opts.clock.clearTimeout(timer); cancel() }
    this.deadlines.clear(); this.listeners.clear(); this.toasts.clear()
  }
}

function isJournal(value: unknown): value is Journal {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<Journal>
  return journal.v === 1 && (journal.state === 'pending' || journal.state === 'saving') &&
    typeof journal.profileId === 'string' && !!journal.profileId && typeof journal.createdAt === 'string' &&
    Object.hasOwn(journal, 'before') && journal.before !== undefined &&
    (journal.checkpoint === undefined || typeof journal.checkpoint === 'string') &&
    (journal.device === undefined || typeof journal.device === 'string')
}
