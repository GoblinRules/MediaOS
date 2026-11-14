import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { DiskCache } from '../../src/main/images/DiskCache'
import { ImageResolver } from '../../src/main/images/ImageResolver'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { prepareProfile } from '../../src/main/apps/chrome'
import { ChromeAppHost } from '../../src/main/apps/ChromeAppHost'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { createMockSystem } from '../../src/main/system/mock/MockSystemServices'
import { MockSignInService } from '../../src/main/signin/MockSignInService'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { silentLog } from '../../src/main/log/Logger'
import { runtime } from '../../src/main/core/runtime'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { deferred, temporary, until } from './helpers'

afterEach(() => vi.useRealTimers())
describe('image cache reset and content types', () => {
  it('tries every cached file after deletion fails and always clears the in-memory index', async () => {
    const temp = await temporary(), warn = vi.fn()
    const a = DiskCache.key(['a']), b = DiskCache.key(['b']), value = { mime: 'image/png', body: Buffer.from('png') }
    try {
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => {
        if (String(args[0]).endsWith(`${a}.img`)) throw new Error('locked')
        await fs.rm(...args)
      })
      const cache = new DiskCache(temp.dir, { fs: { ...fs, rm }, logger: { ...silentLog, warn } })
      await cache.put(a, value); await cache.put(b, value)
      await cache.clear()
      expect(rm.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([
        join(temp.dir, `${a}.img`), join(temp.dir, `${b}.img`),
      ]))
      expect(warn).toHaveBeenCalledOnce()
      expect(await cache.get(a)).toBeUndefined(); expect(await cache.get(b)).toBeUndefined()
      expect(await fs.readdir(temp.dir)).toEqual([`${a}.img`])
    } finally { await temp.dispose() }
  })
  it('drops puts queued before or during clear, then permits new puts afterwards', async () => {
    const temp = await temporary(), removed = deferred<void>()
    const key = DiskCache.key(['existing']), pendingKey = DiskCache.key(['queued'])
    const value = { mime: 'image/png', body: Buffer.from('png') }
    try {
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => { await removed.promise; await fs.rm(...args) })
      const cache = new DiskCache(temp.dir, { fs: { ...fs, rm } })
      await cache.put(key, value)
      const queued = cache.put(pendingKey, value), clear = cache.clear()
      await until(() => rm.mock.calls.length > 0)
      const during = cache.put(key, value)
      removed.resolve(); await Promise.all([queued, clear, during])
      expect(await fs.readdir(temp.dir)).toEqual([])
      await cache.put(key, value); expect(await cache.get(key)).toBeDefined()
    } finally { await temp.dispose() }
  })
  it('does not cache an HTTP fetch started before clear and finished after it', async () => {
    const temp = await temporary(), source = new FixtureSource(), response = deferred<Response>()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://test/image', headers: {} })
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    try {
      const cache = new DiskCache(temp.dir), resolver = new ImageResolver({ get: () => source }, cache, { fetch: fetcher })
      const request = resolver.resolve('mediaos-img://img/demo/id/poster')
      await until(() => fetcher.mock.calls.length === 1)
      await cache.clear()
      response.resolve(new Response('png', { headers: { 'content-type': 'image/png' } }))
      expect((await request).status).toBe(200)
      expect(await fs.readdir(temp.dir)).toEqual([])
    } finally { await temp.dispose() }
  })
  it.each(['image/svg+xml', 'image/bmp', 'image/x-custom'])('rejects server content type %s before caching', async (mime) => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://test/image', headers: {} })
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('<svg/>', { headers: { 'content-type': mime } })),
      })
      expect((await resolver.resolve('mediaos-img://img/demo/id/poster')).status).toBe(502)
      expect(await fs.readdir(temp.dir)).toEqual([])
    } finally { await temp.dispose() }
  })
  it.each(['jpeg', 'png', 'webp', 'gif', 'avif'])('accepts server raster image/%s', async (kind) => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://test/image', headers: {} })
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('raster', { headers: { 'content-type': `image/${kind}` } })),
      })
      expect((await resolver.resolve('mediaos-img://img/demo/id/poster')).status).toBe(200)
      expect(await fs.readdir(temp.dir)).toHaveLength(1)
    } finally { await temp.dispose() }
  })
})

