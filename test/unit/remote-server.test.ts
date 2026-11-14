import { request, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { createServer, connect } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteServer, type RemoteLease } from '../../src/main/remote/RemoteServer'
import { allowedSocket, allowedSource, lanAddress, MAX_TRACKED_SOURCES, privateIpv4, RequestLimits }
  from '../../src/main/remote/source-policy'

const servers: RemoteServer[] = []
afterEach(() => { for (const server of servers) server.dispose(); servers.length = 0; vi.useRealTimers() })
function make(opts: Partial<ConstructorParameters<typeof RemoteServer>[0]> = {}): RemoteServer {
  const server = new RemoteServer({ bindHost: async () => '127.0.0.1', port: () => 0, ...opts })
  servers.push(server); return server
}
function good(lease: RemoteLease): asserts lease is Extract<RemoteLease, { ok: true }> { expect(lease.ok).toBe(true) }
function get(port: number, path = '/', opts: RequestOptions = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false, ...opts }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (data: Buffer) => chunks.push(data))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject); req.end()
  })
}

describe('remote source and bind policy', () => {
  it.each(['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0',
    '192.168.255.255', '169.254.0.0', '169.254.255.255'])('allows only a private IPv4 source: %s', (ip) => {
    expect(privateIpv4(ip)).toBe(true)
    expect(allowedSource(ip, '192.168.1.2')).toBe(true)
    expect(allowedSource(`::ffff:${ip}`, '192.168.1.2')).toBe(true)
    expect(allowedSource(ip, '127.0.0.1')).toBe(false)
  })
  it.each(['0.0.0.0', '8.8.8.8', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.0.0.2',
    '172.15.255.255', '172.32.0.0', '192.169.0.1', '169.253.1.1', '224.0.0.1', '255.255.255.255',
    '::1', 'fd00::1', '10.00.0.1', 'not-an-address', ''])('refuses a non-private source: %s', (ip) => {
    expect(privateIpv4(ip)).toBe(false)
    expect(allowedSource(ip, '192.168.1.2')).toBe(false)
  })
  it('allows exactly loopback in development and checks the local socket address', () => {
    expect(allowedSource('::ffff:127.0.0.1', '127.0.0.1')).toBe(true)
    expect(allowedSource('127.0.0.2', '127.0.0.1')).toBe(false)
    expect(allowedSource(undefined, '127.0.0.1')).toBe(false)
    expect(allowedSocket('192.168.1.3', '::ffff:192.168.1.2', '192.168.1.2')).toBe(true)
    expect(allowedSocket('10.64.0.1', '10.64.0.2', '192.168.1.2')).toBe(false)
    expect(allowedSocket('192.168.1.3', undefined, '192.168.1.2')).toBe(false)
  })
  it('chooses a non-internal LAN interface, skipping virtual and tunnel interfaces', () => {
    const info = (address: string, internal = false, family = 'IPv4'): NetworkInterfaceInfo =>
      ({ address, internal, family, netmask: '', mac: '', cidr: null }) as NetworkInterfaceInfo
    expect(lanAddress({ lo: [info('127.0.0.1', true)], mosvpn0: [info('10.64.0.2')], docker0: [info('172.17.0.1')],
      'br-abc': [info('10.0.0.1')], veth0: [info('10.0.0.2')], virbr0: [info('10.0.0.3')],
      wan: [info('8.8.8.8'), info('fd00::1', false, 'IPv6')], lan: [info('192.168.1.9')] })).toBe('192.168.1.9')
    expect(lanAddress({ lan: [info('10.0.0.2', true)] })).toBeNull()
  })
})

describe('remote sliding request budgets', () => {
  it('supports custom per-source and total limits while keeping sliding windows', () => {
    const limits = new RequestLimits({ perSource: 100, total: 150 })
    for (let i = 0; i < 100; i++) expect(limits.allow('a', 0)).toBe(true)
    expect(limits.allow('a', 0)).toBe(false)
    for (let i = 0; i < 49; i++) expect(limits.allow('b', 0)).toBe(true)
    expect(limits.allow('b', 0)).toBe(false)
    expect(limits.allow('a', 60000)).toBe(true)
  })
  it('allows five per source, counts refused attempts, and uses a sliding minute', () => {
    const limits = new RequestLimits()
    for (let i = 0; i < 5; i++) expect(limits.allow('a', i * 1000)).toBe(true)
    expect(limits.allow('a', 5000)).toBe(false)
    expect(limits.allow('a', 60000)).toBe(false)
    expect(limits.allow('a', 66000)).toBe(true)
  })
  it('allows thirty total even across different sources, then clears after a minute', () => {
    const limits = new RequestLimits()
    for (let i = 0; i < 30; i++) expect(limits.allow(String(i), 0)).toBe(true)
    expect(limits.allow('new', 0)).toBe(false)
    expect(limits.allow('new', 60000)).toBe(true)
  })
  it('tracks a bounded number of sources a minute, however many addresses knock', () => {
    const limits = new RequestLimits()
    for (let i = 0; i < 1000; i++) expect(limits.allow(`10.0.${i >> 8}.${i & 255}`, i)).toBe(i < 30)
    expect(limits.trackedSources).toBe(MAX_TRACKED_SOURCES)
    expect(limits.allow('new', 1000)).toBe(false)
    expect(limits.allow('new', 61000)).toBe(true); expect(limits.trackedSources).toBe(1)
  })
})

