import { describe, expect, it, vi } from 'vitest'
import type { UpdateAction } from '@shared/system-types'
import { createLinuxUpdates } from '../../src/main/system/linux/LinuxUpdates'
import { parseUpdateState, plainReleaseNotes, releaseRepository, updateError } from '../../src/main/system/linux/update-parse'
import type { CommandResult, CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { UserFacingError } from '../../src/main/system/net/texts'
import { deferred } from './helpers'

const now = Date.UTC(2026, 10, 13, 12, 0, 0, 900)
const at = new Date(Math.floor(now / 1000) * 1000).toISOString().replace('.000', '')
const github = 'URIs: https://github.com/GoblinRules/MediaOS/releases/latest/download/\nSuites: ./\n'
const success: CommandResult = { code: 0, stdout: '', stderr: '' }
function make() {
  const box = { configured: true, sources: github, state: '{}', available: '0.2.0' as string | undefined }
  const record = (action: UpdateAction, ok = true, error?: string, time = at) => {
    box.state = JSON.stringify({ current: '0.1.0', available: box.available, checkedAt: at,
      lastRun: { action, ok, error, at: time } })
  }
  const run = vi.fn<CommandRunner['run']>(async (_file, args) => {
    const action = args[2]!.replace('mediaos-update-', '').replace('.service', '') as UpdateAction
    record(action)
    return success
  })
  const runner: CommandRunner = { run, spawnLines: () => ({ kill() {} }) }
  const io = {
    access: vi.fn(async () => { if (!box.configured) throw new Error('absent') }),
    readFile: vi.fn(async (path: string, _encoding: 'utf8') => path.endsWith('state.json') ? box.state : box.sources),
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ body: '# New\n\n- Faster **home**' }))
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const updates = createLinuxUpdates({ runner, fs: io, fetch, logger, appVersion: '0.1.0', clock: { now: () => now } })
  return { box, record, run, io, fetch, logger, updates }
}

