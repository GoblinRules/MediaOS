import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect as realConnect, createServer, isIPv4, Socket, type NetConnectOpts, type Server } from 'node:net'
import { networkInterfaces } from 'node:os'
import { VpnProxy, type ProxyOptions } from '../../src/main/vpn/proxy/VpnProxy'
import { silentLog } from '../../src/main/log/Logger'
import { deferred, until } from './helpers'

class Upstream extends Socket {
  writes: Buffer[] = []
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk)); cb()
  }
}
let currentTunnel: string | null
let connectAction: (options: NetConnectOpts) => Socket
// Every injected and real outbound connection in this suite crosses this same assertion boundary.
const connect = vi.fn((options: NetConnectOpts): Socket => {
  expect('host' in options && isIPv4(options.host!)).toBe(true)
  expect('localAddress' in options && options.localAddress).toBe(currentTunnel)
  expect('lookup' in options && typeof options.lookup).toBe('function')
  return connectAction(options)
})
const resources: (() => Promise<void>)[] = []
beforeEach(() => { currentTunnel = '10.14.0.2'; connect.mockClear() })
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})
const request = (host = '8.8.8.8', port = 443): Buffer => {
  const head = isIPv4(host) ? Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number)]) :
    Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host)])
  return Buffer.concat([head, Buffer.from([port >> 8, port & 255])])
}
async function harness(options: Partial<ProxyOptions> = {}) {
  const upstreams: Upstream[] = []
  connectAction = () => { const socket = new Upstream(); upstreams.push(socket); return socket }
  const resolve = vi.fn(async () => ['8.8.4.4'])
  const peerUid = vi.fn(async (): Promise<number | 'skip' | null> => 'skip')
  const proxy = new VpnProxy({ uid: 1000, resolve, peerUid, connect, ...options })
  proxy.setTunnel({ tunIp: currentTunnel, dns: null })
  const port = await proxy.listen(0)
  resources.push(() => proxy.close())
  const tunnel = (ip: string | null) => { currentTunnel = ip; proxy.setTunnel({ tunIp: ip, dns: null }) }
  const open = async (allowHalfOpen = false) => {
    const socket = realConnect({ host: '127.0.0.1', port, allowHalfOpen }), chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk)); socket.on('error', () => {})
    resources.push(async () => { socket.destroy() })
    await new Promise<void>((yes, no) => { socket.once('connect', yes); socket.once('error', no) })
    return { socket, bytes: () => Buffer.concat(chunks) }
  }
  const handshake = async (host = '8.8.8.8', targetPort = 443, extra = Buffer.alloc(0)) => {
    const client = await open()
    client.socket.write(Buffer.concat([Buffer.from([5, 1, 0]), request(host, targetPort), extra]))
    await until(() => client.bytes().length >= 2 || client.socket.destroyed)
    return client
  }
  return { proxy, port, open, handshake, tunnel, resolve, peerUid, upstreams }
}

