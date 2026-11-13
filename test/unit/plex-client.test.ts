import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexClient } from '../../src/main/sources/plex/PlexClient'
import { PlexTv } from '../../src/main/sources/plex/PlexTv'
import { jellyfinFetch, plexIdentity, plexReplay, until } from './helpers'

afterEach(() => vi.useRealTimers())
describe('Plex HTTP', () => {
  it('rejects missing and wrong replay tokens per origin, including before custom responses', async () => {
    const override = vi.fn(() => new Response(null, { status: 204 }))
    const fake = plexReplay(override)
    for (const [origin, token] of [
      ['https://plex.tv', 'private-account'], ['https://clients.plex.tv', 'private-account'],
      ['https://home-a.plex.direct:32400', 'private-server-a'], ['http://192.168.1.20:32400', 'private-server-a'],
      ['https://remote-b.plex.direct:32400', 'private-server-b'], ['http://192.168.1.30:32400', 'private-server-b'],
    ]) {
      const url = `${origin}/library/sections`
      for (const wrong of [undefined, token === 'private-account' ? 'private-server-a' : 'private-account']) {
        expect((await fake.fetch(url, { headers: wrong ? { 'X-Plex-Token': wrong } : {} })).status).toBe(401)
      }
      expect((await fake.fetch(url, { headers: { 'X-Plex-Token': token! } })).status).toBe(204)
    }
    expect((await fake.fetch('https://remote-b.plex.direct:9999/library/sections', {
      headers: { 'X-Plex-Token': 'private-server-b' },
    })).status).toBe(401)
    expect(override).toHaveBeenCalledTimes(6)
  })
  it('sends the full header set on both account hosts and server requests, with tokens only in headers', async () => {
    const fake = plexReplay(), tv = new PlexTv({ ...plexIdentity, fetch: fake.fetch })
    const client = new PlexClient({ ...plexIdentity, url: 'https://home-a.plex.direct:32400', name: 'Home Plex',
      token: 'private-server-a', fetch: fake.fetch })
    try {
      await tv.createPin(); await tv.checkPin('71'); await tv.user('private-account')
      const servers = await tv.servers('private-account')
      await client.request('/library/sections')
      expect(servers.map((s) => s.clientIdentifier)).toEqual(['server-b', 'server-a'])
      for (const call of fake.calls) {
        expect(Object.fromEntries(call.headers)).toMatchObject({ accept: 'application/json', 'x-plex-product': 'MediaOS',
          'x-plex-version': '2.3.4', 'x-plex-client-identifier': 'test-device', 'x-plex-platform': 'Linux',
          'x-plex-device': 'MediaOS', 'x-plex-device-name': 'Living room TV' })
        expect(call.url.toString()).not.toMatch(/private-|token/i)
      }
      expect(fake.calls[0]?.headers.has('X-Plex-Token')).toBe(false)
      expect(fake.calls[0]?.url.searchParams.get('strong')).toBe('false')
      expect(fake.calls.at(-1)?.headers.get('X-Plex-Token')).toBe('private-server-a')
      expect(fake.calls.find((c) => c.url.hostname === 'clients.plex.tv')?.url.searchParams.toString())
        .toBe('includeHttps=1&includeRelay=1&includeIPv6=1')
    } finally { tv.dispose(); client.dispose() }
  })
  it.each([
    [401, 'auth', 'Home Plex signed MediaOS out. Remove it in Settings and add it again.'],
    [403, 'auth', 'Home Plex signed MediaOS out. Remove it in Settings and add it again.'],
    [404, 'notFound', "That's no longer on Home Plex."],
    [500, 'server', 'Something went wrong on Home Plex. Try again in a moment.'],
  ])('maps HTTP %s without leaking response bodies or queries', async (status, code, message) => {
    const lines: unknown[][] = [], auth = vi.fn()
    const fake = jellyfinFetch(() => new Response('private-token private@example.invalid', { status }))
    const log = (...args: unknown[]): void => { lines.push(args) }
    const client = new PlexClient({ ...plexIdentity, url: 'http://192.168.1.20:32400', name: 'Home Plex', fetch: fake.fetch,
      onAuthError: auth, logger: { debug: log, info: log, warn: log, error: log } })
    try {
      await expect(client.request('/library/sections', { query: 'private-query' })).rejects.toMatchObject({ code, message })
      expect(lines).toEqual([['GET', '/library/sections', status]])
      expect(auth).toHaveBeenCalledTimes(code === 'auth' ? 1 : 0)
    } finally { client.dispose() }
  })
  it('times out at 15 seconds, aborts on dispose and converts native failures to plain errors', async () => {
    vi.useFakeTimers()
    const fake = jellyfinFetch(() => new Promise(() => {}))
    const client = new PlexClient({ ...plexIdentity, url: 'https://plex.tv', name: 'Plex', fetch: fake.fetch })
    const result = expect(client.request('/api/v2/user')).rejects.toMatchObject({ code: 'timeout',
      message: "Can't reach Plex. Check this TV is online." })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fake.calls[0]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await result
    expect(fake.calls[0]?.signal?.aborted).toBe(true)
    const aborted = expect(client.request('/api/v2/user')).rejects.toMatchObject({ code: 'offline' })
    await until(() => fake.calls.length === 2)
    client.dispose(); await aborted
    const offline = new PlexClient({ ...plexIdentity, url: 'http://192.168.1.20:32400', name: 'Home Plex',
      fetch: jellyfinFetch(() => { throw Error('private URL and token') }).fetch })
    await expect(offline.request('/')).rejects.toMatchObject({ code: 'offline',
      message: "Can't reach Home Plex. Check the server is switched on." })
    offline.dispose()
  })
  it('rejects foreign, credential-bearing and token-bearing delivery paths and malformed JSON', async () => {
    const client = new PlexClient({ ...plexIdentity, url: 'http://192.168.1.20:32400', name: 'Home Plex',
      fetch: jellyfinFetch(() => new Response('{bad')).fetch })
    try {
      expect(client.deliveryUrl('/library/parts/1/file.mkv')).toBe('http://192.168.1.20:32400/library/parts/1/file.mkv')
      for (const path of ['https://other.invalid/file', '//other.invalid/file', '/\\other.invalid/file',
        '/file?X-Plex-Token=secret', 'http://user:pw@192.168.1.20:32400/file', 'relative/path']) {
        expect(() => client.deliveryUrl(path)).toThrow("Home Plex can't play this file on the TV.")
      }
      await expect(client.request('/bad')).rejects.toMatchObject({ code: 'server' })
    } finally { client.dispose() }
  })
})
