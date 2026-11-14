import { createServer, connect as netConnect, isIPv4, type Socket, type NetConnectOpts, type Server } from 'node:net'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import { Socks5Parser, reply, type Request } from './socks5'
import { refusedDomain, refusedIPv4, validTunnelAddress } from './target-policy'

export interface ProxyOptions {
  connect?: (options: NetConnectOpts) => Socket
  resolve: (host: string) => Promise<string[]>
  peerUid: (clientPort: number, serverPort: number) => Promise<number | null | 'skip'>
  uid: number | null
  clock?: Runtime
  logger?: Log
  policy?: (ip: string, tunIp: string | null) => boolean
}
interface Stream { client: Socket; upstream?: Socket; address: string | null; destroy(): void }
const errorCode = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN'
}
const errors: Record<string, number> = { ECONNREFUSED: 5, ENETUNREACH: 3, EHOSTUNREACH: 4, EADDRNOTAVAIL: 1 }

export class VpnProxy {
  private readonly server: Server
  private readonly clock: Runtime
  private readonly logger: Log
  private readonly streams = new Set<Stream>()
  private tunIp: string | null = null
  private lastWarning = -Infinity

  constructor(private options: ProxyOptions) {
    this.clock = options.clock ?? runtime; this.logger = options.logger ?? silentLog
    this.server = createServer({ pauseOnConnect: true }, (socket) => this.accept(socket))
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const failed = (error: Error): void => { this.server.off('listening', ready); reject(error) }
      const ready = (): void => {
        this.server.off('error', failed)
        const address = this.server.address()
        if (address && typeof address !== 'string') resolve(address.port)
        else reject(new Error('Proxy did not open'))
      }
      this.server.once('error', failed); this.server.once('listening', ready)
      this.server.listen(port, '127.0.0.1')
    })
  }

  get connections(): number { return this.streams.size }

  setTunnel({ tunIp, dns }: { tunIp: string | null; dns: string | null }): void {
    if ((tunIp !== null && !validTunnelAddress(tunIp)) || (dns !== null && !validTunnelAddress(dns))) {
      throw new Error('Invalid tunnel address')
    }
    if (tunIp !== this.tunIp) {
      for (const stream of this.streams) if (stream.address !== null) stream.destroy()
      this.tunIp = tunIp
    }
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.destroy()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private accept(client: Socket): void {
    if (this.streams.size >= 512) { client.destroy(); return }
    const parser = new Socks5Parser()
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => { if (timer !== undefined) { this.clock.clearTimeout(timer); timer = undefined } }
    const stream: Stream = { client, address: null, destroy: () => {
      clear(); this.streams.delete(stream); client.destroy(); stream.upstream?.destroy()
    } }
    this.streams.add(stream)
    client.on('error', stream.destroy); client.on('close', stream.destroy)
    timer = this.clock.setTimeout(stream.destroy, 10_000)
    const endFailure = (bytes: Buffer): void => {
      clear(); client.off('data', data); client.pause()
      timer = this.clock.setTimeout(stream.destroy, 2000)
      client.end(bytes, stream.destroy)
      stream.upstream?.destroy()
    }
    const fail = (code: number): void => endFailure(reply(code))
    const data = (chunk: Buffer): void => {
      let result = parser.feed(chunk)
      if (result.type === 'greeting') { client.write(result.data); result = parser.feed(Buffer.alloc(0)) }
      if (result.type === 'close') stream.destroy()
      if (result.type === 'reply') endFailure(result.data)
      if (result.type === 'request') {
        clear(); client.pause(); client.off('data', data)
        void this.request(stream, result.request, result.extra, fail, (cb) => {
          timer = this.clock.setTimeout(cb, 15_000)
        }, clear)
      }
    }
    void this.options.peerUid(client.remotePort!, client.localPort!).then((uid) => {
      if (client.destroyed) return
      if (uid !== 'skip' && (uid === null || uid !== this.options.uid)) {
        if (this.clock.now() - this.lastWarning >= 60_000) {
          this.logger.warn('VPN proxy refused a connection from another user'); this.lastWarning = this.clock.now()
        }
        stream.destroy(); return
      }
      client.on('data', data); client.resume()
    }).catch(() => stream.destroy())
  }

  private async request(stream: Stream, request: Request, extra: Buffer, failReply: (code: number) => void,
    connectTimer: (cb: () => void) => void, clear: () => void): Promise<void> {
    const { client } = stream
    let failed = false
    const fail = (code: number): void => {
      if (failed || client.destroyed) return
      failed = true; failReply(code)
    }
    const policy = this.options.policy ?? refusedIPv4
    let host = request.host
    if (isIPv4(host) && policy(host, this.tunIp)) { fail(2); return }
    if (!this.tunIp) { fail(1); return }
    stream.address = this.tunIp
    if (request.kind === 'domain' && !isIPv4(host)) {
      if (refusedDomain(host)) { fail(2); return }
      let addresses: string[]
      try { addresses = await this.options.resolve(host) } catch { if (!client.destroyed) fail(4); return }
      if (client.destroyed) return
      host = addresses.find((ip) => isIPv4(ip) && !policy(ip, this.tunIp)) ?? ''
      if (!host) { fail(2); return }
    }
    if (!isIPv4(host) || policy(host, this.tunIp)) { fail(2); return }
    const localAddress = this.tunIp
    if (!localAddress) { fail(1); return }
    stream.address = localAddress
    let upstream: Socket
    try {
      upstream = (this.options.connect ?? netConnect)({ host, port: request.port, localAddress,
        // A second guard: a hostname must never reach the system resolver.
        lookup: (_host, _options, cb) => cb(Object.assign(new Error('DNS is disabled'), { code: 'EHOSTUNREACH' }), '', 4) })
    } catch (error) { const code = errorCode(error); this.logger.debug(code); fail(errors[code] ?? 1); return }
    stream.upstream = upstream
    let connected = false
    connectTimer(() => fail(4))
    upstream.on('error', (error) => {
      const code = errorCode(error); this.logger.debug(code)
      if (connected) stream.destroy(); else fail(errors[code] ?? 1)
    })
    upstream.on('close', () => { if (connected) stream.destroy(); else if (!client.writableEnded) fail(1) })
    upstream.once('connect', () => {
      if (client.destroyed || failed) { stream.destroy(); return }
      clear(); connected = true
      for (const socket of [client, upstream]) { socket.setKeepAlive(true, 30_000); socket.setNoDelay(true) }
      client.write(reply(0))
      if (extra.length) upstream.write(extra)
      client.pipe(upstream); upstream.pipe(client); client.resume()
    })
  }
}
