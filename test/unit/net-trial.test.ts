import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NET_RESTORE_FAILED, type IpConfig, type NetProfile, type Result } from '@shared/system-types'
import { IpTrial, APPLY_DEADLINE_MS, RECOVER_DEADLINE_MS, CHECKPOINT_SEC, type TrialBackend } from '../../src/main/system/net/IpTrial'
import { NetQueue } from '../../src/main/system/net/NetQueue'
import { memoryJournal } from '../../src/main/system/net/MemoryJournal'
import { APPLY_FAILED, NETWORK_BUSY, NOT_ALLOWED, UserFacingError } from '../../src/main/system/net/texts'
import { atomicWrite } from '../../src/main/settings/atomic'
import { runtime, delay } from '../../src/main/core/runtime'
import { silentLog } from '../../src/main/log/Logger'
import { deferred } from './helpers'

const good: IpConfig = { method: 'manual', address: '192.168.1.60', prefix: 24, gateway: '192.168.1.1', dns: { mode: 'router' } }
const before = { config: { method: 'auto', dns: { mode: 'auto' } } }
const path = 'net-trial.json'
const instances: IpTrial[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const trial of instances.splice(0)) trial.dispose(); vi.useRealTimers() })

function make(trialSec = 45, monotonic = () => Date.now()) {
  const profile: NetProfile = { id: 'wired', kind: 'ethernet', name: 'Cable', active: true, editable: true,
    live: { address: good.method === 'manual' ? good.address : '', prefix: 24, dns: ['192.168.1.1'] } }
  const backend = {
    profiles: vi.fn(async () => [profile]), snapshot: vi.fn(async () => before), begin: vi.fn(async () => 'cp'),
    applyTemporary: vi.fn(async (): Promise<Result> => ({ ok: true })),
    checks: vi.fn((_cfg: IpConfig) => ({ router: async () => { await delay(1000); return true },
      dns: async () => { await delay(1500); return true }, internet: async () => { await delay(2000); return true } })),
    commit: vi.fn(async (): Promise<'ok' | 'gone'> => 'ok'), save: vi.fn(async (): Promise<Result> => ({ ok: true })),
    unsaved: vi.fn(async () => false), rollback: vi.fn(async (): Promise<'ok' | 'gone'> => 'ok'),
    alive: vi.fn(async () => true), restore: vi.fn(async (_snapshot: unknown): Promise<Result> => ({ ok: true })),
    clearCheckpoints: vi.fn(async () => {}),
    matches: vi.fn(async () => false), resetAll: vi.fn(async (): Promise<Result> => ({ ok: true })),
  } satisfies TrialBackend
  const io = memoryJournal(), queue = new NetQueue(), logger = { ...silentLog, warn: vi.fn(), error: vi.fn() }
  const trial = new IpTrial({ backend, queue, clock: runtime, fs: io, journalPath: path, logger, trialSec, monotonic })
  instances.push(trial)
  const toast = vi.fn(), event = vi.fn()
  trial.onToast(toast); trial.on('trial', event)
  const journal = () => io.readFile(path, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>)
  const write = (state: 'pending' | 'saving', extra: Record<string, unknown> = {}) => atomicWrite(path,
    JSON.stringify({ v: 1, state, profileId: 'wired', before, createdAt: '2026-11-12', ...extra }), undefined, io)
  return { trial, backend, io, queue, logger, profile, toast, event, journal, write }
}
async function ready(ctx: ReturnType<typeof make>) {
  expect(await ctx.trial.apply('wired', good)).toEqual({ ok: true })
  await vi.advanceTimersByTimeAsync(2000)
}

describe('NetQueue', () => {
  it('runs in order, never overlaps, and continues after a rejection', async () => {
    const queue = new NetQueue(), gate = deferred<void>(), calls: number[] = []
    const first = queue.run(async () => { calls.push(1); await gate.promise; throw new Error('failed') })
    const rejection = expect(first).rejects.toThrow('failed')
    const second = queue.run(async () => { calls.push(2); return 42 })
    await Promise.resolve(); expect(calls).toEqual([1])
    gate.resolve(); await rejection
    expect(await second).toBe(42); expect(calls).toEqual([1, 2])
  })
})

