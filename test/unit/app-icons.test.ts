import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appIconUrl, type AppEntry } from '@shared/apps'
import { AppIconStore, ICON_USER_AGENT, iconMime, type AppIconOptions } from '../../src/main/apps/AppIconStore'
import { composeCore } from '../../src/main/core/compose'
import { registerImageProtocol } from '../../src/main/images/electron'
import { silentLog } from '../../src/main/log/Logger'
import { deferred, temporary, until } from './helpers'

const app: AppEntry = { id: 'example', name: 'Example', url: 'https://service.test/watch/start',
  nav: 'pointer', quality: 'HD', colour: '#123456' }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const newerPng = Buffer.concat([png, Buffer.from('new')])
const DAY = 24 * 60 * 60 * 1000
const fixture = (name: string): string => readFileSync(`test/fixtures/app-icons/${name}`, 'utf8')
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>

async function setup(route: Route, options: AppIconOptions = {}) {
  const temp = await temporary()
  const fetcher = vi.fn<typeof fetch>().mockImplementation((url, init) => Promise.resolve(route(new URL(String(url)), init)))
  const folder = join(temp.dir, 'app-icons')
  const opts: AppIconOptions = { apps: [app], ...options, fetch: fetcher }
  const store = new AppIconStore(folder, opts)
  return { store, fetcher, folder, opts, dispose: async () => { await store.dispose(); await temp.dispose() } }
}
const absent = (): Response => new Response(null, { status: 404 })
const direct = { ...app, iconUrl: 'https://icons.test/icon' }
afterEach(() => vi.useRealTimers())

