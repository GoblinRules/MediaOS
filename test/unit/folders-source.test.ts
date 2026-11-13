import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrowseQuery } from '@shared/media-types'
import type { FolderRoot } from '../../src/main/system/SystemServices'
import { FolderSource, RETRY_WAIT_MS } from '../../src/main/sources/folders/FolderSource'
import { FsLister, FindLister, MissingPath, visibleName, type DirLister } from '../../src/main/sources/folders/listing'
import { ProgressStore } from '../../src/main/sources/folders/ProgressStore'
import { fileName, natural, sidecars } from '../../src/main/sources/folders/names'
import { NodeCommandRunner, type CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { deferred, temporary, until } from './helpers'

const query: BrowseQuery = { sort: 'title', offset: 0, limit: 100 }
async function make() {
  const temp = await temporary(), rootPath = join(temp.dir, 'root')
  await fs.mkdir(rootPath)
  const root: FolderRoot = { id: 'smb-1234abcd', name: 'Cinema', path: rootPath, available: true, kind: 'share', server: 'NAS' }
  const state = { roots: [root], now: 100_000 }
  const names = ['Episode.10.2020.mp4', 'Episode.2.2019.mkv', 'A.2021.1080p.mp4',
    'Episode.2.2019.en.srt', 'Episode.2.2019.fr.ass', 'Episode.2.2019.srt', 'Unrelated.en.srt', 'notes.txt', '.hidden.mp4', 'Thumbs.db']
  for (let n = 0; n < names.length; n++) {
    const path = join(rootPath, names[n]!)
    await fs.writeFile(path, 'Mock file\n', 'utf8'); await fs.utimes(path, n + 1, n + 1)
  }
  for (const name of ['Folder 10', 'Folder 2', '.hidden', '$RECYCLE.BIN', 'System Volume Information', '@eaDir', '#recycle', 'lost+found']) {
    await fs.mkdir(join(rootPath, name))
  }
  const store = new ProgressStore(join(temp.dir, 'progress.json'))
  const retry = vi.fn(async () => ({ ok: true as const }))
  const lister: DirLister = new FsLister()
  const roots = vi.fn(async () => state.roots)
  const source = new FolderSource({ id: 'folders', name: 'Folders', roots,
    retry, lister, store, clock: { now: () => state.now } })
  return { temp, root, state, source, store, retry, lister, roots,
    dispose: async () => { source.dispose(); await store.flush(); await temp.dispose() } }
}
describe('folder file names', () => {
  it.each([
    ['Some.Film.2019.1080p.mkv', { title: 'Some Film', year: 2019, subtitle: '2019' }],
    ['Some_Film_(2020)_BluRay.mkv', { title: 'Some Film', year: 2020 }],
    ['Show.Name.S01E02.720p.mkv', { title: 'Show Name S01E02', seasonNumber: 1, episodeNumber: 2, subtitle: 'S1 · E2' }],
    ['Show.2x10.hevc.mp4', { title: 'Show 2x10', seasonNumber: 2, episodeNumber: 10 }],
    ['1917.mp4', { title: '1917', year: 1917 }],
    ['No_Year.web-dl.mkv', { title: 'No Year' }],
  ])('maps %s', (name, expected) => { expect(fileName(name)).toMatchObject(expected) })
  it.each(['2160p', '4k', 'x264', 'x265', 'hevc', 'bluray', 'web-dl', 'webrip', 'hdr'])(
    'cuts the title at quality tag %s', (tag) => expect(fileName(`Film.${tag}.Extra.mp4`).title).toBe('Film'))
  it('sorts naturally and selects sidecars and their language', () => {
    expect(['Episode 10', 'episode 2', 'Episode 1'].sort(natural.compare)).toEqual(['Episode 1', 'episode 2', 'Episode 10'])
    const entries = ['Film.en.srt', 'Film.ass', 'Other.en.srt', 'Film.deu.vtt', 'Film.en.txt'].map((name) =>
      ({ name, type: 'file' as const, mtimeMs: 0, size: 0 }))
    expect(sidecars('Film.mkv', entries, '/root').map(({ lang, title, default: def }) => [lang, title, def]))
      .toEqual([[undefined, 'External', false], ['deu', 'DEU', false], ['en', 'EN', false]])
    const others = ['Film 2.srt', 'Film2.en.srt', 'Filmmaker.srt'].map((name) => ({ name, type: 'file' as const, mtimeMs: 0, size: 0 }))
    expect(sidecars('Film.mkv', others, '/root')).toEqual([])
  })
  it('hides names that could be listed but never opened', () => {
    for (const bad of ['a\\b.mp4', 'a\nb.mp4', 'a\rb.mp4', `a${String.fromCharCode(0x2028)}b.mp4`, `a${String.fromCharCode(0x2029)}b.mp4`]) {
      expect(visibleName(bad)).toBe(false)
    }
    expect(visibleName('a\tb.mp4')).toBe(true); expect(visibleName('Café – 2020.mkv')).toBe(true)
  })
})
describe('FolderSource', () => {
  it('lists libraries with unique titles and an always-ok source', async () => {
    const c = await make()
    try {
      c.state.roots.push({ ...c.root, id: 'usb-second', kind: 'usb' })
      expect(await c.source.libraries()).toEqual([
        { key: `folders~${c.root.id}`, sourceId: 'folders', id: c.root.id, title: 'Cinema', kind: 'mixed' },
        { key: 'folders~usb-second', sourceId: 'folders', id: 'usb-second', title: 'Cinema (2)', kind: 'mixed' },
      ])
      expect(c.source.info().status).toBe('ok'); expect(await c.source.search()).toEqual([])
      expect(c.source.image()).toEqual({ kind: 'none' })
    } finally { await c.dispose() }
  })
  it('orders folders before videos, hides system files, sorts each group, and pages', async () => {
    const c = await make()
    try {
      const page = await c.source.browse(c.root.id, query)
      expect(page.items.map((i) => i.title)).toEqual(['Folder 2', 'Folder 10', 'A', 'Episode 2', 'Episode 10'])
      expect(page.total).toBe(5)
      expect((await c.source.children(c.root.id)).map((i) => i.id)).toEqual(page.items.map((i) => i.id))
      const descending = await c.source.browse(c.root.id, { ...query, descending: true })
      expect(descending.items.map((i) => i.title)).toEqual(['Folder 10', 'Folder 2', 'Episode 10', 'Episode 2', 'A'])
      const year = await c.source.browse(c.root.id, { ...query, sort: 'year' })
      expect(year.items.slice(2).map((i) => i.year)).toEqual([2019, 2020, 2021])
      const added = await c.source.browse(c.root.id, { ...query, sort: 'added' })
      expect(added.items.slice(2).map((i) => i.title)).toEqual(['Episode 10', 'Episode 2', 'A'])
      expect((await c.source.browse(c.root.id, { ...query, sort: 'rating' })).items).toEqual(page.items)
      expect(await c.source.browse(c.root.id, { ...query, offset: 2, limit: 1 })).toEqual({ items: [page.items[2]], total: 5, offset: 2 })
    } finally { await c.dispose() }
  })
  it('uses the progress store for watched, favourite and folder filters', async () => {
    const c = await make()
    try {
      const file = `${c.root.id}/Episode.2.2019.mkv`, folder = `${c.root.id}/Folder 2`
      await c.source.setWatched(file, true)
      await c.source.setFavourite(folder, true); await c.source.setFavourite(file, true)
      expect((await c.source.browse(c.root.id, { ...query, filter: 'unwatched' })).items.map((i) => i.id)).not.toContain(file)
      expect((await c.source.browse(c.root.id, { ...query, filter: 'favourites' })).items.map((i) => i.id)).toEqual([folder, file])
      expect((await c.source.item(folder)).type).toBe('folder')
      expect((await c.source.item(c.root.id)).title).toBe('Cinema')
      expect(await c.source.item(file)).toMatchObject({ audioTracks: [], subtitleTracks: [], overview: '0.0 MB · Cinema' })
    } finally { await c.dispose() }
  })
  it.each(['../x', 'Folder 2/../x', 'Folder 2\\x', 'Folder 2//x', './x', 'x\0y', ''])('rejects hostile id %j', async (suffix) => {
    const c = await make()
    try { await expect(c.source.browse(`${c.root.id}/${suffix}`, query)).rejects.toMatchObject({ code: 'notFound' }) }
    finally { await c.dispose() }
  })
  it('refuses symlink escapes before listing or playing', async (ctx) => {
    const c = await make()
    try {
      const outside = join(c.temp.dir, 'outside'); await fs.mkdir(outside); await fs.writeFile(join(outside, 'escape.mp4'), 'x', 'utf8')
      try { await fs.symlink(outside, join(c.root.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir') }
      catch (error) {
        if (process.platform === 'win32') { ctx.skip(); return }
        throw error
      }
      expect((await c.source.browse(c.root.id, query)).items.map((i) => i.title)).not.toContain('escape')
      await expect(c.source.browse(`${c.root.id}/escape`, query)).rejects.toMatchObject({ code: 'notFound' })
      await expect(c.source.playback(`${c.root.id}/escape/escape.mp4`, { resume: false })).rejects.toMatchObject({ code: 'notFound' })
    } finally { await c.dispose() }
  })
  it('caches by real folder path for 30 seconds', async () => {
    const c = await make(), list = vi.spyOn(c.lister, 'list')
    try {
      await c.source.browse(c.root.id, query); await c.source.browse(c.root.id, query)
      expect(list).toHaveBeenCalledOnce()
      await c.source.item(`${c.root.id}/Episode.2.2019.mkv`); expect(list).toHaveBeenCalledOnce()
      c.state.now += 30_000; await c.source.browse(c.root.id, query); expect(list).toHaveBeenCalledTimes(2)
    } finally { await c.dispose() }
  })
  it('fails busy roots immediately and suppresses filesystem retries for 60 seconds after failure', async () => {
    const c = await make(), pending = deferred<never>()
    const list = vi.spyOn(c.lister, 'list').mockReturnValueOnce(pending.promise)
    try {
      const first = c.source.browse(c.root.id, query)
      const firstError = expect(first).rejects.toMatchObject({ code: 'offline' })
      await until(() => list.mock.calls.length === 1)
      // Busy detection must precede another helper request, which could itself be slow.
      c.roots.mockClear()
      await expect(c.source.browse(c.root.id, query)).rejects.toMatchObject({
        code: 'timeout', message: 'Still waiting for Cinema. Try again in a moment.',
      })
      expect(c.roots).not.toHaveBeenCalled()
      pending.reject(new Error('timeout')); await firstError
      await expect(c.source.browse(c.root.id, query)).rejects.toThrow("Can't open Cinema. Check NAS is switched on, then try again.")
      expect(list).toHaveBeenCalledOnce()
      c.state.now += 59_999; await expect(c.source.browse(c.root.id, query)).rejects.toMatchObject({ code: 'offline' })
      c.state.now++; await c.source.browse(c.root.id, query); expect(list).toHaveBeenCalledTimes(2)
    } finally { await c.dispose() }
  })
  it('retries unavailable shares at most once per minute and rechecks availability', async () => {
    const c = await make()
    try {
      c.root.available = false
      await expect(c.source.browse(c.root.id, query)).rejects.toMatchObject({ code: 'offline' })
      await expect(c.source.browse(c.root.id, query)).rejects.toMatchObject({ code: 'offline' })
      expect(c.retry).toHaveBeenCalledOnce()
      c.state.now += 60_000
      c.retry.mockImplementationOnce(async () => { c.root.available = true; return { ok: true } })
      expect((await c.source.browse(c.root.id, query)).total).toBe(5)
      expect(c.retry).toHaveBeenCalledTimes(2)
    } finally { await c.dispose() }
  })
  it('answers offline after a few seconds while a remount is still going', async () => {
    const c = await make()
    try {
      c.root.available = false
      c.retry.mockImplementationOnce(() => new Promise(() => undefined))
      vi.useFakeTimers()
      let settled = false
      const pending = c.source.browse(c.root.id, query).finally(() => { settled = true })
      const outcome = expect(pending).rejects.toMatchObject({ code: 'offline' })
      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS - 1); expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1); await outcome
    } finally { vi.useRealTimers(); await c.dispose() }
  })
  it('treats a deleted file or folder as gone, without marking the share down', async () => {
    const c = await make(), list = vi.spyOn(c.lister, 'list')
    try {
      await expect(c.source.browse(`${c.root.id}/Gone`, query)).rejects.toMatchObject({ code: 'notFound' })
      await expect(c.source.playback(`${c.root.id}/Gone/Film.mkv`, { resume: false })).rejects.toMatchObject({ code: 'notFound' })
      expect((await c.source.browse(c.root.id, query)).total).toBe(5); expect(list).toHaveBeenCalledOnce()
    } finally { await c.dispose() }
  })
  it('plays a film whose subtitle was deleted after the folder was listed, leaving that subtitle out', async () => {
    const c = await make(), id = `${c.root.id}/Episode.2.2019.mkv`
    try {
      await c.source.browse(c.root.id, query)
      await fs.rm(join(c.root.path, 'Episode.2.2019.fr.ass'))
      expect((await c.source.playback(id, { resume: false })).subtitles.map((s) => s.title)).toEqual(['EN', 'External'])
    } finally { await c.dispose() }
  })
  it('hides entries whose item key would be too long to open', async () => {
    const c = await make()
    try {
      // `folders~smb-1234abcd/` is 21 characters, so a 279-character name makes a 300-character key.
      const fits = `${'a'.repeat(275)}.mp4`, tooLong = `${'b'.repeat(276)}.mp4`
      vi.spyOn(c.lister, 'list').mockResolvedValueOnce([fits, tooLong].map((name) => ({ name, type: 'file', mtimeMs: 0, size: 1 })))
      expect((await c.source.browse(c.root.id, query)).items.map((i) => i.id)).toEqual([`${c.root.id}/${fits}`])
    } finally { await c.dispose() }
  })
  it('saves the resume point even when the helper is not answering', async () => {
    const c = await make(), id = `${c.root.id}/Episode.2.2019.mkv`
    try {
      c.roots.mockRejectedValue(new Error('helper down'))
      await c.source.report({ sourceId: 'folders', itemId: id, data: {} }, { state: 'progress', positionSec: 40, durationSec: 100 })
      expect(c.store.get(id)).toMatchObject({ positionSec: 40, durationSec: 100 })
      await c.source.report({ sourceId: 'folders', itemId: `${c.root.id}/../x`, data: {} }, { state: 'progress', positionSec: 40 })
        .catch(() => undefined)
      expect(c.store.get(`${c.root.id}/../x`)).toBeUndefined()
    } finally { await c.dispose() }
  })
  it('remembers the name of an unplugged USB drive', async () => {
    const c = await make()
    try {
      c.root.kind = 'usb'; await c.source.libraries(); c.state.roots = []
      await expect(c.source.browse(c.root.id, query)).rejects.toMatchObject({
        code: 'notFound', message: "The USB drive Cinema isn't plugged in any more.",
      })
      await expect(c.source.browse('unknown', query)).rejects.toMatchObject({ code: 'notFound' })
    } finally { await c.dispose() }
  })
  it('returns direct playback, sidecars, stored resume and the next naturally sorted video', async () => {
    const c = await make(), id = `${c.root.id}/Episode.2.2019.mkv`
    try {
      await c.source.report({ sourceId: 'folders', itemId: id, data: {} }, { state: 'progress', positionSec: 40, durationSec: 100 })
      const plan = await c.source.playback(id, { resume: true })
      expect(plan).toMatchObject({ url: join(c.root.path, 'Episode.2.2019.mkv'), headers: {}, startSec: 40,
        durationSec: 100, method: 'direct', report: { sourceId: 'folders', itemId: id, data: {} } })
      expect(plan.next?.title).toBe('Episode 10')
      expect(plan.fallback).toBeUndefined()
      expect(plan.subtitles.map((s) => s.title)).toEqual(['EN', 'FR', 'External'])
      expect(plan.subtitles.every((s) => s.default === false)).toBe(true)
      expect((await c.source.playback(id, { resume: false })).startSec).toBe(0)
      await expect(c.source.playback(`${c.root.id}/Folder 2`, { resume: false })).rejects.toMatchObject({ code: 'notFound' })
    } finally { await c.dispose() }
  })
  it('records duration, ignores short resume points, marks watched at 90% and builds resume without reading files', async () => {
    const c = await make(), id = `${c.root.id}/Episode.2.2019.mkv`
    const handle = { sourceId: 'folders', itemId: id, data: {} }
    try {
      await c.source.report(handle, { state: 'stopped', positionSec: 29 })
      expect((await c.source.rows()).resume).toEqual([])
      await c.source.report(handle, { state: 'progress', positionSec: 35, durationSec: 100 })
      expect(c.store.get(id)).toMatchObject({ durationSec: 100, positionSec: 35, title: 'Episode 2', subtitle: '2019' })
      const list = vi.spyOn(c.lister, 'list').mockRejectedValue(new Error('must not read'))
      expect((await c.source.rows()).resume[0]).toMatchObject({ id, title: 'Episode 2', progress: 0.35 })
      expect(list).not.toHaveBeenCalled(); list.mockRestore()
      await c.source.report(handle, { state: 'stopped', positionSec: 90 })
      expect(c.store.get(id)).toMatchObject({ watched: true, positionSec: 0, durationSec: 100 })
      expect((await c.source.rows()).resume).toEqual([])
      await c.source.setWatched(id, false); await c.source.report(handle, { state: 'progress', positionSec: 40 })
      c.state.roots = []; expect((await c.source.rows()).resume).toEqual([])
    } finally { await c.dispose() }
  })
})
describe('FindLister', () => {
  it('uses bounded child processes, parses tabs in names, hides unopenable and system names and limits entries', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const run = vi.fn<CommandRunner['run']>().mockResolvedValue({ code: 0, stdout:
      'd\t1.25\t4096\tDir\0f\t2.5\t42\ta\tb.mp4\0f\t2.5\t42\ta\nc.mp4\0l\t2\t1\tsymlink\0f\t1\t1\t.hidden\0', stderr: '' })
    const lister = new FindLister({ run, spawnLines: () => ({ kill() {} }) }, logger)
    expect(await lister.list('/media/mediaos/root')).toEqual([
      { name: 'Dir', type: 'dir', mtimeMs: 1250, size: 4096 }, { name: 'a\tb.mp4', type: 'file', mtimeMs: 2500, size: 42 },
    ])
    expect(run).toHaveBeenCalledWith('find', ['-P', '/media/mediaos/root', '-mindepth', '1', '-maxdepth', '1',
      '(', '-type', 'd', '-o', '-type', 'f', ')', '-printf', '%y\\t%T@\\t%s\\t%f\\0'], { timeoutMs: 6000, maxBytes: 4194304 })
    // Node refuses an argument holding a NUL before the command even starts, so every listing on the box failed.
    expect(run.mock.calls[0]![1].some((arg) => arg.includes('\0'))).toBe(false)
    run.mockResolvedValueOnce({ code: 0, stdout: '/media/mediaos/root\n', stderr: '' })
    expect(await lister.realpath('/input')).toBe('/media/mediaos/root')
    expect(run).toHaveBeenLastCalledWith('realpath', ['-e', '--', '/input'], { timeoutMs: 5000 })
    run.mockResolvedValueOnce({ code: 0, stdout: Array.from({ length: 5002 }, (_, i) => `f\t1\t1\t${i}.mp4\0`).join(''), stderr: '' })
    expect(await lister.list('/root')).toHaveLength(5000); expect(logger.info).toHaveBeenCalledOnce()
    run.mockResolvedValueOnce({ fail: 'timeout' }); await expect(lister.list('/root')).rejects.toThrow()
    run.mockResolvedValueOnce({ fail: 'timeout' }); await expect(lister.realpath('/root')).rejects.toThrow()
  })
  it('keeps what arrived when a huge folder passes the output limit, and tells a missing path from a failure', async () => {
    const run = vi.fn<CommandRunner['run']>()
    const lister = new FindLister({ run, spawnLines: () => ({ kill() {} }) })
    run.mockResolvedValueOnce({ code: 1, stdout: 'f\t1\t1\tone.mp4\0f\t1\t1\ttw', stderr: '', truncated: true })
    expect((await lister.list('/root')).map((e) => e.name)).toEqual(['one.mp4'])
    run.mockResolvedValueOnce({ code: 1, stdout: 'f\t1\t1\tone.mp4\0', stderr: 'find: Permission denied' })
    await expect(lister.list('/root')).rejects.toThrow('Folder listing unavailable')
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: "realpath: /root/x: No such file or directory\n" })
    await expect(lister.realpath('/root/x')).rejects.toBeInstanceOf(MissingPath)
    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'realpath: /root/x: Host is down\n' })
    const failure = await lister.realpath('/root/x').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(MissingPath)
  })
  it('reports output over the limit as truncated from a real child process', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(300000))'],
      { timeoutMs: 10_000, maxBytes: 100_000 })
    expect(result).toMatchObject({ code: 1, truncated: true })
    expect('stdout' in result && result.stdout.length).toBeGreaterThan(0)
  })
  it('logs a command Node refuses to start instead of failing silently', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const result = await new NodeCommandRunner(logger).run(process.execPath, ['-e', '1', 'a\0b'], { timeoutMs: 10_000 })
    expect(result).toEqual({ fail: 'notFound' })
    expect(logger.warn).toHaveBeenCalledWith('Command could not start', process.execPath, expect.stringContaining('null bytes'))
  })
})
