import { afterEach, describe, expect, it, vi } from 'vitest'
import { JellyfinClient, normaliseAddress } from '../../src/main/sources/jellyfin/JellyfinClient'
import { runtime } from '../../src/main/core/runtime'
import { jellyfinFetch } from './helpers'

const options = { url: 'http://user:password@harbour:8096/jellyfin/?api_key=secret#hash', name: 'Harbour Jellyfin',
  deviceId: 'device-1', deviceName: 'Living "Room" \\ TV', appVersion: '1.2.3', token: 'private-token' }
afterEach(() => vi.useRealTimers())
describe('Jellyfin HTTP transport', () => {
  it('normalises its base and sends quoted auth on every request, omitting the token before sign-in', async () => {
    const fake = jellyfinFetch(() => ({ ok: true }))
    const client = new JellyfinClient({ ...options, fetch: fake.fetch })
    await client.request('/Items', { userId: 'user' })
    expect(client.base).toBe('http://harbour:8096/jellyfin')
    expect(fake.calls[0]!.headers.get('Authorization')).toBe(
      'MediaBrowser Client="MediaOS", Device="Living \\"Room\\" \\\\ TV", DeviceId="device-1", Version="1.2.3", Token="private-token"')
    const anonymous = new JellyfinClient({ ...options, token: undefined, fetch: fake.fetch })
    await anonymous.request('/System/Info/Public')
    expect(fake.calls[1]!.headers.get('Authorization')).not.toContain('Token=')
    client.dispose(); anonymous.dispose()
  })
  it.each([
    [401, 'auth', 'Harbour Jellyfin signed MediaOS out. Remove it in Settings and add it again.'],
    [403, 'auth', 'Harbour Jellyfin signed MediaOS out. Remove it in Settings and add it again.'],
    [404, 'notFound', "That's no longer on Harbour Jellyfin."],
    [500, 'server', 'Something went wrong on Harbour Jellyfin. Try again in a moment.'],
    [503, 'server', 'Something went wrong on Harbour Jellyfin. Try again in a moment.'],
  ])('maps HTTP %s without exposing response bodies or URLs', async (status, code, message) => {
    const fake = jellyfinFetch(() => new Response('http://harbour/?token=private-token', { status: Number(status) }))
    const client = new JellyfinClient({ ...options, fetch: fake.fetch })
    await expect(client.request('/Items')).rejects.toMatchObject({ code, message })
    client.dispose()
  })
  it('sanitises native network errors and only logs method, path and status', async () => {
    const lines: unknown[][] = []
    let fail = false
    const fake = jellyfinFetch(() => {
      if (fail) throw Error('http://harbour?token=private-token')
      return { ok: true }
    })
    const logger = { debug: (...args: unknown[]) => { lines.push(args) }, info() {}, warn() {}, error() {} }
    const client = new JellyfinClient({ ...options, fetch: fake.fetch, logger })
    await client.request('/Items', { secret: 'private-token' }, 'POST', { Pw: 'password' })
    expect(lines).toEqual([['POST', '/Items', 200]])
    fail = true
    await expect(client.request('/Items')).rejects.toMatchObject({ code: 'offline',
      message: "Can't reach Harbour Jellyfin. Check the server is switched on." })
    client.dispose()
  })
  it('times out at 10 seconds even when fetch ignores abort, and clears its timer', async () => {
    vi.useFakeTimers()
    const fake = jellyfinFetch(() => new Promise(() => {}))
    const client = new JellyfinClient({ ...options, fetch: fake.fetch, clock: runtime })
    const result = expect(client.request('/Items')).rejects.toMatchObject({ code: 'timeout',
      message: "Can't reach Harbour Jellyfin. Check the server is switched on." })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fake.calls[0]!.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(fake.calls[0]!.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
  })
  it('caps streamed JSON at 8 MB, cancels excess data and times out a stalled body', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const cap = 8 * 1024 * 1024
    const exact = new Uint8Array(cap).fill(32)
    exact[0] = 123; exact[1] = 125
    const responses = [new Response(exact), new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(exact); controller.enqueue(new Uint8Array([32])) }, cancel: cancelled,
    })), new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))]
    const client = new JellyfinClient({ ...options, fetch: jellyfinFetch(() => responses.shift()).fetch })
    expect(await client.request('/Items')).toEqual({})
    await expect(client.request('/Items')).rejects.toMatchObject({ code: 'server' })
    expect(cancelled).toHaveBeenCalledTimes(1)
    const stalled = expect(client.request('/Items')).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(10_000)
    await stalled
    expect(cancelled).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
  })
  it('rejects paths and other non-host addresses while accepting hosts, base paths and HTTP URLs', () => {
    for (const value of ['C:\\media', 'C:/media', '\\\\server\\media', '/media', 'mailto:host', 'ftp://host']) {
      expect(() => normaliseAddress(value)).toThrow('That server address is not valid. Check it and try again.')
    }
    expect(['living-room.local', '192.168.1.2', '[::1]', '[2001:db8::1]:9000', 'https://host/jellyfin/web',
      '192.168.1.2:8096/jellyfin'].map(normaliseAddress)).toEqual(['http://living-room.local:8096', 'http://192.168.1.2:8096',
      'http://[::1]:8096', 'http://[2001:db8::1]:9000', 'https://host/jellyfin', 'http://192.168.1.2:8096/jellyfin'])
  })
  it('aborts every in-flight request on disposal and prevents new requests', async () => {
    vi.useFakeTimers()
    const fake = jellyfinFetch(() => new Promise(() => {}))
    const client = new JellyfinClient({ ...options, fetch: fake.fetch, clock: runtime })
    const results = [expect(client.request('/Items')).rejects.toMatchObject({ code: 'offline' }),
      expect(client.request('/UserViews')).rejects.toMatchObject({ code: 'offline' })]
    client.dispose()
    await Promise.all(results)
    expect(fake.calls.every((r) => r.signal?.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await expect(client.request('/Items')).rejects.toMatchObject({ code: 'offline' })
    expect(fake.calls).toHaveLength(2)
  })
  it('keeps subtitle and transcode delivery on the server and handles base-path prefixes once', () => {
    const client = new JellyfinClient(options)
    expect(client.deliveryUrl('/Videos/film/master.m3u8')).toBe('http://harbour:8096/jellyfin/Videos/film/master.m3u8')
    expect(client.deliveryUrl('/jellyfin/Videos/film/master.m3u8')).toBe('http://harbour:8096/jellyfin/Videos/film/master.m3u8')
    for (const path of ['https://elsewhere.invalid/sub.srt', 'http://user:secret@harbour:8096/sub.srt', 'https://user:secret@']) {
      expect(() => client.deliveryUrl(path)).toThrow("Harbour Jellyfin can't play this file on the TV.")
    }
    client.dispose()
  })
})