describe('app icon discovery and requests', () => {
  it('chooses a manifest icon over a smaller touch icon, resolving redirected page and manifest URLs', async () => {
    const box = await setup((url) => {
      if (url.pathname === '/watch/start') return new Response(null, { status: 302, headers: { location: '/landing/home' } })
      if (url.pathname === '/landing/home') return new Response(fixture('page.html'))
      if (url.pathname === '/assets/site.webmanifest') {
        return new Response(null, { status: 307, headers: { location: 'https://cdn.test/brand/site.webmanifest' } })
      }
      if (url.pathname === '/brand/site.webmanifest') return new Response(fixture('site.webmanifest'))
      if (url.href === 'https://cdn.test/brand/large.png') return new Response(png, { headers: { 'content-type': 'text/html' } })
      return absent()
    })
    try {
      const result = await box.store.resolve(app.id)
      expect(result).toEqual({ status: 200, mime: 'image/png', body: png })
      expect(box.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        app.url, 'https://service.test/landing/home', 'https://service.test/assets/site.webmanifest',
        'https://cdn.test/brand/site.webmanifest', 'https://cdn.test/brand/large.png',
      ])
      for (const [, init] of box.fetcher.mock.calls) {
        expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': ICON_USER_AGENT } })
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(new Headers(init?.headers).has('cookie')).toBe(false)
      }
      expect(ICON_USER_AGENT).not.toMatch(/mediaos|device/i)
    } finally { await box.dispose() }
  })
  it('tries candidates until their bytes pass, then touch-icon and favicon fallbacks on the final origin', async () => {
    const paths: string[] = []
    const box = await setup((url) => {
      paths.push(url.href)
      if (url.href === app.url) return new Response(null, { status: 302, headers: { location: 'https://final.test/page' } })
      if (url.pathname === '/page') return new Response('<link rel=icon sizes=180x180 href=/fake.png>')
      if (url.pathname === '/fake.png') return new Response('<html>Not an image</html>', { headers: { 'content-type': 'image/png' } })
      if (url.pathname === '/favicon.ico') return new Response(Buffer.from([0, 0, 1, 0, 1, 0]))
      return absent()
    })
    try {
      expect(await box.store.resolve(app.id)).toMatchObject({ status: 200, mime: 'image/x-icon' })
      expect(paths).toEqual([app.url, 'https://final.test/page', 'https://final.test/fake.png',
        'https://final.test/apple-touch-icon.png', 'https://final.test/favicon.ico'])
    } finally { await box.dispose() }
  })
  it.each([5, 6])('allows at most five redirects (%i requested)', async (hops) => {
    const box = await setup((url) => {
      const index = Number(url.pathname.slice(1))
      return index < hops ? new Response(null, { status: 302, headers: { location: `/${index + 1}` } }) : new Response(png)
    }, { apps: [{ ...direct, iconUrl: 'https://icons.test/0' }] })
    try {
      expect((await box.store.resolve(app.id)).status).toBe(hops === 5 ? 200 : 404)
      expect(box.fetcher).toHaveBeenCalledTimes(6)
    } finally { await box.dispose() }
  })
  it.each(['http://icons.test/icon', 'file:///icon', 'https://name:secret@icons.test/icon']) (
    'refuses insecure or credential-bearing redirects to %s', async (destination) => {
      const box = await setup(() => new Response(null, { status: 302, headers: { location: destination } }), { apps: [direct] })
      try {
        expect((await box.store.resolve(app.id)).status).toBe(404)
        expect(box.fetcher).toHaveBeenCalledTimes(1)
      } finally { await box.dispose() }
    },
  )
  it('never requests insecure page, manifest, candidate or explicit icon URLs', async () => {
    const box = await setup((url) => url.href === app.url
      ? new Response('<link rel=manifest href=http://unsafe.test/app.json><link rel=icon sizes=512x512 href=http://unsafe.test/icon>')
      : absent())
    try {
      expect((await box.store.resolve(app.id)).status).toBe(404)
      expect(box.fetcher.mock.calls.every(([url]) => String(url).startsWith('https:'))).toBe(true)
      for (const entry of [{ ...app, url: 'http://unsafe.test/' }, { ...direct, iconUrl: 'http://unsafe.test/' }]) {
        box.fetcher.mockClear()
        // Different folder prevents a cached failure from being the reason no network call occurs.
        const uncached = new AppIconStore(join(box.folder, entry.iconUrl ? 'icon' : 'page'), { apps: [entry], fetch: box.fetcher })
        expect((await uncached.resolve(app.id)).status).toBe(404)
        expect(box.fetcher).not.toHaveBeenCalled()
        await uncached.dispose()
      }
    } finally { await box.dispose() }
  })
  it('uses only iconUrl when present and detects SVG after a BOM, XML declaration and comments', async () => {
    const svg = '\ufeff \n<?xml version="1.0"?> <!-- site icon -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'
    const box = await setup(() => new Response(svg, { headers: { 'content-type': 'application/octet-stream' } }), { apps: [direct] })
    try {
      expect(await box.store.resolve(app.id)).toMatchObject({ status: 200, mime: 'image/svg+xml' })
      expect(box.fetcher).toHaveBeenCalledTimes(1)
      expect(String(box.fetcher.mock.calls[0]?.[0])).toBe(direct.iconUrl)
    } finally { await box.dispose() }
  })
  it.each(['manifest', 'icon'] as const)('enforces the %s body cap on declared and streamed bodies', async (kind) => {
    const cap = { manifest: 256 * 1024, icon: 1024 * 1024 }[kind]
    for (const declared of [false, true]) {
      let cancelled = false
      const box = await setup((url) => {
        const target = `https://service.test/${kind}`
        if (url.href === target) {
          const bytes = Buffer.concat([kind === 'icon' ? png : Buffer.alloc(0), Buffer.alloc(cap + 1)])
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(bytes) }, cancel() { cancelled = true },
          })
          return new Response(stream, { headers: declared ? { 'content-length': String(cap + 1) } : {} })
        }
        if (url.href === app.url) return new Response(kind === 'manifest'
          ? '<link rel=manifest href=/manifest>' : '<link rel=icon sizes=180x180 href=/icon>')
        return absent()
      })
      try {
        expect((await box.store.resolve(app.id)).status).toBe(404)
        expect(cancelled).toBe(true)
      } finally { await box.dispose() }
    }
  })
  it('reads only the first megabyte of a longer page, declared or streamed, and still finds its icon', async () => {
    const cap = 1024 * 1024
    for (const declared of [false, true]) {
      let cancelled = false
      const head = Buffer.from('<link rel=icon sizes=32x32 href=/small.png>'.padEnd(cap - 10, ' '))
      const tail = Buffer.from('<link rel=icon sizes=512x512 href=/late.png>')
      const box = await setup((url) => {
        if (url.href === app.url) {
          const chunks = [head, tail, Buffer.alloc(cap)]
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next) }, cancel() { cancelled = true },
          })
          return new Response(stream, { headers: declared ? { 'content-length': String(3 * cap) } : {} })
        }
        if (url.pathname === '/small.png') return new Response(png)
        return absent()
      })
      try {
        expect(await box.store.resolve(app.id)).toMatchObject({ status: 200, mime: 'image/png' })
        expect(cancelled).toBe(true)
        expect(box.fetcher.mock.calls.map(([url]) => String(url))).not.toContain('https://service.test/late.png')
      } finally { await box.dispose() }
    }
  })
  it('looks for icons on iconPage instead of the app page when one is given', async () => {
    const box = await setup((url) => {
      if (url.href === 'https://brand.test/') return new Response('<link rel=icon sizes=192x192 href=/brand.png>')
      if (url.href === 'https://brand.test/brand.png') return new Response(png)
      return absent()
    }, { apps: [{ ...app, iconPage: 'https://brand.test/' }] })
    try {
      expect((await box.store.resolve(app.id)).status).toBe(200)
      expect(box.fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://brand.test/', 'https://brand.test/brand.png'])
    } finally { await box.dispose() }
  })
  it('accepts HTML, manifest and icon bodies exactly at their caps', async () => {
    const html = '<link rel=manifest href=/manifest>'
    const manifest = JSON.stringify({ icons: [{ src: '/icon', sizes: '192x192' }] })
    const bytes = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)])
    const box = await setup((url) => {
      if (url.href === app.url) return new Response(html.padEnd(1024 * 1024, ' '))
      if (url.pathname === '/manifest') return new Response(manifest.padEnd(256 * 1024, ' '))
      return new Response(bytes)
    })
    try { expect((await box.store.resolve(app.id)).body).toEqual(bytes) }
    finally { await box.dispose() }
  })
  it('ends a stalled request after ten seconds, even if the injected fetch ignores abort', async () => {
    const stalled = deferred<Response>()
    const box = await setup(() => stalled.promise, { apps: [direct] })
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const result = box.store.resolve(app.id)
      await until(() => box.fetcher.mock.calls.length === 1)
      await vi.advanceTimersByTimeAsync(10_000)
      vi.useRealTimers()
      expect((await result).status).toBe(404)
    } finally { await box.dispose() }
  })
  it('limits the whole lookup to thirty seconds, including a stalled body reader', async () => {
    const box = await setup((url) => {
      if (url.href === app.url) return new Response('<link rel=icon href=/a><link rel=icon href=/b><link rel=icon href=/c>')
      return new Response(new ReadableStream<Uint8Array>({ start() {} }))
    })
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const result = box.store.resolve(app.id)
      await until(() => box.fetcher.mock.calls.length === 2)
      await vi.advanceTimersByTimeAsync(30_000)
      vi.useRealTimers()
      expect((await result).status).toBe(404)
      expect(box.fetcher).toHaveBeenCalledTimes(4)
    } finally { await box.dispose() }
  })
  it('gives each redirect request its own ten-second timeout within the overall deadline', async () => {
    const box = await setup(async (url) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 6000))
      return url.pathname === '/icon'
        ? new Response(null, { status: 302, headers: { location: '/final' } }) : new Response(png)
    }, { apps: [direct] })
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const result = box.store.resolve(app.id)
      await until(() => box.fetcher.mock.calls.length === 1)
      await vi.advanceTimersByTimeAsync(12_000)
      vi.useRealTimers()
      expect((await result).status).toBe(200)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
    } finally { await box.dispose() }
  })
})