describe('profiles, diagnostics and sign-in limits', () => {
  it('repairs invalid profile JSON with a fixed log message and launches the app', async () => {
    const temp = await temporary(), warn = vi.fn()
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('exit', 0)); return true })
    const spawn = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child })
    const host = new ChromeAppHost({ profileDir: temp.dir, chromePath: 'chrome', spawn, logger: { ...silentLog, warn } })
    try {
      const dir = join(temp.dir, 'youtube')
      await fs.mkdir(join(dir, 'Default'), { recursive: true })
      await fs.writeFile(join(dir, 'Default', 'Preferences'), '{"private-fragment"', 'utf8')
      await host.launch(APP_CATALOG.find((a) => a.id === 'youtube')!, { kind: 'direct' })
      expect(spawn).toHaveBeenCalledOnce()
      expect(JSON.parse(await fs.readFile(join(dir, 'Default', 'Preferences'), 'utf8'))).toEqual({
        profile: { exited_cleanly: true, exit_type: 'Normal' },
      })
      expect(warn.mock.calls).toEqual([['Chrome preferences damaged; starting empty']])
      const error = Object.assign(new Error('access denied'), { code: 'EACCES' })
      await expect(prepareProfile(dir, { ...fs, readFile: async () => { throw error } })).rejects.toBe(error)
    } finally { await host.close(); await temp.dispose() }
  })
  it('keeps only the newest three diagnostics without deleting other logs or files', async () => {
    const temp = await temporary()
    let now = 100
    const system = createMockSystem({ logDir: temp.dir, clock: { ...runtime, now: () => now } })
    try {
      await fs.writeFile(join(temp.dir, 'mediaos.log'), 'keep', 'utf8')
      await fs.writeFile(join(temp.dir, 'diagnostics-not-a-bundle.txt'), 'keep too', 'utf8')
      for (now = 100; now <= 104; now++) await system.info.collectDiagnostics()
      const files = await fs.readdir(temp.dir)
      expect(files.filter((name) => /^diagnostics-\d+\.txt$/.test(name)).sort()).toEqual([
        'diagnostics-102.txt', 'diagnostics-103.txt', 'diagnostics-104.txt',
      ])
      expect(await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')).toBe('keep')
      expect(files).toContain('diagnostics-not-a-bundle.txt')
    } finally { system.dispose(); await temp.dispose() }
  })
  it('rejects single sign-ins at twenty and a Plex batch at nineteen without partial additions', async () => {
    const temp = await temporary(), hub = new MediaHub()
    const settings = await SettingsStore.open(join(temp.dir, 'settings.json'))
    const signin = new MockSignInService(hub, settings, { delayMs: 0 })
    const message = "You've reached the limit of 20 libraries. Remove one in Settings > Libraries first."
    try {
      const sources = Array.from({ length: 20 }, (_, i) => ({ id: `source-${i}`, name: `Library ${i}`,
        kind: 'fixture' as const, enabled: true }))
      settings.update({ sources })
      await expect(signin.password('http://test', 'guest', 'demo')).rejects.toThrow(message)
      await expect(signin.password('http://test', 'guest', 'wrong')).rejects.toThrow(message)
      await expect(signin.quickConnect('http://test')).rejects.toThrow(message)
      await expect(signin.plexPin()).rejects.toThrow(message)
      settings.update({ sources: sources.slice(0, 19) })
      const quick = await signin.quickConnect('http://test')
      settings.update({ sources })
      await signin.poll(quick.flowId); await signin.poll(quick.flowId)
      await expect(signin.poll(quick.flowId)).rejects.toThrow(message)
      settings.update({ sources: sources.slice(0, 19) })
      const plex = await signin.plexPin()
      await signin.poll(plex.flowId); await signin.poll(plex.flowId); await signin.poll(plex.flowId)
      for (let n = 0; n < 2; n++) {
        await expect(signin.plexAddServers(plex.flowId, ['home-plex', 'dad-plex', 'home-plex'])).rejects.toThrow(message)
        expect(settings.get().sources).toHaveLength(19); expect(hub.list()).toHaveLength(0)
      }
      await signin.plexAddServers(plex.flowId, ['home-plex', 'home-plex'])
      expect(settings.get().sources).toHaveLength(20); expect(hub.list()).toHaveLength(1)
    } finally { signin.dispose(); hub.dispose(); await settings.flush(); await temp.dispose() }
  })
})