describe('update state and notes parsing', () => {
  it('reads good, partial and null fields and drops hostile versions independently', () => {
    expect(parseUpdateState(JSON.stringify({ current: '1.2.3~rc1+deb-2', available: '2.0', previous: '1.0',
      skip: '1.9', checkedAt: at, lastRun: { action: 'auto', ok: false, error: 'offline', at } }))).toMatchObject({
      current: '1.2.3~rc1+deb-2', available: '2.0', previous: '1.0', skip: '1.9', checkedAt: at,
      lastRun: { action: 'auto', ok: false, error: 'offline', at },
    })
    expect(parseUpdateState('{"current":null,"available":"2.0","lastRun":null}')).toMatchObject({ available: '2.0' })
    for (const current of ['../2', '<script>', '1;reboot', 'v2', '1'.repeat(65), 2, '', '1\n']) {
      expect(parseUpdateState(JSON.stringify({ current, available: '2.0' }))).toMatchObject({
        current: undefined, available: '2.0',
      })
    }
    expect(parseUpdateState('{"lastRun":{"action":"check","ok":null,"at":null}}').lastRun).toBeUndefined()
  })
  it('handles empty and broken files without throwing and warns for broken content', () => {
    const logger = make().logger
    expect(parseUpdateState('', logger)).toEqual({})
    expect(logger.warn).not.toHaveBeenCalled()
    for (const raw of ['{', 'null', '[]', '1']) expect(parseUpdateState(raw, logger)).toEqual({})
    expect(logger.warn).toHaveBeenCalledTimes(4)
  })
  it('turns headings, bullets, emphasis, links and HTML into bounded plain text', () => {
    expect(plainReleaseNotes('# Title\n\n* **Bold** and __more__ `code` [link](https://example.org)\n' +
      '- <b>HTML</b>\n\n\n\nDone')).toBe('Title\n\n• Bold and more code link\n• HTML\n\nDone')
    const long = plainReleaseNotes('word '.repeat(500))
    expect(long.length).toBeLessThanOrEqual(1500)
    expect(long).toMatch(/word…$/)
    expect(plainReleaseNotes('x'.repeat(1600))).toHaveLength(1500)
    expect(plainReleaseNotes('First\n\n# Second\n\nText')).toBe('First\n\nSecond\n\nText')
  })
  it('keeps HTML line breaks, nested link text and common entities readable', () => {
    expect(plainReleaseNotes('<p>One</p><p>Two<br/>Three</p>')).toBe('One\nTwo\nThree')
    expect(plainReleaseNotes('[![logo](a.png) Home](https://example.org) and ![pic](b.png)')).toBe('logo Home and pic')
    expect(plainReleaseNotes('Fish &amp; chips &lt;3 &quot;yes&quot; it&#39;s&nbsp;here &amp;lt;')).toBe(
      'Fish & chips <3 "yes" it\'s here &lt;')
    expect(plainReleaseNotes('Line   \nNext')).toBe('Line\nNext')
  })
  it.each(['[', '<', '[a', '![x](', ' '])('tidies a huge run of %j quickly', (piece) => {
    const started = performance.now()
    plainReleaseNotes(piece.repeat(256 * 1024 / piece.length))
    expect(performance.now() - started).toBeLessThan(500)
  })
  it.each(['latest/download/', 'latest/download', 'download/v0.2.0/', 'download/0.2.0'])('matches GitHub source %s', (path) => {
    expect(releaseRepository(`Types: deb\nURIs: https://github.com/owner.name/repo_name/releases/${path}\n`))
      .toEqual({ owner: 'owner.name', repo: 'repo_name' })
  })
  it.each(['https://example.org/owner/repo/releases/latest/download/',
    'http://github.com/owner/repo/releases/latest/download/', 'https://github.com/a/b/releases/download/v1/extra',
    'https://github.com/a/b/releases/latest/download/?token=secret',
    'https://github.com/a/b/releases/latest/download/ https://other.org/'])('rejects other sources: %s', (uri) => {
    expect(releaseRepository(`URIs: ${uri}\n`)).toBeUndefined()
  })
})