describe('VPN proxy with injected outbound I/O', () => {
  it.each(['upstream refusal', 'malformed request', 'refused target'])(
    'releases the connection after %s even when the client leaves its write side open', async (kind) => {
      const h = await harness(), c = await h.open(true)
      c.socket.write(Buffer.from([5])); await new Promise<void>((resolve) => setImmediate(resolve))
      c.socket.write(Buffer.from([1, 0])); await until(() => c.bytes().length === 2)
      const bytes = request(kind === 'refused target' ? '10.0.0.1' : '8.8.8.8')
      if (kind === 'malformed request') bytes[1] = 2
      const chunks = kind === 'malformed request' ? [bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2, 4)] :
        [bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]
      for (const chunk of chunks) {
        c.socket.write(chunk); await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (kind === 'upstream refusal') {
        await until(() => h.upstreams.length === 1)
        h.upstreams[0]!.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      }
      await until(() => c.bytes().length >= 12)
      expect(c.bytes()[3]).toBe(kind === 'upstream refusal' ? 5 : kind === 'malformed request' ? 7 : 2)
      expect(c.socket.writableEnded).toBe(false)
      await until(() => h.proxy.connections === 0)
    })
  it('destroys a failure stream after two seconds if the reply never flushes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = await harness(), c = await h.open()
    // Hold only server-side end callbacks; real clients still send the handshake normally.
    const end = vi.spyOn(Socket.prototype, 'end').mockImplementation(function (this: Socket) { return this })
    try {
      c.socket.write(Buffer.concat([Buffer.from([5, 1, 0]), request('10.0.0.1')]))
      await until(() => end.mock.calls.length > 0)
      expect(h.proxy.connections).toBe(1)
      await vi.advanceTimersByTimeAsync(1999); expect(h.proxy.connections).toBe(1)
      await vi.advanceTimersByTimeAsync(1); expect(h.proxy.connections).toBe(0)
    } finally { end.mockRestore() }
  })
  it('has no connect or resolution without a tunnel', async () => {
    const h = await harness(); h.tunnel(null)
    const c = await h.handshake('example.com')
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(1); expect(connect).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled()
  })
  it.each([['ECONNREFUSED', 5], ['ENETUNREACH', 3], ['EHOSTUNREACH', 4], ['EADDRNOTAVAIL', 1], ['ECONNRESET', 1]])(
    'maps %s to %i with no retries', async (code, expected) => {
      const h = await harness(), c = await h.handshake()
      await until(() => h.upstreams.length === 1)
      h.upstreams[0]!.emit('error', Object.assign(new Error('must not be logged'), { code }))
      await until(() => c.bytes().length >= 12)
      expect(c.bytes()[3]).toBe(expected); expect(connect).toHaveBeenCalledTimes(1)
    })
  it('handles a synchronous connect error and logs only its code', async () => {
    const logger = { ...silentLog, debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const h = await harness({ logger })
    connectAction = () => { throw Object.assign(new Error('secret target'), { code: 'ENETUNREACH' }) }
    const c = await h.handshake()
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(3); expect(logger.debug).toHaveBeenCalledWith('ENETUNREACH')
    expect(logger.info).not.toHaveBeenCalled(); expect(logger.warn).not.toHaveBeenCalled()
  })
  it.each(['10.0.0.1', '127.0.0.1', '10.14.0.2'])('refuses literal target %s', async (host) => {
    const h = await harness(), c = await h.handshake(host)
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(2); expect(connect).not.toHaveBeenCalled(); expect(h.resolve).not.toHaveBeenCalled()
  })
  it('refuses private DNS answers and uses the first allowed answer', async () => {
    const h = await harness()
    h.resolve.mockResolvedValueOnce(['10.0.0.1', '192.168.1.1'])
    const c = await h.handshake('example.com')
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(2); expect(connect).not.toHaveBeenCalled()
    h.resolve.mockResolvedValueOnce(['10.0.0.1', '8.8.8.8', '1.1.1.1'])
    await h.handshake('example.com'); await until(() => connect.mock.calls.length === 1)
    expect(connect.mock.calls[0]![0]).toMatchObject({ host: '8.8.8.8' })
  })
  it('maps resolution failure to host unreachable', async () => {
    const h = await harness(); h.resolve.mockRejectedValueOnce(new Error('DNS failed'))
    const c = await h.handshake('example.com'); await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(4); expect(connect).not.toHaveBeenCalled()
  })
  it.each(['localhost', 'a.localhost', '2130706433', '0x7f.1'])('refuses %s before resolution', async (host) => {
    const h = await harness(), c = await h.handshake(host)
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(2); expect(h.resolve).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
  })
  it('does not resolve a domain which is already an IPv4 literal', async () => {
    const h = await harness(), c = await h.open()
    const host = '8.8.8.8'
    c.socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([0, 80])]))
    await until(() => connect.mock.calls.length === 1)
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it('forwards extra bytes, pipes both ways, and destroys both on error', async () => {
    const h = await harness(), c = await h.handshake('8.8.8.8', 443, Buffer.from('first'))
    await until(() => h.upstreams.length === 1)
    const up = h.upstreams[0]!, keepalive = vi.spyOn(up, 'setKeepAlive'), noDelay = vi.spyOn(up, 'setNoDelay')
    up.emit('connect'); await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(0); expect(Buffer.concat(up.writes).toString()).toBe('first')
    expect(keepalive).toHaveBeenCalledWith(true, 30000); expect(noDelay).toHaveBeenCalledWith(true)
    c.socket.write('second'); await until(() => Buffer.concat(up.writes).toString() === 'firstsecond')
    up.push(Buffer.from('answer')); await until(() => c.bytes().length >= 18)
    expect(c.bytes().subarray(12).toString()).toBe('answer')
    up.emit('error', Object.assign(new Error('closed'), { code: 'ECONNRESET' }))
    await until(() => c.socket.destroyed); expect(up.destroyed).toBe(true)
  })
  it('pauses the client while the upstream applies backpressure', async () => {
    const h = await harness(), c = await h.handshake()
    await until(() => h.upstreams.length === 1)
    const up = h.upstreams[0]!, held: (() => void)[] = []
    let source: Socket | undefined
    up.once('pipe', (socket: Socket) => { source = socket })
    vi.spyOn(up, '_write').mockImplementation((_chunk, _encoding, cb) => { held.push(() => cb()) })
    up.emit('connect'); await until(() => c.bytes().length >= 12)
    c.socket.write(Buffer.alloc(up.writableHighWaterMark))
    await until(() => source?.isPaused() === true)
    expect(up.writableNeedDrain).toBe(true)
    while (held.length) held.shift()!()
    await until(() => source?.isPaused() === false)
  })
  it('destroys the upstream when the client closes', async () => {
    const h = await harness(), c = await h.handshake()
    await until(() => h.upstreams.length === 1)
    h.upstreams[0]!.emit('connect'); await until(() => c.bytes().length >= 12)
    c.socket.destroy(); await until(() => h.upstreams[0]!.destroyed)
  })
  it('destroys streams on address changes or clearing and uses the new address', async () => {
    const h = await harness(), first = await h.handshake()
    await until(() => h.upstreams.length === 1); h.upstreams[0]!.emit('connect')
    h.tunnel('10.14.0.3'); await until(() => first.socket.destroyed)
    expect(h.upstreams[0]!.destroyed).toBe(true)
    const second = await h.handshake(); await until(() => h.upstreams.length === 2)
    expect(connect.mock.calls[1]![0]).toMatchObject({ localAddress: '10.14.0.3' })
    h.tunnel(null); await until(() => second.socket.destroyed)
    expect(h.upstreams[1]!.destroyed).toBe(true)
  })
  it('does not connect a delayed DNS result after the tunnel changes', async () => {
    const answer = deferred<string[]>(), h = await harness({ resolve: () => answer.promise })
    const c = await h.handshake('example.com')
    h.tunnel('10.14.0.3'); answer.resolve(['8.8.8.8'])
    await until(() => c.socket.destroyed); expect(connect).not.toHaveBeenCalled()
  })
  it('times out the entire handshake after 10 seconds, including peer checks', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = await harness(), c = await h.open()
    await until(() => h.peerUid.mock.calls.length === 1)
    c.socket.write(Buffer.from([5])); vi.advanceTimersByTime(9999)
    expect(c.socket.destroyed).toBe(false)
    vi.advanceTimersByTime(1); await until(() => c.socket.destroyed)
    expect(connect).not.toHaveBeenCalled()
  })
  it('also times out a stalled peer check and closes on peer-check errors', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const uid = deferred<number>(), h = await harness({ peerUid: () => uid.promise }), c = await h.open()
    await vi.advanceTimersByTimeAsync(10_000); await until(() => c.socket.destroyed)
    uid.resolve(1000)
    const rejected = await harness({ peerUid: async () => { throw new Error('Cannot read proc') } })
    const other = await rejected.open(); await until(() => other.socket.destroyed)
    expect(connect).not.toHaveBeenCalled()
  })
  it('times out connect at 15 seconds and has no idle cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = await harness(), c = await h.handshake()
    await until(() => h.upstreams.length === 1)
    vi.advanceTimersByTime(14999); expect(c.bytes()).toHaveLength(2)
    vi.advanceTimersByTime(1); await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).toBe(4); expect(h.upstreams[0]!.destroyed).toBe(true)
    const active = await h.handshake(); await until(() => h.upstreams.length === 2)
    h.upstreams[1]!.emit('connect'); await until(() => active.bytes().length >= 12)
    vi.advanceTimersByTime(3_600_000); expect(active.socket.destroyed).toBe(false)
  })
  it.each([1001, null])('closes peers with uid %s before greeting', async (uid) => {
    const h = await harness({ peerUid: async () => uid }), c = await h.open()
    c.socket.write(Buffer.from([5, 1, 0])); await until(() => c.socket.destroyed)
    expect(c.bytes()).toHaveLength(0); expect(connect).not.toHaveBeenCalled()
  })
  it('permits matching uids and rate limits refused-peer warnings', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const logger = { ...silentLog, warn: vi.fn() }
    const h = await harness({ logger, peerUid: async () => 1001 })
    for (let i = 0; i < 2; i++) { const c = await h.open(); await until(() => c.socket.destroyed) }
    expect(logger.warn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    const c = await h.open(); await until(() => c.socket.destroyed)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    const allowed = await harness({ peerUid: async () => 1000 })
    await allowed.handshake(); await until(() => connect.mock.calls.length === 1)
  })
  it('caps accepted connections at 512', async () => {
    const h = await harness(), clients = []
    // Avoid overflowing the OS listen backlog while exercising the proxy's own cap.
    for (let i = 0; i < 512; i++) clients.push(await h.open())
    await until(() => h.peerUid.mock.calls.length === 512)
    const extra = await h.open(); await until(() => extra.socket.destroyed)
    expect(h.peerUid).toHaveBeenCalledTimes(512)
    clients[0]!.socket.destroy()
  })
  it('the injected DNS guard always fails', async () => {
    const h = await harness(); await h.handshake(); await until(() => connect.mock.calls.length === 1)
    const options = connect.mock.calls[0]![0]
    if (!('lookup' in options) || !options.lookup) throw new Error('Missing guard')
    const cb = vi.fn(); options.lookup('example.com', {}, cb)
    expect(cb.mock.calls[0]![0]).toMatchObject({ code: 'EHOSTUNREACH' })
  })
})