describe('icon byte signatures', () => {
  it.each([
    [png, 'image/png'], [Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
    [Buffer.from('RIFF1234WEBP'), 'image/webp'], [Buffer.from('GIF87a'), 'image/gif'], [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from([0, 0, 1, 0, 1, 0]), 'image/x-icon'], [Buffer.from('<svg/>'), 'image/svg+xml'],
    [Buffer.from(' \n<!-- one --><!-- two --> <svg viewBox="0 0 1 1"></svg>'), 'image/svg+xml'],
  ])('recognises bytes regardless of their URL or content type (%s)', (bytes, mime) => { expect(iconMime(bytes)).toBe(mime) })
  it.each(['', '<html><svg/></html>', '<svg-script/>', '<!-- unfinished', '<?xml unfinished', 'RIFF1234WAVE', 'GIF88a']) (
    'refuses invalid image bytes %s', (value) => { expect(iconMime(Buffer.from(value))).toBeUndefined() },
  )
  it('does not mistake high-bit bytes for ASCII image signatures', () => {
    for (const text of ['GIF89a', 'RIFF1234WEBP']) {
      const bytes = Buffer.from(text).map((byte) => byte | 0x80)
      expect(iconMime(bytes)).toBeUndefined()
    }
  })
})

describe('app icon cache', () => {
  it('atomically writes bytes and a note, then serves them across restarts without fetch', async () => {
    const info = vi.fn()
    const box = await setup(() => new Response(png), { apps: [{ ...direct, iconUrl: `${direct.iconUrl}?token=secret` }],
      now: () => 1234, logger: { ...silentLog, info } })
    try {
      const [a, b] = await Promise.all([box.store.resolve(app.id), box.store.resolve(app.id)])
      expect(a.body).toEqual(png); expect(b.body).toEqual(png)
      expect(box.fetcher).toHaveBeenCalledTimes(1)
      expect(await fs.readdir(box.folder)).toEqual(['example.bin', 'example.json'])
      expect(await fs.readFile(join(box.folder, 'example.bin'))).toEqual(png)
      expect(JSON.parse(await fs.readFile(join(box.folder, 'example.json'), 'utf8'))).toEqual({
        mime: 'image/png', fetchedAt: 1234, url: direct.iconUrl,
      })
      expect(info).toHaveBeenCalledExactlyOnceWith('example: icon found (https://icons.test/)')
      const restarted = new AppIconStore(box.folder, box.opts)
      a.body[0] = 0
      expect((await restarted.resolve(app.id)).body).toEqual(png)
      expect((await box.store.resolve(app.id)).body).toEqual(png)
      expect(box.fetcher).toHaveBeenCalledTimes(1)
      await restarted.dispose()
    } finally { await box.dispose() }
  })
  it('serves stale bytes at once and shares one background refresh, retaining old bytes on failure', async () => {
    let now = 1, refresh = false
    const info = vi.fn(), gate = deferred<Response>()
    const box = await setup(() => refresh ? gate.promise : new Response(png),
      { apps: [direct], now: () => now, logger: { ...silentLog, info } })
    try {
      await box.store.resolve(app.id)
      now += 30 * DAY + 1; refresh = true
      const results = await Promise.all(Array.from({ length: 8 }, () => box.store.resolve(app.id)))
      expect(results.every((result) => Buffer.from(result.body).equals(png))).toBe(true)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
      gate.resolve(absent())
      await until(() => info.mock.calls.length === 2)
      expect((await box.store.resolve(app.id)).body).toEqual(png)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
      await box.store.dispose()
      const restarted = new AppIconStore(box.folder, box.opts)
      expect((await restarted.resolve(app.id)).body).toEqual(png)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
      await restarted.dispose()
    } finally { await box.dispose() }
  })
  it('replaces a stale icon after a successful background refresh', async () => {
    let now = 1
    const info = vi.fn()
    const box = await setup(() => new Response(now === 1 ? png : newerPng),
      { apps: [direct], now: () => now, logger: { ...silentLog, info } })
    try {
      await box.store.resolve(app.id)
      now += 30 * DAY + 1
      expect((await box.store.resolve(app.id)).body).toEqual(png)
      await until(() => info.mock.calls.length === 2)
      expect((await box.store.resolve(app.id)).body).toEqual(newerPng)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
    } finally { await box.dispose() }
  })
  it('persists failure for 24 hours, then retries once for concurrent callers', async () => {
    let now = 1, succeed = false
    const info = vi.fn()
    const box = await setup(() => succeed ? new Response(png) : absent(),
      { apps: [direct], now: () => now, logger: { ...silentLog, info } })
    try {
      expect((await box.store.resolve(app.id)).status).toBe(404)
      expect(info).toHaveBeenCalledExactlyOnceWith('example: no icon (https://icons.test/)')
      const restarted = new AppIconStore(box.folder, box.opts)
      now += DAY - 1
      expect((await restarted.resolve(app.id)).status).toBe(404)
      expect(box.fetcher).toHaveBeenCalledTimes(1)
      now++; succeed = true
      const results = await Promise.all([restarted.resolve(app.id), restarted.resolve(app.id)])
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(box.fetcher).toHaveBeenCalledTimes(2)
      await restarted.dispose()
    } finally { await box.dispose() }
  })
  it('does not remember a lookup cut short by shutdown as a failure', async () => {
    const started = deferred<void>()
    const box = await setup(() => { started.resolve(); return new Promise<Response>(() => {}) })
    try {
      const pending = box.store.resolve(app.id)
      await started.promise
      await box.store.dispose()
      expect((await pending).status).toBe(404)
      await expect(fs.readdir(box.folder)).rejects.toThrow()
      const restarted = new AppIconStore(box.folder, { ...box.opts, 
        fetch: vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(png))) })
      expect((await restarted.resolve(app.id)).status).toBe(200)
      await restarted.dispose()
    } finally { await box.dispose() }
  })
  it('still serves a found icon when the cache folder is not writable', async () => {
    const box = await setup(() => new Response(png), { apps: [direct] })
    try {
      await fs.writeFile(box.folder, 'A file instead of a folder', 'utf8')
      expect((await box.store.resolve(app.id)).body).toEqual(png)
      expect((await box.store.resolve(app.id)).status).toBe(200)
      expect(box.fetcher).toHaveBeenCalledTimes(1)
    } finally { await box.dispose() }
  })
  it('recovers from malformed cache metadata or bytes', async () => {
    const box = await setup(() => new Response(png), { apps: [direct] })
    try {
      await fs.mkdir(box.folder, { recursive: true })
      for (const note of ['{', '{"failedAt":"forever"}', '{"mime":"image/png","fetchedAt":1,"url":"https://icons.test/"}']) {
        await fs.writeFile(join(box.folder, 'example.json'), note, 'utf8')
        await fs.writeFile(join(box.folder, 'example.bin'), '<html>wrong</html>', 'utf8')
        const restarted = new AppIconStore(box.folder, box.opts)
        expect((await restarted.resolve(app.id)).body).toEqual(png)
        await restarted.dispose()
      }
      expect(box.fetcher).toHaveBeenCalledTimes(3)
    } finally { await box.dispose() }
  })
  it('answers 404 with no network call for unknown, invalid and disabled app ids, even with a cached icon', async () => {
    const box = await setup(() => new Response(png), { apps: [direct] })
    try {
      await box.store.resolve(app.id)
      box.fetcher.mockClear()
      const off = new AppIconStore(box.folder, { ...box.opts, mode: 'off' })
      for (const id of ['unknown', '../example', 'Example', 'x'.repeat(65), 'example\n']) {
        expect((await box.store.resolve(id)).status).toBe(404)
      }
      expect((await off.resolve(app.id)).status).toBe(404)
      expect(box.fetcher).not.toHaveBeenCalled()
      await off.dispose()
    } finally { await box.dispose() }
  })
  it('compose exposes the icon store next to artwork and honours its off option', async () => {
    const temp = await temporary()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      appIcons: 'off', forceMockPlayer: true, restartShell() {} })
    try {
      expect((await composed.appIcons.resolve('youtube')).status).toBe(404)
      expect(composed.images).toBeDefined()
    } finally { await composed.dispose(); await temp.dispose() }
  })
})