describe('IpTrial lifecycle', () => {
  it('writes pending before begin, records the checkpoint before applying, and exposes applying', async () => {
    const ctx = make(), activation = deferred<Result>()
    ctx.backend.begin.mockImplementation(async () => {
      expect(await ctx.journal()).toMatchObject({ state: 'pending', before })
      expect(await ctx.journal()).not.toHaveProperty('checkpoint')
      return 'cp'
    })
    ctx.backend.applyTemporary.mockImplementation(async () => {
      expect(await ctx.journal()).toMatchObject({ checkpoint: 'cp' })
      expect(await ctx.trial.trial()).toMatchObject({ phase: 'applying', canKeep: false })
      activation.resolve({ ok: true }); return activation.promise
    })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: true })
    expect(ctx.backend.begin).toHaveBeenCalledWith('wired', 90)
    expect(ctx.backend.applyTemporary).toHaveBeenCalledWith('wired', good, 30_000)
    expect(await ctx.trial.trial()).toMatchObject({ phase: 'checking', secondsLeft: 45 })
  })
  it('keeps by writing saving, committing then saving, deletes the journal and toasts', async () => {
    const ctx = make(); await ready(ctx)
    ctx.backend.commit.mockImplementation(async () => {
      expect(await ctx.journal()).toMatchObject({ state: 'saving' }); return 'ok'
    })
    expect(await ctx.trial.trial()).toMatchObject({ phase: 'ready', canKeep: true, secondsLeft: 43 })
    expect(await ctx.trial.keep()).toEqual({ ok: true })
    expect(ctx.backend.commit.mock.invocationCallOrder[0]).toBeLessThan(ctx.backend.save.mock.invocationCallOrder[0]!)
    expect(ctx.backend.restore).not.toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith({ text: 'New network settings saved.', tone: 'ok' })
    expect(await ctx.trial.trial()).toBeNull(); expect(ctx.trial.pending()).toBe(false)
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.advanceTimersByTimeAsync(100_000)
    expect(ctx.backend.rollback).not.toHaveBeenCalled()
  })
  it('expires exactly at zero and emits null with the warning toast', async () => {
    const ctx = make(3); await ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(2999)
    expect(await ctx.trial.trial()).toMatchObject({ secondsLeft: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.backend.rollback).toHaveBeenCalledWith('cp'); expect(await ctx.trial.trial()).toBeNull()
    expect(ctx.toast).toHaveBeenCalledWith({ text: 'No answer, so MediaOS put the old network settings back.', tone: 'warn' })
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('puts the old settings back on Back, with an info toast; another revert is harmless', async () => {
    const ctx = make(); await ready(ctx)
    expect(await ctx.trial.revert()).toEqual({ ok: true }); expect(await ctx.trial.revert()).toEqual({ ok: true })
    expect(ctx.backend.rollback).toHaveBeenCalledTimes(1)
    expect(ctx.toast).toHaveBeenCalledWith({ text: 'The old network settings are back.', tone: 'info' })
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['gone', 'throw'] as const)('falls back to restore when rollback is %s', async (mode) => {
    const ctx = make(); await ready(ctx)
    if (mode === 'gone') ctx.backend.rollback.mockResolvedValue('gone')
    else ctx.backend.rollback.mockRejectedValue(new Error('lost checkpoint'))
    expect(await ctx.trial.revert()).toEqual({ ok: true })
    expect(ctx.backend.restore).toHaveBeenCalledWith(before)
  })
  it('returns an activation error after immediate rollback', async () => {
    const ctx = make(); ctx.backend.applyTemporary.mockResolvedValue({ ok: false, error: 'Address already used.' })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: 'Address already used.' })
    expect(ctx.backend.rollback).toHaveBeenCalledWith('cp'); expect(await ctx.trial.trial()).toBeNull()
    expect(ctx.backend.checks).not.toHaveBeenCalled(); await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    { error: new UserFacingError(NOT_ALLOWED), restored: true, expected: NOT_ALLOWED },
    { error: new Error('secret diagnostic'), restored: true, expected: APPLY_FAILED },
    { error: new UserFacingError(NOT_ALLOWED), restored: false, expected: NET_RESTORE_FAILED },
  ])('preserves only classified begin errors after successful restoration ($restored)', async ({ error, restored, expected }) => {
    const ctx = make()
    ctx.backend.begin.mockRejectedValue(error)
    if (!restored) ctx.backend.restore.mockResolvedValue({ ok: false, error: 'restore failed' })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: expected })
    expect(ctx.backend.restore).toHaveBeenCalledWith(before)
    expect(ctx.backend.applyTemporary).not.toHaveBeenCalled()
    expect(await ctx.trial.trial()).toBeNull()
  })
  it('bounds a stuck begin and refuses applies without queuing until the monotonic cooldown ends', async () => {
    let elapsed = 0
    const ctx = make(45, () => elapsed)
    ctx.backend.begin.mockReturnValueOnce(new Promise<string>(() => {}))
    const applying = ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(await ctx.trial.trial()).toMatchObject({ phase: 'applying' })
    expect(ctx.backend.restore).not.toHaveBeenCalled()
    elapsed = 20_000
    await vi.advanceTimersByTimeAsync(1)
    expect(await applying).toEqual({ ok: false, error: APPLY_FAILED })
    expect(ctx.backend.restore).toHaveBeenCalledWith(before)
    expect(ctx.backend.applyTemporary).not.toHaveBeenCalled()
    expect(await ctx.trial.trial()).toBeNull(); expect(ctx.trial.pending()).toBe(false)
    expect(await ctx.queue.run(async () => 42)).toBe(42)
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(vi.getTimerCount()).toBe(0)
    const queueRun = vi.spyOn(ctx.queue, 'run')
    vi.setSystemTime(Date.now() + 600_000)
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: NETWORK_BUSY })
    elapsed += (CHECKPOINT_SEC + 30) * 1000 - 1
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: NETWORK_BUSY })
    expect(queueRun).not.toHaveBeenCalled()
    expect(ctx.backend.begin).toHaveBeenCalledOnce()
    elapsed++
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: true })
  })
  it.each(['ok', 'gone', 'throw', 'reject'] as const)('cleans up a late begin (%s) without rolling back a reset', async (mode) => {
    const ctx = make(), beginning = deferred<string>()
    ctx.backend.begin.mockReturnValue(beginning.promise)
    const applying = ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await applying).toEqual({ ok: false, error: APPLY_FAILED })
    expect(await ctx.trial.resetAll()).toEqual({ ok: true })
    if (mode === 'throw') ctx.backend.commit.mockRejectedValue(new Error('cleanup failed'))
    else if (mode === 'gone') ctx.backend.commit.mockResolvedValue('gone')
    if (mode === 'reject') beginning.reject(new Error('late refusal'))
    else beginning.resolve('late-checkpoint')
    await vi.advanceTimersByTimeAsync(0)
    if (mode === 'reject') expect(ctx.backend.commit).not.toHaveBeenCalled()
    else expect(ctx.backend.commit).toHaveBeenCalledWith('late-checkpoint')
    if (mode === 'throw') expect(ctx.logger.warn).toHaveBeenCalledWith('Late network checkpoint not cleared', expect.any(Error))
    expect(ctx.backend.rollback).not.toHaveBeenCalled()
    expect(ctx.backend.restore).toHaveBeenCalledOnce()
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: NETWORK_BUSY })
  })
  it('does not impose the cooldown on a normal begin error', async () => {
    const ctx = make()
    ctx.backend.begin.mockRejectedValueOnce(new UserFacingError(NOT_ALLOWED))
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: NOT_ALLOWED })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: true })
  })
  // Saying "went back to its previous settings" when that failed would send the user the wrong way.
  it.each(['result', 'throw'] as const)('says the old settings are not back when activation (%s) and restore fail', async (mode) => {
    const ctx = make()
    if (mode === 'result') ctx.backend.applyTemporary.mockResolvedValue({ ok: false, error: 'Address already used.' })
    else ctx.backend.applyTemporary.mockRejectedValue(new Error('Failed'))
    ctx.backend.rollback.mockRejectedValue(new Error('gone')); ctx.backend.restore.mockResolvedValue({ ok: false, error: 'Failed' })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false,
      error: "Couldn't put the old network settings back. Hold Home and choose Reset network to automatic." })
    expect(await ctx.trial.trial()).toBeNull(); expect(await ctx.journal()).toMatchObject({ state: 'pending' })
  })
  it.each(['result', 'throw'] as const)('lets a queued revert own cleanup when activation fails by %s', async (mode) => {
    const ctx = make(), activation = deferred<Result>()
    ctx.backend.applyTemporary.mockReturnValue(activation.promise)
    const apply = ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(0)
    expect(await ctx.trial.trial()).toMatchObject({ phase: 'applying' })
    const revert = ctx.trial.revert()
    if (mode === 'result') activation.resolve({ ok: false, error: 'Failed' })
    else activation.reject(new Error('Failed'))
    expect(await apply).toMatchObject({ ok: false }); expect(await revert).toEqual({ ok: true })
    expect(ctx.backend.rollback).toHaveBeenCalledOnce(); expect(ctx.toast).toHaveBeenCalledTimes(1)
    expect(await ctx.trial.trial()).toBeNull()
  })
  it('bounds activation at 30 seconds and ignores its late result', async () => {
    const ctx = make(), activation = deferred<Result>()
    ctx.backend.applyTemporary.mockReturnValue(activation.promise); ctx.backend.rollback.mockResolvedValue('gone')
    const result = ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(APPLY_DEADLINE_MS - 1); expect(ctx.backend.rollback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("Those settings didn't work") })
    expect(ctx.backend.restore).toHaveBeenCalledWith(before)
    activation.resolve({ ok: true }); await vi.advanceTimersByTimeAsync(0)
    expect(await ctx.trial.trial()).toBeNull(); expect(ctx.backend.checks).not.toHaveBeenCalled()
  })
  it('rejects invalid configurations before calling the backend and refuses simultaneous applies', async () => {
    const ctx = make()
    expect(await ctx.trial.apply('wired', { ...good, address: '' } as IpConfig)).toMatchObject({ ok: false })
    expect(ctx.backend.profiles).not.toHaveBeenCalled()
    const first = ctx.trial.apply('wired', good)
    expect(ctx.trial.pending()).toBe(true)
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false,
      error: 'Another network change is still waiting. Keep it or put it back first.' })
    await first
    expect(await ctx.trial.apply('wired', good)).toMatchObject({ ok: false })
  })
  it.each(['missing', 'inactive', 'unmanaged'] as const)('refuses a %s profile before snapshot', async (mode) => {
    const ctx = make()
    if (mode === 'missing') ctx.backend.profiles.mockResolvedValue([])
    if (mode === 'inactive') ctx.profile.active = false
    if (mode === 'unmanaged') { ctx.profile.editable = false; ctx.profile.why = 'Managed elsewhere.' }
    const errors = { missing: "That network isn't saved any more. Go back and choose it again.",
      inactive: 'Connect to Cable first, then change its IP settings.', unmanaged: 'Managed elsewhere.' }
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: false, error: errors[mode] })
    expect(ctx.backend.snapshot).not.toHaveBeenCalled(); expect(ctx.trial.pending()).toBe(false)
  })
  it('refuses Keep while checking, before the minimum time, and without an address', async () => {
    const ctx = make(); await ctx.trial.apply('wired', good)
    expect(await ctx.trial.keep()).toEqual({ ok: false, error: 'Wait until the checks finish.' })
    await vi.advanceTimersByTimeAsync(1999)
    expect(await ctx.trial.keep()).toMatchObject({ ok: false })
    const fast = make()
    fast.backend.checks.mockReturnValue({ router: async () => true, dns: async () => true, internet: async () => true })
    await fast.trial.apply('wired', good); await vi.advanceTimersByTimeAsync(0)
    expect(await fast.trial.trial()).toMatchObject({ phase: 'ready', canKeep: false })
    expect(await fast.trial.keep()).toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await fast.trial.keep()).toEqual({ ok: true })
    const noAddress = make(); noAddress.profile.live = undefined; await ready(noAddress)
    expect(await noAddress.trial.trial()).toMatchObject({ canKeep: false })
    expect(await noAddress.trial.keep()).toMatchObject({ ok: false })
  })
  it('refuses Keep after the actual deadline even if its timer has not fired', async () => {
    const ctx = make(3); await ready(ctx)
    vi.setSystemTime(Date.now() + 1001)
    expect(await ctx.trial.keep()).toEqual({ ok: false,
      error: "There's no network change waiting. The old settings may already be back." })
    expect(ctx.backend.commit).not.toHaveBeenCalled()
  })
  it('refuses a failed router but allows failed DNS and internet, including thrown checks', async () => {
    const ctx = make()
    ctx.backend.checks.mockReturnValue({ router: async () => false, dns: async () => true, internet: async () => true })
    await ready(ctx)
    expect(await ctx.trial.keep()).toEqual({ ok: false,
      error: "These settings can't reach the router, so they can't be kept. Put back the old settings." })
    const lan = make()
    lan.backend.checks.mockReturnValue({ router: async () => true, dns: async () => { throw new Error('DNS down') },
      internet: async () => false })
    await ready(lan)
    expect(await lan.trial.trial()).toMatchObject({ dns: 'failed', internet: 'failed', canKeep: true })
    expect(await lan.trial.keep()).toEqual({ ok: true })
  })
  it.each([false, true])('handles a lost checkpoint with matches=%s', async (matches) => {
    const ctx = make(); await ready(ctx)
    ctx.backend.alive.mockResolvedValue(false); ctx.backend.matches.mockResolvedValue(matches)
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctx.backend.restore).toHaveBeenCalledTimes(matches ? 0 : 1)
    expect(ctx.backend.rollback).not.toHaveBeenCalled(); expect(await ctx.trial.trial()).toBeNull()
    expect(ctx.toast).toHaveBeenCalledWith({
      text: 'The network restarted before you chose, so MediaOS put the old settings back.', tone: 'warn' })
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([false, true])('handles commit gone with matches=%s', async (matches) => {
    const ctx = make(); await ready(ctx)
    ctx.backend.commit.mockResolvedValue('gone'); ctx.backend.matches.mockResolvedValue(matches)
    expect(await ctx.trial.keep()).toEqual({ ok: false,
      error: "There's no network change waiting. The old settings may already be back." })
    expect(ctx.backend.restore).toHaveBeenCalledTimes(matches ? 0 : 1)
    expect(ctx.backend.save).not.toHaveBeenCalled(); expect(await ctx.trial.trial()).toBeNull()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['result', 'throw'] as const)('restores if save fails by %s', async (mode) => {
    const ctx = make(); await ready(ctx)
    if (mode === 'result') ctx.backend.save.mockResolvedValue({ ok: false, error: 'Disk full' })
    else ctx.backend.save.mockRejectedValue(new Error('Disk full'))
    expect(await ctx.trial.keep()).toEqual({ ok: false, error: "Couldn't save the new settings, so the old ones are back." })
    expect(ctx.backend.restore).toHaveBeenCalledWith(before); expect(await ctx.trial.trial()).toBeNull()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('clears the trial but preserves its journal when rollback and restore fail', async () => {
    const ctx = make(); await ready(ctx)
    ctx.backend.rollback.mockRejectedValue(new Error('gone')); ctx.backend.restore.mockResolvedValue({ ok: false, error: 'Failed' })
    expect(await ctx.trial.revert()).toEqual({ ok: false,
      error: "Couldn't put the old network settings back. Hold Home and choose Reset network to automatic." })
    expect(await ctx.trial.trial()).toBeNull(); expect(await ctx.journal()).toMatchObject({ state: 'pending' })
  })
  it('leaves the toast to the caller when Put back fails, but toasts a failed expiry', async () => {
    const ctx = make(3); await ready(ctx)
    ctx.backend.rollback.mockRejectedValue(new Error('gone')); ctx.backend.restore.mockResolvedValue({ ok: false, error: 'Failed' })
    expect(await ctx.trial.revert()).toMatchObject({ ok: false }); expect(ctx.toast).not.toHaveBeenCalled()
    const again = make(3); await again.trial.apply('wired', good)
    again.backend.rollback.mockRejectedValue(new Error('gone')); again.backend.restore.mockResolvedValue({ ok: false, error: 'Failed' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(again.toast).toHaveBeenCalledWith({ text: NET_RESTORE_FAILED, tone: 'error' })
  })
  it('reports success when the old settings are back but the journal cannot be deleted', async () => {
    const ctx = make(); await ready(ctx)
    vi.spyOn(ctx.io, 'unlink').mockRejectedValue(Object.assign(new Error('Busy'), { code: 'EBUSY' }))
    expect(await ctx.trial.revert()).toEqual({ ok: true })
    expect(ctx.backend.restore).not.toHaveBeenCalled(); expect(ctx.logger.warn).toHaveBeenCalled()
    expect(ctx.toast).toHaveBeenCalledWith({ text: 'The old network settings are back.', tone: 'info' })
  })
  it('does not claim the old settings are back when activation fails while Put back waits', async () => {
    const ctx = make(), activation = deferred<Result>()
    ctx.backend.applyTemporary.mockReturnValue(activation.promise)
    const apply = ctx.trial.apply('wired', good)
    await vi.advanceTimersByTimeAsync(0)
    const revert = ctx.trial.revert(); activation.reject(new Error('Failed'))
    expect(await apply).toEqual({ ok: false, error: "Those settings didn't work. Check the address and router, then try again." })
    expect(await revert).toEqual({ ok: true })
  })
  it('keeps counting down evenly when the wall clock jumps', async () => {
    let jump = 0
    const ctx = make(45, () => Date.now() - jump); await ready(ctx)
    expect(await ctx.trial.trial()).toMatchObject({ secondsLeft: 43 })
    jump = 3_600_000; vi.setSystemTime(Date.now() + jump)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await ctx.trial.trial()).toMatchObject({ secondsLeft: 42 })
    expect(await ctx.trial.keep()).toEqual({ ok: true })
  })
  it.each([false, true])('clears checkpoints after every successful reset (cleanup fails: %s)', async (fails) => {
    const ctx = make()
    if (fails) ctx.backend.clearCheckpoints.mockRejectedValue(new Error('clear failed'))
    expect(await ctx.trial.resetAll()).toEqual({ ok: true })
    expect(ctx.backend.clearCheckpoints).toHaveBeenCalledOnce()
    expect(ctx.backend.resetAll.mock.invocationCallOrder[0]).toBeLessThan(ctx.backend.clearCheckpoints.mock.invocationCallOrder[0]!)
    if (fails) expect(ctx.logger.warn).toHaveBeenCalledWith('Network checkpoints not cleared after reset', expect.any(Error))
    expect(await ctx.trial.resetAll()).toEqual({ ok: true })
    expect(ctx.backend.clearCheckpoints).toHaveBeenCalledTimes(2)
  })
  it('leaves checkpoints alone when reset fails', async () => {
    const ctx = make()
    ctx.backend.resetAll.mockResolvedValue({ ok: false, error: 'Reset failed' })
    expect(await ctx.trial.resetAll()).toEqual({ ok: false, error: 'Reset failed' })
    expect(ctx.backend.clearCheckpoints).not.toHaveBeenCalled()
  })
  it('says the reset failed without sending the user back to Reset', async () => {
    const ctx = make(); ctx.backend.resetAll.mockRejectedValue(new Error('Failed'))
    expect(await ctx.trial.resetAll()).toEqual({ ok: false,
      error: "Couldn't set the network back to automatic. Switch the box off and on again, then try again." })
  })
  it('allows only one finisher while Keep waits, even after the deadline', async () => {
    const ctx = make(3); await ready(ctx)
    const saved = deferred<Result>(); ctx.backend.save.mockReturnValue(saved.promise)
    const keep = ctx.trial.keep(), revert = ctx.trial.revert()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(ctx.backend.rollback).not.toHaveBeenCalled()
    saved.resolve({ ok: true }); expect(await keep).toEqual({ ok: true }); await revert
    expect(ctx.backend.commit).toHaveBeenCalledOnce(); expect(ctx.toast).toHaveBeenCalledTimes(1)
  })
  it('ignores a lost-checkpoint response after a revert has claimed the trial', async () => {
    const ctx = make(), alive = deferred<boolean>(); await ready(ctx)
    ctx.backend.alive.mockReturnValue(alive.promise)
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctx.backend.alive).toHaveBeenCalledOnce()
    const revert = ctx.trial.revert(); alive.resolve(false)
    expect(await revert).toEqual({ ok: true })
    expect(ctx.backend.restore).not.toHaveBeenCalled(); expect(ctx.backend.rollback).toHaveBeenCalledOnce()
    expect(ctx.toast).toHaveBeenCalledTimes(1)
    expect(ctx.toast).toHaveBeenCalledWith({ text: 'The old network settings are back.', tone: 'info' })
  })
  it('blocks a new apply until reset has finished, including its initial await', async () => {
    const ctx = make(), resetting = deferred<Result>()
    ctx.backend.resetAll.mockReturnValue(resetting.promise)
    const reset = ctx.trial.resetAll()
    expect(await ctx.trial.apply('wired', good)).toMatchObject({ ok: false })
    expect(ctx.backend.profiles).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(await ctx.trial.apply('wired', good)).toMatchObject({ ok: false })
    resetting.resolve({ ok: true }); expect(await reset).toEqual({ ok: true })
    expect(await ctx.trial.apply('wired', good)).toEqual({ ok: true })
  })
  it('reverts before resetAll and removes even a journal left by a failed revert', async () => {
    const ctx = make(); await ready(ctx)
    expect(await ctx.trial.resetAll()).toEqual({ ok: true })
    expect(ctx.backend.rollback.mock.invocationCallOrder[0]).toBeLessThan(ctx.backend.resetAll.mock.invocationCallOrder[0]!)
    expect(await ctx.trial.trial()).toBeNull()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
    await ctx.write('pending'); expect(await ctx.trial.resetAll()).toEqual({ ok: true })
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('ignores late checks belonging to an old trial', async () => {
    const ctx = make(), old = deferred<boolean>()
    ctx.backend.checks.mockReturnValueOnce({ router: () => old.promise, dns: () => old.promise, internet: () => old.promise })
    await ctx.trial.apply('wired', good); await ctx.trial.revert()
    await ctx.trial.apply('wired', good)
    const events = ctx.event.mock.calls.length
    old.resolve(false); await vi.advanceTimersByTimeAsync(0)
    expect(ctx.event).toHaveBeenCalledTimes(events)
    expect(await ctx.trial.trial()).toMatchObject({ router: 'checking', dns: 'checking', internet: 'checking' })
  })
  it('dispose cancels every owned timer and suppresses events from late work', async () => {
    const ctx = make(), checks = deferred<boolean>()
    ctx.backend.checks.mockReturnValue({ router: () => checks.promise, dns: () => checks.promise, internet: () => checks.promise })
    await ctx.trial.apply('wired', good)
    const events = ctx.event.mock.calls.length
    ctx.trial.dispose(); expect(vi.getTimerCount()).toBe(0)
    checks.resolve(true); await vi.advanceTimersByTimeAsync(100_000)
    expect(ctx.event).toHaveBeenCalledTimes(events); expect(ctx.toast).not.toHaveBeenCalled()
    expect(ctx.backend.rollback).not.toHaveBeenCalled(); expect(ctx.backend.alive).not.toHaveBeenCalled()
  })
})

describe('IpTrial journal recovery', () => {
  it('does nothing when the journal is missing', async () => {
    const ctx = make(); expect(await ctx.trial.recoverPending()).toEqual([])
    expect(ctx.backend.matches).not.toHaveBeenCalled(); expect(ctx.backend.alive).not.toHaveBeenCalled()
  })
  it.each(['junk', '{}', '{"v":2}', '{"v":1,"state":"pending","profileId":1}'])('removes invalid journal %s', async (raw) => {
    const ctx = make(); await atomicWrite(path, raw, undefined, ctx.io)
    expect(await ctx.trial.recoverPending()).toEqual([]); expect(ctx.logger.warn).toHaveBeenCalled()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' }); expect(ctx.backend.matches).not.toHaveBeenCalled()
  })
  it('logs and removes an unreadable journal', async () => {
    const ctx = make(); await ctx.write('pending')
    vi.spyOn(ctx.io, 'readFile').mockRejectedValueOnce(Object.assign(new Error('Unreadable'), { code: 'EACCES' }))
    expect(await ctx.trial.recoverPending()).toEqual([]); expect(ctx.logger.warn).toHaveBeenCalled()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rolls back a live pending checkpoint', async () => {
    const ctx = make(); await ctx.write('pending', { checkpoint: 'cp' })
    expect(await ctx.trial.recoverPending()).toEqual([
      "The last network change wasn't confirmed, so MediaOS put the old settings back."])
    expect(ctx.backend.rollback).toHaveBeenCalledWith('cp'); expect(ctx.backend.restore).not.toHaveBeenCalled()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([false, true])('recovers missing checkpoints with matches=%s', async (matches) => {
    const ctx = make(); await ctx.write('pending', { checkpoint: 'cp' })
    ctx.backend.alive.mockResolvedValue(false); ctx.backend.matches.mockResolvedValue(matches)
    expect(await ctx.trial.recoverPending()).toEqual([
      "The last network change wasn't confirmed, so MediaOS put the old settings back."])
    expect(ctx.backend.restore).toHaveBeenCalledTimes(matches ? 0 : 1); expect(ctx.backend.rollback).not.toHaveBeenCalled()
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restores a pending journal without a checkpoint, and one which disappears during rollback', async () => {
    const ctx = make(); await ctx.write('pending'); await ctx.trial.recoverPending()
    expect(ctx.backend.restore).toHaveBeenCalledWith(before); expect(ctx.backend.alive).not.toHaveBeenCalled()
    await ctx.write('pending', { checkpoint: 'cp' }); ctx.backend.rollback.mockResolvedValue('gone')
    await ctx.trial.recoverPending(); expect(ctx.backend.restore).toHaveBeenCalledTimes(2)
  })
  // Keep was pressed: new settings still live (saved or not) need no notice; only the old ones coming back does.
  const savingCases = [[true, false], [true, true], [false, false], [false, true]]
  it.each(savingCases)('recovers saving: unsaved=%s, matches=%s', async (unsaved, matches) => {
    const ctx = make(); await ctx.write('saving')
    ctx.backend.unsaved.mockResolvedValue(unsaved!); ctx.backend.matches.mockResolvedValue(matches!)
    expect(await ctx.trial.recoverPending()).toEqual(matches ? [
      "The last network change wasn't saved, so the old settings are back."] : [])
    expect(ctx.backend.save).toHaveBeenCalledTimes(unsaved && !matches ? 1 : 0)
    expect(ctx.backend.restore).not.toHaveBeenCalled(); await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('logs backend failures and preserves the journal', async () => {
    const ctx = make(); await ctx.write('pending')
    ctx.backend.matches.mockRejectedValue(new Error('Backend stopped'))
    expect(await ctx.trial.recoverPending()).toEqual([
      "Couldn't check the last network change. If the box is offline, hold Home and choose Reset network to automatic."])
    expect(ctx.logger.warn).toHaveBeenCalled(); expect(await ctx.journal()).toMatchObject({ state: 'pending' })
  })
  it('ends a still-running checkpoint before saving a confirmed change, without a notice', async () => {
    const ctx = make(); await ctx.write('saving', { checkpoint: 'cp' }); ctx.backend.unsaved.mockResolvedValue(true)
    expect(await ctx.trial.recoverPending()).toEqual([])
    expect(ctx.backend.commit).toHaveBeenCalledWith('cp')
    expect(ctx.backend.commit.mock.invocationCallOrder[0]).toBeLessThan(ctx.backend.save.mock.invocationCallOrder[0]!)
    await expect(ctx.journal()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('says a confirmed change was not saved when its checkpoint already put the old settings back', async () => {
    const ctx = make(); await ctx.write('saving', { checkpoint: 'cp' })
    ctx.backend.commit.mockResolvedValue('gone'); ctx.backend.matches.mockResolvedValue(true)
    expect(await ctx.trial.recoverPending()).toEqual(["The last network change wasn't saved, so the old settings are back."])
    expect(ctx.backend.save).not.toHaveBeenCalled()
  })
  it('preserves the saving journal if finishing the confirmed save fails', async () => {
    const ctx = make(); await ctx.write('saving')
    ctx.backend.unsaved.mockResolvedValue(true); ctx.backend.save.mockResolvedValue({ ok: false, error: 'Disk full' })
    expect(await ctx.trial.recoverPending()).toEqual([
      "Couldn't check the last network change. If the box is offline, hold Home and choose Reset network to automatic."])
    expect(await ctx.journal()).toMatchObject({ state: 'saving' }); expect(ctx.logger.warn).toHaveBeenCalled()
  })
  it('bounds recovery, frees the queue and leaves the journal untouched by late work', async () => {
    const ctx = make(), matches = deferred<boolean>(); await ctx.write('pending')
    ctx.backend.matches.mockReturnValue(matches.promise)
    const recovery = ctx.trial.recoverPending()
    await vi.advanceTimersByTimeAsync(RECOVER_DEADLINE_MS)
    expect(await recovery).toEqual([
      "Couldn't check the last network change. If the box is offline, hold Home and choose Reset network to automatic."])
    expect(await ctx.queue.run(async () => 42)).toBe(42)
    matches.resolve(false); await vi.advanceTimersByTimeAsync(0)
    expect(ctx.backend.restore).not.toHaveBeenCalled(); expect(await ctx.journal()).toMatchObject({ state: 'pending' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