async function echoServer(host = '127.0.0.1'): Promise<{ server: Server; port: number; connections: () => number }> {
  let connections = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  resources.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing echo port')
  return { server, port: address.port, connections: () => connections }
}
describe('real sockets, including Windows', () => {
  it('cannot reach echo from an unassigned tunnel address', async () => {
    const echo = await echoServer()
    // Allow loopback solely to exercise the real bind failure rather than the target refusal.
    const h = await harness({ policy: () => false }); h.tunnel('192.0.2.1'); connectAction = realConnect
    const c = await h.handshake('127.0.0.1', echo.port)
    await until(() => c.bytes().length >= 12)
    expect(c.bytes()[3]).not.toBe(0); expect(echo.connections()).toBe(0); expect(connect).toHaveBeenCalledTimes(1)
  })
  it('round trips bytes through an assigned IPv4 address with a test policy', async (context) => {
    const address = Object.values(networkInterfaces()).flat().find((item) => item?.family === 'IPv4' && !item.internal)?.address
    if (!address) { context.skip(); return }
    const echo = await echoServer(address), h = await harness({ policy: () => false })
    h.tunnel(address); connectAction = realConnect
    const c = await h.handshake(address, echo.port, Buffer.from('hello'))
    await until(() => c.bytes().length >= 17)
    expect(c.bytes()[3]).toBe(0); expect(c.bytes().subarray(12).toString()).toBe('hello')
    expect(echo.connections()).toBe(1)
  })
})
