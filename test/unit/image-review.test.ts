import { describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DiskCache } from '../../src/main/images/DiskCache'
import { ImageResolver } from '../../src/main/images/ImageResolver'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { temporary } from './helpers'

const imageUrl = 'mediaos-img://img/demo/id/poster'
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
  } }
}

describe('artwork trust boundaries', () => {
  it('logs only the artwork host and path after a failed request', async () => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http',
      url: 'https://user:password@server.test/art?tag=private-tag&token=private-token#private-fragment', headers: {} })
    const warn = vi.fn()
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), {
        fetch: async () => { throw Error('network failure') }, logger: { debug() {}, info() {}, warn, error() {} },
      })
      expect((await resolver.resolve(imageUrl)).status).toBe(502)
      expect(warn.mock.calls).toEqual([['Artwork request failed', 'https://server.test/art']])
    } finally { source.dispose(); await temp.dispose() }
  })
  it.each(['text/html', 'application/javascript', 'image/bmp'])('rejects inline %s', async (mime) => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'inline', mime, body: '<script>bad</script>' })
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir))
      expect((await resolver.resolve(imageUrl)).status).toBe(502)
    } finally { await temp.dispose() }
  })
  it.each(['jpeg', 'png', 'webp', 'gif', 'avif', 'svg+xml'])('accepts locally generated inline image/%s', async (type) => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'inline', mime: `image/${type}`, body: 'local art' })
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir))
      expect((await resolver.resolve(imageUrl)).status).toBe(200)
    } finally { await temp.dispose() }
  })
  it('keeps headers on same-origin redirects and drops them for cross-origin and absolute third-party images', async () => {
    const temp = await temporary(), source = new FixtureSource()
    const received: (string | undefined)[] = [], foreign: (string | undefined)[] = []
    const other = await server((req, res) => {
      foreign.push(req.headers['x-plex-token'] as string | undefined)
      res.writeHead(200, { 'content-type': 'image/png' }); res.end('png')
    })
    const home = await server((req, res) => {
      received.push(req.headers['x-plex-token'] as string | undefined)
      if (req.url === '/same') { res.writeHead(302, { location: '/image' }); res.end('redirect'); return }
      if (req.url === '/cross') { res.writeHead(302, { location: `${other.origin}/image` }); res.end('redirect'); return }
      res.writeHead(200, { 'content-type': 'image/png' }); res.end('png')
    })
    const image = vi.spyOn(source, 'image')
    try {
      for (const [i, url] of [`${home.origin}/same`, `${home.origin}/cross`, `${other.origin}/image`].entries()) {
        image.mockReturnValue({ kind: 'http', url, authOrigin: home.origin, headers: { 'X-Plex-Token': 'private' } })
        const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir))
        expect((await resolver.resolve(imageUrl.replace('/id/', `/id-${i}/`))).status).toBe(200)
      }
      expect(received).toEqual(['private', 'private', 'private'])
      expect(foreign).toEqual([undefined, undefined])
    } finally { await home.close(); await other.close(); await temp.dispose() }
  })
  it('uses manual redirects, permits five hops and rejects more hops or non-HTTP destinations', async () => {
    const temp = await temporary(), source = new FixtureSource()
    const image = vi.spyOn(source, 'image')
    try {
      for (const hops of [5, 6]) {
        image.mockReturnValue({ kind: 'http', url: 'https://server.test/0', authOrigin: 'https://server.test', headers: {} })
        const bodies: Response[] = []
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
          const index = Number(new URL(String(url)).pathname.slice(1))
          const response = index < hops ? new Response('redirect', { status: 302, headers: { location: `/${index + 1}` } })
            : new Response('png', { headers: { 'content-type': 'image/png' } })
          bodies.push(response)
          return response
        })
        const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher })
        expect((await resolver.resolve(imageUrl.replace('/id/', `/hops-${hops}/`))).status).toBe(hops === 5 ? 200 : 502)
        expect(fetcher).toHaveBeenCalledTimes(6)
        expect(fetcher.mock.calls.every(([, opts]) => opts?.redirect === 'manual')).toBe(true)
        expect(bodies.filter((r) => r.status === 302).every((r) => r.body?.locked === false && r.bodyUsed)).toBe(true)
      }
      for (const url of ['file:///private.png', 'data:image/png,bad']) {
        image.mockReturnValue({ kind: 'http', url: 'https://server.test/image', headers: {} })
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('redirect', { status: 302, headers: { location: url } }))
        const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher })
        expect((await resolver.resolve(imageUrl)).status).toBe(502)
        expect(fetcher).toHaveBeenCalledTimes(1)
        image.mockReturnValue({ kind: 'http', url, headers: {} })
        expect((await resolver.resolve(imageUrl)).status).toBe(502)
        expect(fetcher).toHaveBeenCalledTimes(1)
      }
    } finally { await temp.dispose() }
  })
  it('omits source headers when their origin is missing', async () => {
    const temp = await temporary(), source = new FixtureSource()
    vi.spyOn(source, 'image').mockReturnValue({ kind: 'http', url: 'https://test/image', headers: { 'X-Emby-Token': 'private' } })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('png', { headers: { 'content-type': 'image/png' } }))
    try {
      const resolver = new ImageResolver({ get: () => source }, new DiskCache(temp.dir), { fetch: fetcher })
      expect((await resolver.resolve(imageUrl)).status).toBe(200)
      expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({})
    } finally { await temp.dispose() }
  })
})