describe('RemoteServer', () => {
  it('gives each configured route its own budget, keeps pairing strict, and resets all budgets on stop', async () => {
    const server = make()
    let calls = 0
    const handler: Parameters<RemoteServer['mount']>[1] = (_req, res) => { calls++; res.end('ok') }
    server.mount('/remote/key', handler, { limits: { perSource: 600, total: 1200 } })
    server.mount('/remote/text', handler, { limits: { perSource: 600, total: 1200 } })
    server.mount('/remote/pair', handler)
    const first = await server.acquire(); good(first)
    for (let i = 0; i < 100; i++) expect((await get(first.port, '/remote/key', { method: 'POST' })).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await get(first.port, '/remote/pair', { method: 'POST' })).status).toBe(200)
    expect((await get(first.port, '/remote/pair', { method: 'POST' })).status).toBe(429)
    expect(calls).toBe(105)
    expect((await get(first.port, '/remote/text', { method: 'POST' })).status).toBe(200)
    expect((await get(first.port, '/unknown', { method: 'POST' })).status).toBe(429)
    for (let i = 100; i < 600; i++) expect((await get(first.port, '/remote/key', { method: 'POST' })).status).toBe(200)
    expect((await get(first.port, '/remote/key', { method: 'POST' })).status).toBe(429)
    first.release()
    const next = await server.acquire(); good(next)
    expect((await get(next.port, '/remote/key', { method: 'POST' })).status).toBe(200)
    expect((await get(next.port, '/remote/pair', { method: 'POST' })).status).toBe(200)
  })
  it('has no listener until acquired, shares leases, and reads the port again on restart', async () => {
    const port = vi.fn(() => 0), server = make({ port })
    expect(port).not.toHaveBeenCalled()
    server.mount('/', (_req, res) => { res.end('hello') })
    const [one, two] = await Promise.all([server.acquire(), server.acquire()]); good(one); good(two)
    expect(one.port).toBe(two.port); expect(port).toHaveBeenCalledOnce()
    one.release(); one.release()
    expect((await get(two.port)).body).toBe('hello')
    two.release()
    await expect(get(two.port)).rejects.toThrow()
    const three = await server.acquire(); good(three)
    expect(port).toHaveBeenCalledTimes(2); three.release()
  })
  it('reports no network, rejects wildcard and IPv6 binds, and handles an occupied port', async () => {
    expect(await make({ bindHost: async () => null }).acquire()).toEqual({ ok: false, reason: 'no-network' })
    for (const host of ['0.0.0.0', '::1', 'not-an-ip']) {
      expect(await make({ bindHost: async () => host }).acquire()).toEqual({ ok: false, reason: 'unavailable' })
    }
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address(); expect(address).toBeTypeOf('object')
    try {
      const port = typeof address === 'object' && address ? address.port : 0
      expect(await make({ port: () => port }).acquire()).toEqual({ ok: false, reason: 'unavailable' })
    } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())) }
  })
  it('disposes safely while address selection is still pending', async () => {
    let finish!: (host: string) => void
    const server = make({ bindHost: () => new Promise((resolve) => { finish = resolve }) })
    const opening = server.acquire(); await Promise.resolve(); server.dispose(); finish('127.0.0.1')
    expect(await opening).toEqual({ ok: false, reason: 'unavailable' })
    expect(await server.acquire()).toEqual({ ok: false, reason: 'unavailable' })
  })
  it('destroys refused sources without running a route or sending a response', async () => {
    const server = make(), handler = vi.fn((_req, res) => res.end('should not run'))
    server.mount('/', handler)
    const lease = await server.acquire(); good(lease)
    await expect(get(lease.port, '/', { localAddress: '127.0.0.2' })).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
  it('checks exact Host and Origin headers before routes', async () => {
    const server = make(), handler = vi.fn((_req, res) => res.end('ok'))
    server.mount('/', handler)
    const lease = await server.acquire(); good(lease)
    for (const host of ['localhost:' + lease.port, '127.0.0.1', 'evil.example']) {
      expect((await get(lease.port, '/', { headers: { Host: host } })).status).toBe(400)
    }
    expect((await get(lease.port, '/', { headers: { Origin: 'http://evil.example' } })).status).toBe(403)
    expect((await get(lease.port, '/', { headers: { Origin: `http://127.0.0.1:${lease.port}` } })).status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })
  it('rejects a request with two Host lines, whichever comes first', async () => {
    const server = make(), handler = vi.fn((_req, res) => res.end('ok'))
    server.mount('/', handler)
    const lease = await server.acquire(); good(lease)
    for (const hosts of [[`127.0.0.1:${lease.port}`, 'evil.example'], [`127.0.0.1:${lease.port}`, `127.0.0.1:${lease.port}`]]) {
      const socket = connect(lease.port, '127.0.0.1'), received: Buffer[] = []
      socket.on('data', (data: Buffer) => received.push(data))
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      socket.write(`GET / HTTP/1.1\r\n${hosts.map((host) => `Host: ${host}\r\n`).join('')}\r\n`)
      await closed
      expect(Buffer.concat(received).toString('latin1')).toMatch(/^HTTP\/1\.1 400 /)
    }
    expect(handler).not.toHaveBeenCalled()
  })
  it('rejects a missing Host, a trailing slash in Origin, and an https Origin', async () => {
    const server = make(), lease = await server.acquire(); good(lease)
    expect((await get(lease.port, '/', { setHost: false })).status).toBe(400)
    for (const origin of [`http://127.0.0.1:${lease.port}/`, `https://127.0.0.1:${lease.port}`, 'null']) {
      expect((await get(lease.port, '/', { headers: { Origin: origin } })).status).toBe(403)
    }
  })
  it('returns 404 elsewhere and sends the security headers, with fresh HTML nonces', async () => {
    const server = make()
    server.mount('/html', (_req, res, { nonce }) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<style nonce="${nonce}"></style>`)
    })
    const lease = await server.acquire(); good(lease)
    const missing = await get(lease.port, '/elsewhere?code=12345678')
    expect(missing.status).toBe(404)
    expect(missing.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', connection: 'close' })
    const one = await get(lease.port, '/html'), two = await get(lease.port, '/html')
    const nonce = /nonce="([^"]+)"/.exec(one.body)![1]!
    expect(Buffer.from(nonce, 'base64')).toHaveLength(18)
    expect(one.headers['content-security-policy']).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; ` +
      `style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
    expect(one.headers['content-security-policy']).not.toBe(two.headers['content-security-policy'])
  })
  it('does not count GET favicon, counts failures, limits POST as JSON, and clears limits on stop', async () => {
    let now = 0
    const server = make({ now: () => now }), lease = await server.acquire(); good(lease)
    for (let i = 0; i < 8; i++) expect((await get(lease.port, '/favicon.ico')).status).toBe(404)
    for (let i = 0; i < 5; i++) expect((await get(lease.port)).status).toBe(404)
    const post = await get(lease.port, '/', { method: 'POST' })
    expect(post.status).toBe(429); expect(post.body).toBe('{"error":"rate"}')
    expect(post.headers['content-type']).toBe('application/json; charset=utf-8')
    expect((await get(lease.port)).body).toBe('Too many tries. Wait a minute, then try again.')
    now = 60000; expect((await get(lease.port)).status).toBe(404)
    lease.release()
    const next = await server.acquire(); good(next)
    expect((await get(next.port)).status).toBe(404)
  })
  it('stops accepting immediately but lets an in-progress response finish', async () => {
    const server = make()
    let finish!: () => void, started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    server.mount('/', (_req, res) => { res.write('first'); finish = () => res.end('last'); started() })
    const lease = await server.acquire(); good(lease)
    const response = get(lease.port); await ready; lease.release()
    await expect(get(lease.port)).rejects.toThrow()
    finish(); expect((await response).body).toBe('firstlast')
  })
  it('refuses a request whose headers finish after the final lease ends', async () => {
    const server = make(), handler = vi.fn((_req: unknown, res: { end(body: string): void }) => { res.end('served') })
    server.mount('/', handler)
    const lease = await server.acquire(); good(lease)
    const socket = connect(lease.port, '127.0.0.1'), received: Buffer[] = []
    socket.on('error', () => {}); socket.on('data', (data: Buffer) => received.push(data))
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.write('GET / HTTP/1.1\r\n')
    // Let the server read the request line, so the connection is mid-request rather than idle.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    lease.release()
    socket.write(`Host: 127.0.0.1:${lease.port}\r\n\r\n`)
    await closed
    expect(handler).not.toHaveBeenCalled(); expect(Buffer.concat(received).length).toBe(0)
  })
  it('destroys sockets left open five seconds after the final lease', async () => {
    const server = make(), lease = await server.acquire(); good(lease)
    const socket = connect(lease.port, '127.0.0.1')
    socket.on('error', () => {}) // Reset is the expected outcome when the grace period ends.
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    // A partial request remains open during the grace period.
    socket.write('GET / HTTP/1.1\r\n')
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    lease.release(); await vi.advanceTimersByTimeAsync(4999)
    expect(socket.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await closed
    expect(socket.destroyed).toBe(true)
  })
})
