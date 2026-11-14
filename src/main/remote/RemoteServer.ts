import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIPv4, type Socket } from 'node:net'
import { silentLog, type Log } from '../log/Logger'
import { allowedSocket, normaliseAddress, RequestLimits } from './source-policy'

export type RemoteLease = { ok: true; host: string; port: number; release(): void } |
  { ok: false; reason: 'no-network' | 'unavailable' }
export type RemoteHandler = (request: IncomingMessage, response: ServerResponse, context: { url: URL; nonce: string }) =>
  void | Promise<void>
interface Listener {
  server: Server; host: string; port: number; leases: number; stopped: boolean; sockets: Set<Socket>; limits: RequestLimits
  timer?: ReturnType<typeof setTimeout>
}
export interface RemoteServerOptions { bindHost(): Promise<string | null>; port(): number; logger?: Log; now?: () => number }

export class RemoteServer {
  private routes = new Map<string, RemoteHandler>()
  private listener?: Listener
  private draining = new Set<Listener>()
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly logger: Log
  constructor(private opts: RemoteServerOptions) { this.logger = opts.logger ?? silentLog }
  mount(path: string, handler: RemoteHandler): void {
    if (this.routes.has(path)) throw new Error('Remote route already mounted')
    this.routes.set(path, handler)
  }
  acquire(): Promise<RemoteLease> {
    const job = this.tail.then(() => this.takeLease())
    this.tail = job.catch(() => undefined)
    return job
  }
  private async takeLease(): Promise<RemoteLease> {
    if (this.disposed) return { ok: false, reason: 'unavailable' }
    if (!this.listener) {
      let host: string | null
      try { host = await this.opts.bindHost() } catch { host = null }
      if (this.disposed) return { ok: false, reason: 'unavailable' }
      if (host === null) return { ok: false, reason: 'no-network' }
      if (!isIPv4(host) || host === '0.0.0.0') return { ok: false, reason: 'unavailable' }
      // Node checks the two timeouts only every connectionsCheckingInterval (30 s by default), so check every second.
      const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 20000, connectionsCheckingInterval: 1000 })
      const listener: Listener = { server, host, port: 0, leases: 0, stopped: false, sockets: new Set(), limits: new RequestLimits() }
      server.maxConnections = 8; server.keepAliveTimeout = 0
      server.on('connection', (socket) => {
        listener.sockets.add(socket); socket.on('close', () => listener.sockets.delete(socket))
      })
      server.on('clientError', (_error, socket) => socket.destroy())
      const dispatch = (req: IncomingMessage, res: ServerResponse): void => {
        void this.dispatch(listener, req, res).catch(() => {
          this.logger.warn('Remote request could not be completed')
          if (!res.headersSent) { res.statusCode = 500; res.end('Please try again.') } else res.destroy()
        })
      }
      server.on('request', dispatch)
      server.on('checkContinue', dispatch)
      server.on('checkExpectation', dispatch)
      let port = 0
      try {
        port = this.opts.port()
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen({ host, port, ipv6Only: false }, () => { server.off('error', reject); resolve() })
        })
      } catch {
        server.close(); this.logger.warn('Remote listener unavailable', { port })
        return { ok: false, reason: 'unavailable' }
      }
      server.on('error', () => this.logger.warn('Remote listener unavailable', { port: listener.port }))
      const address = server.address()
      if (!address || typeof address === 'string' || this.disposed) {
        server.close(); for (const socket of listener.sockets) socket.destroy()
        return { ok: false, reason: 'unavailable' }
      }
      listener.port = address.port; this.listener = listener
      this.logger.info('Remote listener started', { port: listener.port })
    }
    const listener = this.listener
    listener.leases++
    let released = false
    return { ok: true, host: listener.host, port: listener.port, release: () => {
      if (released) return
      released = true
      if (--listener.leases === 0) this.stop(listener)
    } }
  }
  private stop(listener: Listener): void {
    if (listener.stopped) return
    listener.stopped = true
    if (this.listener === listener) this.listener = undefined
    this.draining.add(listener)
    // close() stops listening immediately, while active responses retain their sockets.
    listener.server.close(() => {
      if (listener.timer) clearTimeout(listener.timer)
      this.draining.delete(listener)
    })
    listener.limits = new RequestLimits()
    listener.timer = setTimeout(() => {
      for (const socket of listener.sockets) socket.destroy()
      this.draining.delete(listener)
    }, 5000)
    listener.timer.unref()
    this.logger.info('Remote listener stopped', { port: listener.port })
  }
  private async dispatch(listener: Listener, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A request whose headers finish after the last lease ended must not reach a route (it could meet the next code).
    if (listener.stopped) { req.socket.destroy(); return }
    if (!allowedSocket(req.socket.remoteAddress, req.socket.localAddress, listener.host)) {
      this.logger.warn('source refused'); req.socket.destroy(); return
    }
    res.shouldKeepAlive = false
    res.setHeader('Connection', 'close')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    const authority = `${listener.host}:${listener.port}`
    let url: URL | undefined
    try { url = new URL(req.url ?? '', `http://${authority}`) }
    catch { /* Malformed requests still count towards the rate limit. */ }
    const favicon = req.method === 'GET' && url?.pathname === '/favicon.ico'
    const withinLimit = favicon || listener.limits.allow(normaliseAddress(req.socket.remoteAddress), (this.opts.now ?? Date.now)())
    // Node keeps only the first of several Host lines, so count them in the raw headers.
    const hostLines = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length
    if (hostLines !== 1 || req.headers.host?.toLowerCase() !== authority.toLowerCase()) {
      res.statusCode = 400; res.end('Bad request.'); return
    }
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`) {
      res.statusCode = 403; res.end('Request refused.'); return
    }
    if (!withinLimit) {
      res.statusCode = 429
      if (req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end('{"error":"rate"}')
      } else res.end('Too many tries. Wait a minute, then try again.')
      return
    }
    if (!url) { res.statusCode = 400; res.end('Bad request.'); return }
    if (favicon) { res.statusCode = 404; res.end('Not found.'); return }
    if (req.headers.expect !== undefined) { res.statusCode = 400; res.end('Bad request.'); return }
    const handler = this.routes.get(url.pathname)
    if (!handler) { res.statusCode = 404; res.end('Not found.'); return }
    const nonce = randomBytes(18).toString('base64')
    // Also set on non-HTML replies so routes cannot accidentally omit an HTML policy.
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    await handler(req, res, { url, nonce })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.listener) this.stop(this.listener)
    for (const listener of this.draining) {
      if (listener.timer) clearTimeout(listener.timer)
      for (const socket of listener.sockets) socket.destroy()
    }
    this.draining.clear()
  }
}
