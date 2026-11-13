import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings-schema'
import type { UpdateInfo } from '@shared/system-types'
import { UpdateScheduler, updateStartMinute } from '../../src/main/core/UpdateScheduler'
import { runtime } from '../../src/main/core/runtime'
import { createMockSystem } from '../../src/main/system/mock/MockSystemServices'
import { deferred } from './helpers'

afterEach(() => vi.useRealTimers())
const local = (hour: number, minute: number, day = 13) => new Date(2026, 10, day, hour, minute).getTime()
function make(start = local(5, 25)) {
  vi.useFakeTimers(); vi.setSystemTime(start)
  const settings = defaultSettings()
  const state = { idle: true, screenOff: false, shell: true }
  const info: UpdateInfo = { configured: true, current: '0.1.0' }
  const system = createMockSystem({ delayMs: 0 })
  const status = vi.spyOn(system.updates, 'status').mockImplementation(async () => ({ ...info }))
  const auto = vi.spyOn(system.updates, 'auto').mockResolvedValue({ ok: true })
  const trial = vi.spyOn(system.network, 'trial').mockResolvedValue(null)
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const scheduler = new UpdateScheduler({ settings: () => settings, state: () => state, system, logger, timers: runtime })
  return { settings, state, info, system, status, auto, trial, logger, scheduler,
    dispose: () => { scheduler.dispose(); system.dispose() } }
}

describe('overnight update scheduler', () => {
  it('runs once per local date inside the window and logs success without a toast', async () => {
    const ctx = make(), toast = vi.fn(); ctx.system.network.onToast(toast)
    try {
      await vi.advanceTimersByTimeAsync(5 * 60000)
      expect(ctx.auto).toHaveBeenCalledOnce()
      expect(ctx.logger.info).toHaveBeenCalledWith('Overnight update finished', { ok: true })
      await vi.advanceTimersByTimeAsync(25 * 60000)
      expect(ctx.auto).toHaveBeenCalledOnce(); expect(toast).not.toHaveBeenCalled()
      vi.setSystemTime(local(5, 25, 14)); await vi.advanceTimersByTimeAsync(5 * 60000)
      expect(ctx.auto).toHaveBeenCalledTimes(2)
    } finally { ctx.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([[3, 50], [5, 55], [6, 0], [12, 0], [0, 0]])('does not run outside the window (%s:%s)', async (h, m) => {
    const ctx = make(local(h!, m!))
    try { await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).not.toHaveBeenCalled() }
    finally { ctx.dispose() }
  })
  it('waits for the stable start minute for the date and device', async () => {
    const minute = updateStartMinute('2026-11-13', 'MediaOS')
    expect(minute).toBeGreaterThanOrEqual(240); expect(minute).toBeLessThan(330)
    expect(updateStartMinute('2026-11-13', 'MediaOS')).toBe(minute)
    expect(new Set(['TV', 'Den', 'Snug', 'Kitchen'].map((name) => updateStartMinute('2026-11-13', name))).size).toBeGreaterThan(1)
    const ctx = make(local(0, minute - 10))
    try {
      await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).toHaveBeenCalledOnce()
    } finally { ctx.dispose() }
  })
  it.each(['auto-off', 'unconfigured', 'running', 'app', 'player', 'trial', 'active'])(
    'does not attempt an update when %s and can try later', async (mode) => {
    const ctx = make()
    if (mode === 'auto-off') ctx.settings.updates.auto = false
    if (mode === 'unconfigured') ctx.info.configured = false
    if (mode === 'running') ctx.info.running = 'check'
    if (mode === 'app' || mode === 'player') ctx.state.shell = false
    if (mode === 'active') ctx.state.idle = false
    if (mode === 'trial') ctx.trial.mockResolvedValue({ profileId: 'wired', name: 'Wired', phase: 'checking', secondsLeft: 30,
      router: 'checking', dns: 'checking', internet: 'checking', canKeep: false })
    try {
      await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).not.toHaveBeenCalled()
      ctx.settings.updates.auto = true; ctx.info.configured = true; ctx.info.running = undefined
      ctx.state.shell = true; ctx.state.idle = true; ctx.trial.mockResolvedValue(null)
      await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).toHaveBeenCalledOnce()
    } finally { ctx.dispose() }
  })
  it('counts screen off as idle, while still requiring the shell', async () => {
    const ctx = make(); ctx.state.idle = false; ctx.state.screenOff = true
    try { await vi.advanceTimersByTimeAsync(5 * 60000); expect(ctx.auto).toHaveBeenCalledOnce() }
    finally { ctx.dispose() }
  })
  it.each(['result', 'throw'])('logs a failed attempt and does not retry that date (%s)', async (mode) => {
    const ctx = make()
    if (mode === 'throw') ctx.auto.mockRejectedValue(new Error('unexpected'))
    else ctx.auto.mockResolvedValue({ ok: false, error: 'Offline' })
    try {
      await vi.advanceTimersByTimeAsync(30 * 60000)
      expect(ctx.auto).toHaveBeenCalledOnce(); expect(ctx.logger.warn).toHaveBeenCalledOnce()
    } finally { ctx.dispose() }
  })
  it.each(['active', 'disabled', 'late', 'disposed'])(
    'rechecks eligibility after asynchronous status and trial reads (%s)', async (mode) => {
    const ctx = make(), pending = deferred<UpdateInfo>()
    ctx.status.mockReturnValue(pending.promise)
    try {
      await vi.advanceTimersByTimeAsync(5 * 60000)
      if (mode === 'active') ctx.state.idle = false
      if (mode === 'disabled') ctx.settings.updates.auto = false
      if (mode === 'late') vi.setSystemTime(local(6, 0))
      if (mode === 'disposed') ctx.scheduler.dispose()
      pending.resolve(ctx.info); await vi.advanceTimersByTimeAsync(0)
      expect(ctx.auto).not.toHaveBeenCalled()
    } finally { ctx.dispose() }
  })
  it('keeps just one consideration in flight and clears the timer on disposal', async () => {
    const ctx = make(), pending = deferred<UpdateInfo>(); ctx.status.mockReturnValue(pending.promise)
    await vi.advanceTimersByTimeAsync(15 * 60000)
    expect(ctx.status).toHaveBeenCalledOnce()
    ctx.dispose(); pending.resolve(ctx.info); await vi.advanceTimersByTimeAsync(0)
    expect(ctx.auto).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
})
