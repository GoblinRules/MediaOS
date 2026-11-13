import * as fs from 'node:fs/promises'
import type { Result, UpdateAction, UpdateInfo } from '@shared/system-types'
import type { SystemServices } from '../SystemServices'
import { silentLog, type Log } from '../../log/Logger'
import { UserFacingError } from '../net/texts'
import type { CommandRunner } from './CommandRunner'
import { parseUpdateState, plainReleaseNotes, releaseRepository, updateError } from './update-parse'

export interface UpdateFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  access(path: string): Promise<unknown>
}
const sourcesPath = '/etc/apt/sources.list.d/mediaos.sources'
const statePath = '/var/lib/mediaos-update/state.json'
const busy = 'An update is already running. Wait for it to finish.'
const notStarted = "The update didn't start. Restart the box and try again."
const timeoutMs: Record<UpdateAction, number> = { check: 180_000, apply: 2_000_000, auto: 2_000_000, rollback: 1_000_000 }
const fail = (error: string): Result => ({ ok: false, error })
/** Was this result written after `startedMs`? The script writes milliseconds; older scripts wrote whole seconds. */
const freshSince = (at: string, startedMs: number): boolean => {
  const written = Date.parse(at)
  return /\.\d/.test(at) ? written >= startedMs : Math.floor(written / 1000) >= Math.floor(startedMs / 1000)
}

/** All privileged work belongs to the fixed systemd units; this service only starts them and reads their result. */
export function createLinuxUpdates(opts: {
  runner: CommandRunner; appVersion: string; logger?: Log; fs?: UpdateFs; fetch?: typeof fetch; clock?: { now(): number }
}): SystemServices['updates'] & { dispose(): void } {
  const io = opts.fs ?? fs, logger = opts.logger ?? silentLog, transport = opts.fetch ?? fetch
  const clock = opts.clock ?? { now: Date.now }
  const listeners = new Set<() => void>(), notes = new Map<string, string>()
  const fetching = new Map<string, Promise<void>>()
  const disposal = new AbortController()
  let running: UpdateAction | undefined, disposed = false
  const changed = () => {
    for (const cb of listeners) {
      try { cb() } catch (error) { logger.warn('Update listener failed', error) }
    }
  }
  const readState = async () => {
    try { return parseUpdateState(await io.readFile(statePath, 'utf8'), logger) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        logger.warn('Update state could not be opened', error)
      }
      return {}
    }
  }
  const status = async (): Promise<UpdateInfo> => {
    const [state, configured] = await Promise.all([readState(), io.access(sourcesPath).then(() => true, () => false)])
    const current = state.current ?? opts.appVersion
    return {
      configured, current, available: state.available ?? undefined, previous: state.previous ?? undefined,
      skipped: state.skip ?? undefined, checkedAt: state.checkedAt ?? undefined,
      notes: state.available ? notes.get(state.available) : undefined, running,
      lastRun: state.lastRun ? { action: state.lastRun.action, ok: state.lastRun.ok, at: state.lastRun.at,
        ...(state.lastRun.ok ? {} : { error: updateError(state.lastRun.error, current) }) } : undefined,
    }
  }
  const run = async (action: UpdateAction): Promise<Result> => {
    if (running) return fail(busy)
    if (disposed) return fail(notStarted)
    running = action
    changed()
    try {
      const before = await status()
      if (disposed) return fail(notStarted)
      if (!before.configured && action !== 'rollback') return fail(updateError('not-set-up', before.current))
      const started = clock.now()
      let diagnostic: unknown
      try {
        diagnostic = await opts.runner.run('systemctl', ['--no-ask-password', 'start', `mediaos-update-${action}.service`],
          { timeoutMs: timeoutMs[action] })
      } catch (error) { diagnostic = error }
      const after = await status(), last = after.lastRun
      if (last?.action === action && freshSince(last.at, started)) {
        return last.ok ? { ok: true } : fail(last.error ?? updateError(undefined, after.current))
      }
      logger.warn('Update unit did not record a result', action, diagnostic)
      return fail(notStarted)
    } catch (error) {
      logger.warn('Update action failed', action, error)
      return fail(updateError(undefined, opts.appVersion))
    } finally { running = undefined; changed() }
  }
  const fetchNotes = async (version: string): Promise<void> => {
    if (notes.has(version) || disposed) return
    const pending = fetching.get(version)
    if (pending) return pending
    const work = (async () => {
      try {
        const repository = releaseRepository(await io.readFile(sourcesPath, 'utf8'))
        if (!repository) return
        const signal = AbortSignal.any([disposal.signal, AbortSignal.timeout(8000)])
        const response = await transport(
          `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/tags/v${version}`,
          { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MediaOS' }, signal, redirect: 'error' },
        )
        const limit = 256 * 1024
        if (response.status !== 200 || Number(response.headers.get('content-length')) > limit || !response.body) {
          await response.body?.cancel()
          throw new Error('Release notes response unavailable or too large')
        }
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let bytes = 0, text = ''
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > limit) throw new Error('Release notes response too large')
            text += decoder.decode(part.value, { stream: true })
          }
          text += decoder.decode()
        } finally { await reader.cancel(); reader.releaseLock() }
        const data: unknown = JSON.parse(text)
        const body = data !== null && typeof data === 'object' && 'body' in data ? data.body : undefined
        if (typeof body !== 'string') throw new Error('Release notes body missing')
        const plain = plainReleaseNotes(body)
        if (!plain) throw new Error('Release notes body empty')
        if (!disposed) notes.set(version, plain)
      } catch (error) { logger.debug('Release notes could not be fetched', error) }
    })()
    fetching.set(version, work)
    try { await work } finally { fetching.delete(version) }
  }
  return {
    status,
    check: async () => {
      const result = await run('check')
      if (!result.ok) throw new UserFacingError(result.error)
      const info = await status()
      if (info.available) await fetchNotes(info.available)
      return status()
    },
    apply: () => run('apply'), rollback: () => run('rollback'),
    auto: async () => {
      const result = await run('auto')
      if (!result.ok) logger.warn('Overnight update failed', result.error)
      return result
    },
    on: (_event, cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    dispose: () => { disposed = true; disposal.abort(); listeners.clear() },
  }
}