describe('app icon protocol routing', () => {
  function protocol() {
    const artwork = { resolve: vi.fn().mockResolvedValue({ status: 200, mime: 'image/png', body: png }) }
    const icons = { resolve: vi.fn().mockResolvedValue({ status: 200, mime: 'image/svg+xml', body: Buffer.from('<svg/>') }) }
    let handler!: (request: Request) => Promise<Response>
    registerImageProtocol((_scheme, cb) => { handler = cb }, artwork, icons)
    return { artwork, icons, request: (url: string) => handler({ url } as Request) }
  }
  it('routes app URLs to the store and existing artwork URLs unchanged to the resolver', async () => {
    const box = protocol()
    expect(appIconUrl('app /?')).toBe('mediaos-img://app/app%20%2F%3F')
    const icon = await box.request(appIconUrl('example'))
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(icon.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await icon.text()).toBe('<svg/>')
    expect(box.icons.resolve).toHaveBeenCalledExactlyOnceWith('example')
    const url = 'mediaos-img://img/demo/id/poster?w=400&h=600'
    expect((await box.request(url)).status).toBe(200)
    expect(box.artwork.resolve).toHaveBeenCalledExactlyOnceWith(url)
  })
  it.each(['mediaos-img://app/Example', 'mediaos-img://app/x/y', 'mediaos-img://app/%00', 'mediaos-img://app/%7f',
    'mediaos-img://app/example%0a',
    'mediaos-img://app/%ZZ', 'mediaos-img://app/a?x=1', 'mediaos-img://app/a?', 'mediaos-img://app/a#',
    'mediaos-img://app/a#hash', 'mediaos-img://app/a/../example', 'mediaos-img://app/%2e%2e/example',
    'mediaos-img://app/a\\b', 'mediaos-img://app/a\nb', 'mediaos-img://app/', 'mediaos-img://wrong/a',
    'mediaos-img://user@app/a', 'http://app/a', `mediaos-img://app/${'x'.repeat(65)}`]) (
    'rejects malformed app URL %s before routing', async (url) => {
      const box = protocol()
      const response = await box.request(url)
      expect(response.status).toBe(400)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(box.artwork.resolve).not.toHaveBeenCalled()
      expect(box.icons.resolve).not.toHaveBeenCalled()
    },
  )
  it('decodes valid ids and preserves the store 404 response', async () => {
    const box = protocol()
    box.icons.resolve.mockResolvedValue({ status: 404, mime: 'text/plain', body: Buffer.alloc(0) })
    expect((await box.request('mediaos-img://app/%65xample')).status).toBe(404)
    expect(box.icons.resolve).toHaveBeenCalledExactlyOnceWith('example')
  })
})
