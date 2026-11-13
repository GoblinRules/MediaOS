import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProgressStore } from '../../src/main/sources/folders/ProgressStore'
import { createMockFolders } from '../../src/main/system/mock/MockFolders'
import { FolderSource } from '../../src/main/sources/folders/FolderSource'
import { FsLister } from '../../src/main/sources/folders/listing'
import { folderText } from '../../src/main/folders/texts'
import { composeCore } from '../../src/main/core/compose'
import { handleCall } from '../../src/main/core/ipc'
import { temporary } from './helpers'

afterEach(() => vi.useRealTimers())
describe('folder progress persistence', () => {
  it('debounces writes, flushes, loads validated entries and uses private permissions', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), file = join(temp.dir, 'progress.json'), store = new ProgressStore(file)
    try {
      store.set('root/video', { type: 'video', title: 'Film', subtitle: '2019', durationSec: 200, positionSec: 40 })
      await vi.advanceTimersByTimeAsync(1999); await expect(fs.stat(file)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(1); await store.flush()
      const reopened = await ProgressStore.open(file)
      expect(reopened.get('root/video')).toEqual(store.get('root/video'))
      if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      store.set('root/folder', { type: 'folder', title: 'Favourite', favourite: true })
      await store.flush(); expect(vi.getTimerCount()).toBe(0)
      expect((await ProgressStore.open(file)).entries()).toHaveLength(2)
    } finally { await store.flush(); await temp.dispose() }
  })
  it('drops oldest progress first and keeps favourites last when capping at 3000', async () => {
    const temp = await temporary(), store = new ProgressStore(join(temp.dir, 'progress.json'))
    try {
      store.set('favourite', { title: 'Keep', type: 'folder', favourite: true })
      for (let n = 0; n < 3001; n++) store.set(`root/${n}`, { title: `Video ${n}`, type: 'video',
        lastPlayedAt: new Date(n * 1000).toISOString() })
      expect(store.entries()).toHaveLength(3000)
      expect(store.get('favourite')?.favourite).toBe(true)
      expect(store.get('root/0')).toBeUndefined(); expect(store.get('root/1')).toBeUndefined()
      expect(store.get('root/3000')).toBeDefined()
      await store.flush()
      expect((await ProgressStore.open(join(temp.dir, 'progress.json'))).entries()).toHaveLength(3000)
    } finally { await store.flush(); await temp.dispose() }
  })
  it.each(['{', '{"root/file":{"title":"Film","type":"video","durationSec":-1}}', 'null'])(
    'starts empty with a warning for damaged data %s', async (raw) => {
      const temp = await temporary(), file = join(temp.dir, 'progress.json')
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      try {
        await fs.writeFile(file, raw, 'utf8')
        expect((await ProgressStore.open(file, { logger })).entries()).toEqual([])
        expect(logger.warn).toHaveBeenCalledOnce()
      } finally { await temp.dispose() }
    })
  it('warns for a missing file', async () => {
    const temp = await temporary(), logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    try {
      expect((await ProgressStore.open(join(temp.dir, 'missing.json'), { logger })).entries()).toEqual([])
      expect(logger.warn).toHaveBeenCalledOnce()
    } finally { await temp.dispose() }
  })
})
describe('mock folders and Core wiring', () => {
  it('adds, persists without passwords, browses real mock files and removes shares while keeping progress', async () => {
    const temp = await temporary(), dir = join(temp.dir, 'folders')
    const folders = createMockFolders({ foldersDir: dir, delayMs: 0 })
    const store = new ProgressStore(join(temp.dir, 'progress.json'))
    const source = new FolderSource({ id: 'folders', name: 'Folders', roots: folders.roots,
      retry: folders.retry, lister: new FsLister(), store })
    const changed = vi.fn(); folders.on('changed', changed)
    try {
      const result = await folders.add({ server: 'nas', share: 'Films', guest: false, user: 'WORK\\bob', password: 'private' })
      if (!result.ok) throw new Error(result.error)
      expect((await folders.list()).shares[0]).toMatchObject({ id: result.id, user: 'bob', domain: 'WORK', available: true })
      const raw = await fs.readFile(join(dir, 'shares.json'), 'utf8')
      expect(raw).not.toContain('private'); expect(raw).not.toContain('password')
      const reopened = createMockFolders({ foldersDir: dir, delayMs: 0 })
      expect((await reopened.list()).shares).toHaveLength(1); reopened.dispose()
      expect((await folders.list()).drives).toEqual([{ id: 'usb-mock', name: 'HOLIDAY', fs: 'vfat' }])
      expect((await source.browse(result.id, { sort: 'title', offset: 0, limit: 20 })).items.map((i) => i.title)).toEqual(['Films', 'Shows'])
      const video = `${result.id}/Films/Some Film (2019)/Some.Film.2019.1080p.mkv`
      const playback = await source.playback(video, { resume: true })
      expect(playback.item.title).toBe('Some Film'); expect(playback.subtitles[0]?.lang).toBe('en')
      await source.report(playback.report, { state: 'progress', positionSec: 40, durationSec: 100 })
      expect((await source.rows()).resume).toHaveLength(1)
      expect(await folders.retry(result.id)).toEqual({ ok: true })
      expect(await folders.remove(result.id)).toEqual({ ok: true })
      expect((await folders.list()).shares).toEqual([]); expect((await source.rows()).resume).toEqual([])
      expect(store.get(video)?.positionSec).toBe(40)
      expect(changed).toHaveBeenCalledTimes(3)
    } finally { folders.dispose(); source.dispose(); await store.flush(); await temp.dispose() }
  })
  it.each([
    [{ server: 'offline', share: 'Films', password: '' }, 'unreachable'],
    [{ server: 'nas', share: 'Films', password: 'wrong' }, 'auth'],
    [{ server: 'nas', share: 'missing', password: '' }, 'no-share'],
  ] as const)('simulates failure %s', async (req, word) => {
    const temp = await temporary(), folders = createMockFolders({ foldersDir: temp.dir, delayMs: 0 })
    try {
      expect(await folders.add({ ...req, guest: false, user: 'bob' })).toEqual({
        ok: false, error: folderText(word, req.server, req.share),
      })
      if (word !== 'no-share') await expect(folders.listShares({ ...req, guest: false, user: 'bob' }))
        .rejects.toThrow(folderText(word, req.server))
    } finally { folders.dispose(); await temp.dispose() }
  })
  it('delays failures, discovers sample computers, lists shares and cancels timers on dispose', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), folders = createMockFolders({ foldersDir: temp.dir, delayMs: 20 })
    try {
      const failure = folders.listShares({ server: 'offline', guest: true }).catch((e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(19)
      let done = false; void failure.then(() => { done = true }); await Promise.resolve(); expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1); expect(await failure).toBe(folderText('unreachable', 'offline'))
      const discovered = folders.discover(); await vi.advanceTimersByTimeAsync(20)
      expect(await discovered).toEqual([{ name: 'NAS', host: 'nas.local', ip: '192.168.1.20' },
        { name: 'OFFICE-PC', host: 'OFFICE-PC', ip: '192.168.1.31' }])
      const shares = folders.listShares({ server: 'nas', guest: true }); await vi.advanceTimersByTimeAsync(20)
      expect(await shares).toEqual(['Films', 'Music', 'Public'])
      const pending = folders.discover(); folders.dispose(); await pending
      expect(vi.getTimerCount()).toBe(0)
    } finally { folders.dispose(); await temp.dispose() }
  })
  it('exposes the IPC calls, invalidates Home, emits system events and protects the built-in source', async () => {
    const temp = await temporary(), composed = await composeCore({ platform: 'mock', dataDir: temp.dir,
      logDir: join(temp.dir, 'logs'), forceMockPlayer: true, fixtureLatencyMs: 0, mockDelayMs: 0, restartShell() {} })
    const { core } = composed
    try {
      const changed = vi.fn(), system = vi.fn(); core.on('homeChanged', changed); core.on('system', system)
      const result = await core.dispatch('folders.add', [{ server: 'nas', share: 'Films', guest: true, password: 'sensitive' }])
      if (!result.ok) throw new Error(result.error)
      expect(changed).toHaveBeenCalledOnce(); expect(system).toHaveBeenCalledWith({ what: 'folders' })
      expect((await core.dispatch('folders.list', [])).shares).toHaveLength(1)
      expect(await core.dispatch('folders.listShares', [{ server: 'nas', guest: true }])).toEqual(['Films', 'Music', 'Public'])
      expect(await core.dispatch('folders.discover', [])).toHaveLength(2)
      expect(await core.dispatch('folders.retry', [result.id])).toEqual({ ok: true })
      expect(await core.dispatch('folders.remove', [result.id])).toEqual({ ok: true })
      for (const call of ['sources.remove', 'sources.rename'] as const) {
        await expect(core.dispatch(call, ['folders', ...(call === 'sources.rename' ? ['Renamed'] : [])]))
          .rejects.toMatchObject({ code: 'unsupported',
            message: call === 'sources.rename'
              ? "Folders can't be renamed. Each network folder keeps the name it was added with."
              : "Folders can't be removed. Remove each network folder in Settings › Libraries instead." })
      }
      // Windows PCs often sign in with an email address, so an @ in the user name is allowed.
      expect(await handleCall(core, 'folders.listShares', [{ server: 'nas', guest: false, user: 'me@example.com', password: 'x' }]))
        .toMatchObject({ ok: true })
      expect(core.settings.get().sources.some((s) => s.id === 'folders')).toBe(false)
      expect((await core.dispatch('sources.list', [])).some((s) => s.id === 'folders')).toBe(true)
      expect(await handleCall(core, 'folders.add', [{ server: 'nas', share: 'Films', guest: false,
        user: 'bob', password: 'sensitive\n' }])).toMatchObject({ ok: false })
      expect(await handleCall(core, 'folders.remove', ['usb-mock'])).toMatchObject({ ok: false })
    } finally { await composed.dispose() }
    try {
      const log = await fs.readFile(join(temp.dir, 'logs', 'mediaos.log'), 'utf8')
      expect(log).not.toContain('sensitive')
    } finally { await temp.dispose() }
  })
})
