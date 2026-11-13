import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { Core } from '../../src/main/core/Core'
import { composeCore } from '../../src/main/core/compose'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { silentLog } from '../../src/main/log/Logger'
import { deferred, temporary, until } from './helpers'
import { handleCall } from '../../src/main/core/ipc'
import { SOURCE_LIMIT_MESSAGE } from '../../src/main/sources/limits'
import { SettingsStore } from '../../src/main/settings/SettingsStore'

afterEach(() => vi.useRealTimers())
async function composition() {
  const temp = await temporary(), restartShell = vi.fn()
  const options = { platform: 'mock' as const, dataDir: temp.dir, logDir: temp.dir,
    forceMockPlayer: true, mockDelayMs: 0, restartShell }
  const composed = await composeCore(options)
  return { temp, composed, options, core: composed.core, restartShell }
}
describe('core review regressions', () => {
  it('disconnects a source even when its saved sign-in cannot be deleted', async () => {
    const { temp, composed, core } = await composition()
    const warn = vi.spyOn(core.logger, 'warn')
    try {
      await core.dispatch('sources.rename', ['demo', 'Our library'])
      vi.spyOn(core.secrets, 'delete').mockRejectedValue(new Error('private disk details'))
      await expect(core.dispatch('sources.remove', ['demo'])).resolves.toEqual({ ok: true })
      expect(await core.dispatch('sources.list', [])).toEqual([{ id: 'folders', kind: 'folders', name: 'Folders', status: 'ok' }])
      expect(core.settings.get().sources).toEqual([])
      expect(core.settings.get().demoRemoved).toBe(true)
      expect(warn.mock.calls).toEqual([['Saved sign-in could not be deleted']])
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('explains the source limit when renaming an unconfigured demo library', async () => {
    const { temp, composed, core } = await composition()
    try {
      core.settings.update({ sources: Array.from({ length: 20 }, (_, i) => ({
        id: `source-${i}`, name: `Library ${i}`, kind: 'fixture', enabled: true,
      })) })
      expect(await handleCall(core, 'sources.rename', ['demo', 'Renamed'])).toEqual({ ok: false, error: SOURCE_LIMIT_MESSAGE })
      expect(core.hub.list()[0]?.name).toBe('Demo library')
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('renames a configured library when all 20 source slots are occupied', async () => {
    const { temp, composed, core } = await composition()
    try {
      core.settings.update({ sources: Array.from({ length: 20 }, (_, i) => ({
        id: i === 0 ? 'demo' : `source-${i}`, name: `Library ${i}`, kind: 'fixture', enabled: true,
      })) })
      expect(await handleCall(core, 'sources.rename', ['demo', 'Kitchen'])).toEqual({ ok: true, value: { ok: true } })
      expect(core.settings.get().sources).toHaveLength(20)
      expect(core.settings.get().sources.find((source) => source.id === 'demo')?.name).toBe('Kitchen')
      expect(core.hub.list().find((source) => source.id === 'demo')?.name).toBe('Kitchen')
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('logs validation paths and codes without argument values or technical screen text', async () => {
    const { temp, composed, core } = await composition(), warn = vi.spyOn(core.logger, 'warn')
    const generic = 'Something went wrong. Try again, or restart MediaOS from Settings.'
    try {
      expect(await handleCall(core, 'jellyfin.password', ['http://test', 'guest', { password: 'private-value' }]))
        .toEqual({ ok: false, error: generic })
      expect(warn.mock.calls).toEqual([['Call validation failed', {
        call: 'jellyfin.password', issues: [{ path: [2], code: 'invalid_type' }],
      }]])
      expect(await handleCall(core, 'private-unknown-call', [])).toEqual({ ok: false, error: generic })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-value|private-unknown-call/)
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('cancels open sign-in flows before erasing settings and keeps late writes erased during reset', async () => {
    const { temp, composed, core } = await composition(), stopped = deferred<void>()
    try {
      const quick = await core.signin.quickConnect('http://test'), plex = await core.signin.plexPin()
      const cancel = vi.spyOn(core.signin, 'cancelAll')
      const erase = vi.spyOn(core.secrets, 'erase')
      const stop = vi.spyOn(core.player, 'stop').mockReturnValueOnce(stopped.promise)
      const reset = core.dispatch('shell.factoryReset', ['ERASE'])
      await until(() => stop.mock.calls.length === 1)
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(erase.mock.invocationCallOrder[0]!)
      expect(await core.signin.poll(quick.flowId)).toEqual({ state: 'expired' })
      expect(await core.signin.poll(plex.flowId)).toEqual({ state: 'expired' })
      const message = 'MediaOS is restarting after the reset. Try again in a moment.'
      expect(() => core.settings.update({ deviceName: 'Late name', setupDone: true })).toThrow(message)
      expect(await handleCall(core, 'settings.update', [{ setupDone: true }])).toEqual({ ok: false, error: message })
      await expect(core.signin.password('http://test', 'guest', 'demo')).rejects.toThrow(message)
      expect(core.hub.list().map((source) => source.id)).toEqual(['demo', 'folders'])
      await core.secrets.set('late', { token: 'private' })
      stopped.resolve(); await reset; await composed.dispose()
      for (const name of ['settings.json', 'secrets.json']) {
        await expect(fs.stat(join(temp.dir, name))).rejects.toHaveProperty('code', 'ENOENT')
      }
    } finally { stopped.resolve(); await composed.dispose(); await temp.dispose() }
  })
  it('rejects a password sign-in completing after reset without adding a library or writing settings', async () => {
    const { temp, composed, core } = await composition(), probe = deferred<Awaited<ReturnType<typeof core.signin.probe>>>()
    try {
      vi.spyOn(core.signin, 'probe').mockReturnValueOnce(probe.promise)
      const result = core.signin.password('http://test', 'guest', 'demo')
      // Attach the rejection assertion before reset releases the pending sign-in.
      const rejected = expect(result).rejects.toThrow('MediaOS is restarting after the reset. Try again in a moment.')
      await core.dispatch('shell.factoryReset', ['ERASE'])
      probe.resolve({ serverName: 'Test', version: '1', quickConnect: true, url: 'http://test' })
      await rejected; await core.settings.flush()
      expect(core.hub.list().map((source) => source.id)).toEqual(['demo', 'folders'])
      await expect(fs.stat(join(temp.dir, 'settings.json'))).rejects.toHaveProperty('code', 'ENOENT')
    } finally {
      probe.resolve({ serverName: 'Test', version: '1', quickConnect: true, url: 'http://test' })
      await composed.dispose(); await temp.dispose()
    }
  })
  it('restarts from the menu after settings erasure fails and passes the later update error through IPC', async () => {
    const { temp, composed, core, restartShell } = await composition()
    const file = join(temp.dir, 'reset-settings.json')
    const settings = await SettingsStore.open(file, { fs: { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      await fs.rm(...args)
    } } })
    const reset = new Core({ ...core, settings, restartShell, clearCaches: async () => undefined })
    try {
      settings.update({ deviceName: 'Before reset' }); await settings.flush()
      expect(await handleCall(reset, 'shell.factoryReset', ['ERASE'])).toEqual({
        ok: false, error: "MediaOS couldn't erase everything. Restart the box and try again.",
      })
      expect(restartShell).not.toHaveBeenCalled()
      expect(await handleCall(reset, 'settings.update', [{ setupDone: true }])).toEqual({
        ok: false, error: "MediaOS couldn't finish erasing everything. Restart the box and try again.",
      })
      expect(await handleCall(reset, 'shell.restart', [])).toEqual({ ok: true, value: { ok: true } })
      expect(restartShell).toHaveBeenCalledOnce()
    } finally { reset.dispose(); await composed.dispose(); await temp.dispose() }
  })
  it('retains a fixed reset-failure summary in the real log after wiping old logs', async () => {
    const { temp, composed, core, restartShell } = await composition()
    try {
      core.logger.info('old history')
      vi.spyOn(core.secrets, 'erase').mockRejectedValue(new Error('private failure detail'))
      await expect(core.dispatch('shell.factoryReset', ['ERASE'])).rejects.toThrow("MediaOS couldn't erase everything")
      expect(restartShell).not.toHaveBeenCalled()
      await composed.dispose()
      const text = await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')
      expect(text).toContain('Factory reset incomplete: sign-ins')
      expect(text).not.toMatch(/old history|private failure detail/)
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('updates removed and renamed sources in the hub, settings and secrets, starts scanning and emits the screen-off toast', async () => {
    const { temp, composed, core } = await composition()
    try {
      core.hub.add(new FixtureSource({ id: 'remove-me' }))
      core.settings.update({ sources: [{ id: 'remove-me', name: 'Remove', kind: 'fixture', enabled: true }] })
      await core.secrets.set('remove-me', { token: 'private' })
      await core.dispatch('sources.remove', ['remove-me'])
      expect(core.hub.list().some((s) => s.id === 'remove-me')).toBe(false)
      expect(core.settings.get().sources.some((s) => s.id === 'remove-me')).toBe(false)
      expect(core.secrets.get('remove-me')).toBeUndefined()
      await core.dispatch('sources.rename', ['demo', 'Our TV'])
      expect(core.hub.list().find((s) => s.id === 'demo')?.name).toBe('Our TV')
      expect(core.settings.get().sources.find((s) => s.id === 'demo')?.name).toBe('Our TV')
      const scan = vi.spyOn(core.system.bluetooth, 'startScan'), stop = vi.spyOn(core.system.bluetooth, 'stopScan')
      await core.dispatch('bluetooth.scan', [false]); await core.dispatch('bluetooth.scan', [true])
      expect(stop).toHaveBeenCalledOnce(); expect(scan).toHaveBeenCalledOnce()
      const toast = vi.fn(); core.on('toast', toast)
      await core.dispatch('power.screenOff', [])
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: 'The screen is off. Press a button to return.' }))
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('keeps cached home for unrelated settings and invalidates once for source or home patches', async () => {
    const { temp, composed, core } = await composition()
    try {
      await core.dispatch('sources.rename', ['demo', 'Demo library'])
      const rows = vi.spyOn(core.hub.get('demo')!, 'rows'), changed = vi.fn()
      core.on('homeChanged', changed)
      await core.dispatch('home.get', [])
      await core.dispatch('settings.update', [{ deviceName: 'Another TV' }])
      await core.dispatch('home.get', [])
      expect(changed).not.toHaveBeenCalled(); expect(rows).toHaveBeenCalledTimes(1)
      const settings = core.settings.get()
      await core.dispatch('settings.update', [{ sources: settings.sources.map((s) => ({ ...s, name: 'Our TV', enabled: false })),
        home: { ...settings.home, hero: false } }])
      expect(changed).toHaveBeenCalledTimes(1)
      expect((await core.dispatch('home.get', [])).rows.map((row) => row.id)).toEqual(['lib:folders~usb-mock'])
      await core.dispatch('settings.update', [{ sources: settings.sources }])
      expect(changed).toHaveBeenCalledTimes(2)
      await core.dispatch('settings.update', [{ home: { ...settings.home, hero: false } }])
      expect(changed).toHaveBeenCalledTimes(3)
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('returns the entire catalogue with hidden pinned apps first', async () => {
    const { temp, composed, core } = await composition()
    try {
      core.settings.update({ apps: { ...core.settings.get().apps, pinned: ['netflix', 'youtube'], hidden: ['netflix'] } })
      const apps = await core.dispatch('apps.list', [])
      expect(apps.map((a) => a.id).slice(0, 2)).toEqual(['netflix', 'youtube'])
      expect(apps).toHaveLength(APP_CATALOG.length)
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it.each([5, -1])('applies fixture subtitle choice %s through Core without sending source indices as commands', async (subIdx) => {
    const { temp, composed, core } = await composition()
    try {
      const movie = (await core.hub.get('demo')!.rows()).latest.find((i) => i.type === 'movie')!
      const commands = vi.spyOn(core.player, 'command')
      await core.dispatch('player.play', [movie.key, { resume: false, subIdx, audioIdx: 2 }])
      const chosen = core.player.state().subtitleTracks.filter((t) => t.selected)
      expect(chosen.map((t) => t.index)).toEqual(subIdx === 5 ? [3] : [])
      expect(commands).not.toHaveBeenCalled()
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('hands over automatically without shell foreground, idle player or homeChanged events', async () => {
    vi.useFakeTimers()
    const { temp, composed, core } = await composition()
    try {
      const source = core.hub.get('demo')!, movie = (await source.rows()).latest.find((i) => i.type === 'movie')!
      const plan = await source.playback(movie.id, { resume: false })
      const next = { ...movie, id: 'next', key: 'demo~next' }
      vi.spyOn(source, 'playback').mockResolvedValue({ ...plan, item: next })
      const foreground = vi.fn(), changed = vi.fn(), states = vi.fn()
      core.on('foreground', foreground); core.on('homeChanged', changed); core.on('player', states)
      await core.player.play({ ...plan, durationSec: 1, next }, source)
      foreground.mockClear(); changed.mockClear(); states.mockClear()
      await vi.advanceTimersByTimeAsync(1600)
      expect(core.player.state().item?.id).toBe('next')
      expect(core.getForeground()).toEqual({ kind: 'player' })
      expect(foreground).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
      expect(states.mock.calls.some(([s]) => s.status === 'idle')).toBe(false)
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('shows both damaged-file notices once without logging file contents', async () => {
    const { temp, composed, options } = await composition()
    let reopened: Awaited<ReturnType<typeof composeCore>> | undefined
    try {
      await composed.dispose()
      const content = '{"credential-fragment":"very-private"'
      await fs.writeFile(join(temp.dir, 'settings.json'), content, 'utf8')
      await fs.writeFile(join(temp.dir, 'secrets.json'), content, 'utf8')
      reopened = await composeCore(options)
      const notices = await reopened.core.dispatch('shell.notices', [])
      expect(notices.map((n) => n.text)).toEqual([
        'Your settings file was damaged, so MediaOS started with default settings.',
        "Saved sign-ins were damaged, so you'll need to sign in to your servers again.",
      ])
      expect(await reopened.core.dispatch('shell.notices', [])).toEqual([])
      await reopened.dispose()
      const logs = await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')
      expect(logs).not.toMatch(/credential-fragment|very-private/)
    } finally { await reopened?.dispose(); await composed.dispose(); await temp.dispose() }
  })
  it('persists demo removal across restarts and restores it after factory reset', async () => {
    const { temp, composed, options } = await composition()
    let current = composed
    try {
      await current.core.dispatch('sources.remove', ['demo'])
      expect(current.core.settings.get().demoRemoved).toBe(true)
      await current.dispose(); current = await composeCore(options)
      expect(current.core.hub.get('demo')).toBeUndefined()
      await current.core.dispatch('shell.factoryReset', ['ERASE'])
      await current.dispose(); current = await composeCore(options)
      expect(current.core.hub.get('demo')).toBeDefined()
    } finally { await current.dispose(); await temp.dispose() }
  })
  it('clears logs and diagnostics without deleting other files when logDir equals dataDir', async () => {
    const { temp, composed, core, restartShell } = await composition()
    try {
      await fs.writeFile(join(temp.dir, 'keep.txt'), 'unrelated', 'utf8')
      core.logger.info('old log entry')
      const diagnostics = await core.system.info.collectDiagnostics()
      await core.dispatch('shell.factoryReset', ['ERASE'])
      expect(restartShell).toHaveBeenCalledOnce()
      await expect(fs.stat(diagnostics)).rejects.toHaveProperty('code', 'ENOENT')
      expect((await fs.readdir(temp.dir)).some((n) => n.startsWith('mediaos.log'))).toBe(false)
      expect(await fs.readFile(join(temp.dir, 'keep.txt'), 'utf8')).toBe('unrelated')
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it.each(['none', 'secrets', 'settings'])('runs every reset step in order when %s erase fails', async (failure) => {
    const { temp, composed, core } = await composition()
    const order: string[] = [], error = vi.fn(), restartShell = vi.fn(() => { order.push('restart') })
    const action = (name: string, fail = false) => async () => { order.push(name); if (fail) throw new Error('busy') }
    const reset = new Core({ ...core, logger: { ...silentLog, error }, restartShell,
      clearCaches: action('cache', true), clearProfiles: action('profiles', true), clearLogs: action('logs', true) })
    try {
      vi.spyOn(core.secrets, 'erase').mockImplementation(action('secrets', failure === 'secrets'))
      vi.spyOn(core.signin, 'cancelAll').mockImplementation(action('sign-in flows'))
      vi.spyOn(core.settings, 'erase').mockImplementation(action('settings', failure === 'settings'))
      vi.spyOn(core.player, 'stop').mockImplementation(action('player'))
      vi.spyOn(core.apps, 'close').mockImplementation(action('apps'))
      const request = reset.dispatch('shell.factoryReset', ['ERASE'])
      if (failure === 'none') await request
      else await expect(request).rejects.toThrow("MediaOS couldn't erase everything. Restart the box and try again.")
      expect(order).toEqual(['sign-in flows', 'secrets', 'settings', 'player', 'apps', 'cache', 'profiles', 'logs',
        ...(failure === 'none' ? ['restart'] : [])])
      expect(error.mock.calls).toEqual([[`Factory reset incomplete: ${failure === 'none' ? '' :
        `${failure === 'secrets' ? 'sign-ins' : 'settings'}, `}cache, profiles, logs`]])
      expect(restartShell).toHaveBeenCalledTimes(failure === 'none' ? 1 : 0)
    } finally { reset.dispose(); await composed.dispose(); await temp.dispose() }
  })
})