describe('Linux updates', () => {
  it.each([true, false])('checks and reads the recorded result, available: %s', async (available) => {
    const ctx = make()
    if (!available) ctx.box.available = undefined
    const events: (string | undefined)[] = []
    ctx.updates.on('changed', () => { events.push('changed') })
    const info = await ctx.updates.check()
    expect(info).toMatchObject({ configured: true, current: '0.1.0', available: ctx.box.available,
      checkedAt: at, lastRun: { action: 'check', ok: true, at } })
    expect(info.running).toBeUndefined()
    expect(info.lastRun?.error).toBeUndefined()
    expect(ctx.run).toHaveBeenCalledExactlyOnceWith('systemctl',
      ['--no-ask-password', 'start', 'mediaos-update-check.service'], { timeoutMs: 180000 })
    expect(events).toEqual(['changed', 'changed'])
    expect(ctx.fetch).toHaveBeenCalledTimes(available ? 1 : 0)
    ctx.updates.dispose()
  })
  it.each([
    ['not-set-up', "Updates aren't set up on this box. It has MediaOS 0.1.0."],
    ['offline', "Can't reach the MediaOS update server. Check the box is online, then try again."],
    ['untrusted', "The update couldn't be checked as genuine, so nothing was installed. Try again later."],
    ['server', 'The update server had a problem. Try again in a few minutes.'],
    ['busy', 'The box is busy installing something else. Try again in a few minutes.'],
    ['no-space', "There isn't enough free space on the box for the update. It needs about 1 GB."],
    ['up-to-date', 'MediaOS is already up to date.'],
    ['install-failed', "The update couldn't be installed, so the box kept MediaOS 0.1.0. Try again later."],
    ['no-previous', "There's no earlier version on this box to go back to."],
    ['interrupted', 'The box was switched off part-way through, so it kept MediaOS 0.1.0. Try again.'],
    ['failed', "The update didn't work. Try again later."],
    ['unexpected', "The update didn't work. Try again later."],
  ])('maps %s to its exact screen text', async (word, text) => {
    const ctx = make()
    ctx.run.mockImplementation(async () => { ctx.record('check', false, word); return success })
    await expect(ctx.updates.check()).rejects.toThrow(new UserFacingError(text))
    expect((await ctx.updates.status()).lastRun?.error).toBe(text)
    expect(ctx.fetch).not.toHaveBeenCalled()
    expect(updateError(word, '0.1.0')).toBe(text)
  })
  it.each(['unchanged', 'stale', 'stale-same-second', 'wrong-action', 'timeout', 'throw'])(
    'rejects a command without a fresh matching result: %s', async (mode) => {
    const ctx = make()
    if (mode === 'stale') ctx.record('check', true, undefined, new Date(now - 2000).toISOString())
    // Written earlier in the same second the action started: the script's milliseconds tell it apart.
    if (mode === 'stale-same-second') ctx.record('check', true, undefined, new Date(now - 400).toISOString())
    if (mode === 'wrong-action') ctx.record('apply')
    ctx.run.mockImplementation(async () => {
      if (mode === 'throw') throw new Error('systemctl unavailable')
      return mode === 'timeout' ? { fail: 'timeout' } : success
    })
    await expect(ctx.updates.check()).rejects.toThrow("The update didn't start. Restart the box and try again.")
    expect(ctx.logger.warn).toHaveBeenCalledWith('Update unit did not record a result', 'check', expect.anything())
  })
  it.each(['nonzero', 'timeout', 'throw'])('accepts a fresh state result despite runner %s', async (mode) => {
    const ctx = make()
    ctx.run.mockImplementation(async () => {
      ctx.record('check')
      if (mode === 'throw') throw new Error('connection closed')
      return mode === 'timeout' ? { fail: 'timeout' } : { code: 1, stdout: '', stderr: 'unit failed' }
    })
    expect((await ctx.updates.check()).lastRun?.ok).toBe(true)
  })
  it.each([[0, true], [7, true], [-1, false]])('compares millisecond results exactly: %i ms after the start', async (ms, ok) => {
    const ctx = make()
    ctx.run.mockImplementation(async () => { ctx.record('check', true, undefined, new Date(now + ms).toISOString()); return success })
    if (ok) expect((await ctx.updates.check()).lastRun?.ok).toBe(true)
    else await expect(ctx.updates.check()).rejects.toThrow("The update didn't start.")
  })
  it('rejects overlapping calls immediately and reports running without waiting', async () => {
    const ctx = make(), pending = deferred<CommandResult>()
    ctx.run.mockImplementation(async () => { await pending.promise; ctx.record('check'); return success })
    const check = ctx.updates.check()
    expect((await ctx.updates.status()).running).toBe('check')
    await expect(ctx.updates.check()).rejects.toThrow('An update is already running. Wait for it to finish.')
    for (const action of ['apply', 'rollback', 'auto'] as const) {
      expect(await ctx.updates[action]()).toEqual({ ok: false, error: 'An update is already running. Wait for it to finish.' })
    }
    pending.resolve(success); await check
    expect((await ctx.updates.status()).running).toBeUndefined()
    expect(ctx.run).toHaveBeenCalledOnce()
  })
  it('reads absent or broken state safely and does no network work in status', async () => {
    const ctx = make()
    ctx.io.readFile.mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }))
    expect(await ctx.updates.status()).toMatchObject({ configured: true, current: '0.1.0' })
    ctx.box.state = 'broken'
    expect(await ctx.updates.status()).toMatchObject({ current: '0.1.0' })
    expect(ctx.logger.warn).toHaveBeenCalledOnce()
    expect(ctx.fetch).not.toHaveBeenCalled(); expect(ctx.run).not.toHaveBeenCalled()
  })
  it('does not start a unit after disposal during the initial state read', async () => {
    const ctx = make(), access = deferred<void>()
    ctx.io.access.mockReturnValue(access.promise)
    const apply = ctx.updates.apply()
    ctx.updates.dispose(); access.resolve()
    expect(await apply).toMatchObject({ ok: false })
    expect(ctx.run).not.toHaveBeenCalled()
  })
  it('refuses unconfigured check, apply and auto but still allows rollback', async () => {
    const ctx = make(); ctx.box.configured = false
    await expect(ctx.updates.check()).rejects.toThrow("Updates aren't set up on this box. It has MediaOS 0.1.0.")
    expect(await ctx.updates.apply()).toMatchObject({ ok: false })
    expect(await ctx.updates.auto()).toMatchObject({ ok: false })
    expect(ctx.run).not.toHaveBeenCalled()
    expect(await ctx.updates.rollback()).toEqual({ ok: true })
    expect(ctx.run).toHaveBeenCalledExactlyOnceWith('systemctl',
      ['--no-ask-password', 'start', 'mediaos-update-rollback.service'], { timeoutMs: 1000000 })
  })
  it.each([['apply', 2000000], ['auto', 2000000], ['rollback', 1000000]] as const)(
    'uses the fixed %s unit and timeout', async (action, timeoutMs) => {
    const ctx = make()
    expect(await ctx.updates[action]()).toEqual({ ok: true })
    expect(ctx.run).toHaveBeenCalledExactlyOnceWith('systemctl',
      ['--no-ask-password', 'start', `mediaos-update-${action}.service`], { timeoutMs })
    ctx.run.mockImplementation(async () => { ctx.record(action, false, 'offline'); return success })
    expect(await ctx.updates[action]()).toEqual({ ok: false, error: updateError('offline', '0.1.0') })
  })
  it('fetches notes once per version and passes the required headers and abort signal', async () => {
    const ctx = make()
    expect((await ctx.updates.check()).notes).toBe('New\n\n• Faster home')
    expect((await ctx.updates.check()).notes).toBe('New\n\n• Faster home')
    expect(ctx.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/repos/GoblinRules/MediaOS/releases/tags/v0.2.0', expect.objectContaining({
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MediaOS' }, signal: expect.any(AbortSignal),
      }))
    ctx.box.available = '0.3.0'; await ctx.updates.check()
    expect(ctx.fetch).toHaveBeenCalledTimes(2)
  })
  it('does not fetch notes for a different host', async () => {
    const ctx = make(); ctx.box.sources = 'URIs: https://updates.example.org/\n'
    expect((await ctx.updates.check()).notes).toBeUndefined()
    expect(ctx.fetch).not.toHaveBeenCalled()
  })
  it.each(['network', 'status', 'json', 'missing', 'empty', 'large', 'length'])(
    'leaves a successful check successful when notes fail: %s', async (mode) => {
    const ctx = make()
    ctx.fetch.mockImplementation(async () => {
      switch (mode) {
        case 'network': throw new Error('offline')
        case 'status': return new Response('', { status: 404 })
        case 'json': return new Response('{')
        case 'missing': return Response.json({})
        case 'empty': return Response.json({ body: '  ' })
        case 'length': return new Response('{}', { headers: { 'content-length': '262145' } })
        default: return Response.json({ body: 'x'.repeat(262145) })
      }
    })
    expect((await ctx.updates.check()).notes).toBeUndefined()
    expect(ctx.logger.debug).toHaveBeenCalled()
  })
  it('releases the action lock while fetching notes and cancels notes on disposal', async () => {
    const ctx = make(), started = deferred<void>()
    ctx.fetch.mockImplementation(async (_url, options) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      return Response.json({})
    })
    const check = ctx.updates.check(); await started.promise
    expect((await ctx.updates.status()).running).toBeUndefined()
    expect(await ctx.updates.apply()).toEqual({ ok: true })
    ctx.updates.dispose(); await check
    expect(await ctx.updates.auto()).toMatchObject({ ok: false })
  })
})
