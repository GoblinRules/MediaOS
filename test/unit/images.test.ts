import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { imageUrl } from '@shared/media-types'
import { parseImageUrl } from '../../src/main/images/parseImageUrl'
import { DiskCache } from '../../src/main/images/DiskCache'
import { ImageResolver } from '../../src/main/images/ImageResolver'
import { registerImageProtocol } from '../../src/main/images/electron'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { temporary } from './helpers'

describe('image URLs', () => {
  it('decodes opaque ids, clamps and rounds sizes to buckets', () => {
    const url = imageUrl({ sourceId: 'living room', id: 'folder/a' }, 'poster', -5, 9999)
    expect(parseImageUrl(url)).toEqual({ sourceId: 'living room', itemId: 'folder/a', kind: 'poster', w: 40, h: 3840 })
    expect(parseImageUrl('mediaos-img://img/demo/id/thumb?w=81&h=119')).toMatchObject({ w: 80, h: 120 })
  })
  it.each([
    'http://img/demo/id/poster', 'mediaos-img://wrong/demo/id/poster', 'mediaos-img://img/demo/id/unknown',
    'mediaos-img://img/demo/id/poster/extra', 'mediaos-img://img/demo//poster', 'mediaos-img://img/demo/%ZZ/poster',
    'mediaos-img://img/demo/id/poster?w=NaN', 'mediaos-img://img/demo/id/poster?h=Infinity',
    'mediaos-img://img/demo/id/poster?w=40&w=80', 'mediaos-img://img/demo/id/poster?token=secret',
    'mediaos-img://img/demo/id/poster#hash', 'mediaos-img://img/demo/x/../id/poster', 'mediaos-img://img/demo/%00/poster',
  ])('rejects %s', (url) => { expect(() => parseImageUrl(url)).toThrow() })
})

describe('image resolver and disk cache', () => {
  it('returns inline images, missing images, unknown sources and invalid requests', async () => {
    const temp = await temporary()
    const source = new FixtureSource()
    try {
      const resolver = new ImageResolver({ get: (id) => id === 'demo' ? source : undefined }, new DiskCache(temp.dir))
      const item = (await source.rows()).latest[0]!
      const result = await resolver.resolve(imageUrl(item, 'poster', 400, 600))
      expect(result.status).toBe(200); expect(result.mime).toBe('image/svg+xml')
      expect(Buffer.from(result.body).toString()).toContain('<svg')
      expect((await resolver.resolve(imageUrl(item, 'logo', 40, 40))).status).toBe(404)
      expect((await resolver.resolve('mediaos-img://img/missing/id/poster')).status).toBe(404)
      expect((await resolver.resolve('invalid')).status).toBe(400)
    } finally { source.dispose(); await temp.dispose() }
  })
  it('fetches with headers, shares concurrent requests, and survives cache restarts', async () => {
    const temp = await temporary()
    const source = new FixtureSource()
    const image = vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://server.test/image?token=secret',
      authOrigin: 'https://server.test', headers: { 'X-Plex-Token': 'secret' } })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('png data', { headers: { 'content-type': 'image/png' } }))
    const url = 'mediaos-img://img/demo/id/poster?w=400&h=600'
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher })
      const [a, b] = await Promise.all([resolver.resolve(url), resolver.resolve(url)])
      expect(a.status).toBe(200); expect(b.body).toEqual(a.body)
      expect(fetcher).toHaveBeenCalledTimes(1); expect(image).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ 'X-Plex-Token': 'secret' })
      expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
      const restarted = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher })
      expect((await restarted.resolve(url)).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { source.dispose(); await temp.dispose() }
  })
  it('rejects non-image content, failed responses, oversized declared and streamed bodies', async () => {
    const temp = await temporary()
    const source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://test/image', headers: {} })
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } }))
        .mockResolvedValueOnce(new Response('no', { status: 404 }))
        .mockResolvedValueOnce(new Response('large', { headers: { 'content-type': 'image/png', 'content-length': '1000' } }))
        .mockResolvedValueOnce(new Response('larger than cap', { headers: { 'content-type': 'image/png' } }))
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher, maxBytes: 8 })
      const url = 'mediaos-img://img/demo/id/poster'
      expect((await resolver.resolve(url)).status).toBe(502)
      expect((await resolver.resolve(url)).status).toBe(404)
      expect((await resolver.resolve(url)).status).toBe(502)
      expect((await resolver.resolve(url)).status).toBe(413)
    } finally { source.dispose(); await temp.dispose() }
  })
  it('evicts the oldest used entry, persists use times, clears and never throws on cache failures', async () => {
    const temp = await temporary()
    let now = Date.now()
    const options = { maxBytes: 30, now: () => ++now }
    const a = DiskCache.key(['a']), b = DiskCache.key(['b']), c = DiskCache.key(['c'])
    try {
      const cache = new DiskCache(temp.dir, options)
      await cache.put(a, { mime: 'image/png', body: Buffer.from('aaaa') })
      await cache.put(b, { mime: 'image/png', body: Buffer.from('bbbb') })
      await cache.get(a)
      const restarted = new DiskCache(temp.dir, options)
      await restarted.put(c, { mime: 'image/png', body: Buffer.from('cccc') })
      expect(await restarted.get(b)).toBeUndefined()
      expect(await restarted.get(a)).toBeDefined(); expect(await restarted.get(c)).toBeDefined()
      await restarted.clear(); expect(await fs.readdir(temp.dir)).toEqual([])
      const bad = new DiskCache(join(temp.dir, 'no'), { fs: { ...fs, mkdir: async () => { throw new Error('read only') } } })
      await expect(bad.put(a, { mime: 'image/png', body: Buffer.from('x') })).resolves.toBeUndefined()
      expect(await bad.get(a)).toBeUndefined()
    } finally { await temp.dispose() }
  })
  it('registers a thin protocol handler returning a Response', async () => {
    const resolve = vi.fn().mockResolvedValue({ status: 200, mime: 'image/png', body: Buffer.from('image') })
    let handler: ((request: Request) => Promise<Response>) | undefined
    registerImageProtocol((scheme, cb) => { expect(scheme).toBe('mediaos-img'); handler = cb }, { resolve } as unknown as ImageResolver)
    const response = await handler!(new Request('mediaos-img://img/demo/id/poster'))
    expect(await response.text()).toBe('image'); expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
