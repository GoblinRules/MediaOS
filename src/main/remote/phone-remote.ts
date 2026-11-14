import { randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventPayloads } from '../../shared/ipc-contract'
import type { PairEndReason, PairStartResult, PhoneInfo, RemoteText } from '../../shared/remote-types'
import type { Result } from '../../shared/system-types'
import { runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'
import type { SettingsStore } from '../settings/SettingsStore'
import type { RemoteLease, RemoteServer } from './RemoteServer'
import { PhoneStore, phoneName } from './phone-store'
import { PHONE_ACTIONS, PHONE_TEXT_LIMIT, remotePage, type PhoneAction } from './remote-page'
import { normaliseAddress, RequestLimits } from './source-policy'

export interface PhoneRemotePort {
  pairStart(): Promise<PairStartResult>
  pairCancel(): Promise<Result>
  phones(): PhoneInfo[]
  removePhone(id: string): Promise<Result>
  dispose(): void
}
type RemoteEvent = 'remotePaired' | 'remotePairEnded' | 'remotePhones'
interface Options {
  server: Pick<RemoteServer, 'mount' | 'acquire'>
  settings: Pick<SettingsStore, 'get' | 'onChange'>
  store: PhoneStore
  bindHost(): Promise<string | null>
  action(action: PhoneAction): Promise<number | void>
  text(value: RemoteText): Promise<void>
  emit<E extends RemoteEvent>(event: E, value: EventPayloads[E]): void
  clock?: Runtime
  logger?: Log
}
type Lease = Extract<RemoteLease, { ok: true }>
interface Session { code: string; expires: number; claimed: boolean; wrong: number; lease: Lease }

export class PhoneRemote implements PhoneRemotePort {
  private clock: Runtime
  private logger: Log
  private session?: Session
  private revision = 0
  private expiry?: ReturnType<typeof setTimeout>
  private interval: ReturnType<typeof setInterval>
  private unsubscribe: () => void
  private keeper?: Lease
  private keeperPort?: number
  private keeping = false
  private keepAgain = false
  private disposed = false
  private authLimits = new RequestLimits()
  private actions: { phone: string; work: () => Promise<number | void>; resolve(value: number | void): void;
    reject(error: unknown): void }[] = []
  private revoking = new Set<string>()
  private keepRun?: Promise<void>
  private acting = false

  constructor(private opts: Options) {
    this.clock = opts.clock ?? runtime; this.logger = opts.logger ?? silentLog
    opts.server.mount('/remote', (req, res, { nonce }) => {
      if (req.method !== 'GET') { this.method(res, 'GET'); return }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(remotePage({ nonce }))
    })
    for (const path of ['pair', 'key', 'text', 'forget'] as const) {
      opts.server.mount(`/remote/${path}`, (req, res) => this.handle(path, req, res),
        path === 'key' || path === 'text' ? { limits: { perSource: 600, total: 1200 } } : undefined)
    }
    this.unsubscribe = opts.settings.onChange(() => this.refresh())
    this.interval = this.clock.setInterval(() => this.refresh(), 30000)
    this.refresh()
  }
  private enabled(): boolean { return !this.disposed && this.opts.settings.get().remote.phoneRemote }
  async pairStart(): Promise<PairStartResult> {
    if (!this.enabled()) return { ok: false, error: 'off' }
    this.end('expired')
    const revision = this.revision
    let lease: RemoteLease
    try { lease = await this.opts.server.acquire() } catch { return { ok: false, error: 'unavailable' } }
    if (this.disposed || revision !== this.revision || !this.enabled()) {
      if (lease.ok) lease.release()
      return { ok: false, error: 'unavailable' }
    }
    if (!lease.ok) return { ok: false, error: lease.reason }
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0'), expires = this.clock.now() + 300000
    this.session = { code, expires, claimed: false, wrong: 0, lease }
    this.expiry = this.clock.setTimeout(() => this.end('expired'), 300000)
    return { ok: true, code, url: `http://${lease.host}:${lease.port}/remote?code=${code}`,
      expiresAt: new Date(expires).toISOString() }
  }
  async pairCancel(): Promise<Result> { this.end(); return { ok: true } }
  private end(reason?: PairEndReason): void {
    ++this.revision
    if (this.expiry !== undefined) this.clock.clearTimeout(this.expiry)
    this.expiry = undefined
    const session = this.session
    this.session = undefined
    if (session && reason === 'paired') this.releaseAfterKeep(session.lease)
    else session?.lease.release()
    if (session && reason) this.opts.emit('remotePairEnded', { reason })
  }
  /** After a pairing the keeper takes over the listener; hold the pairing lease until it has, so the listener never blinks. */
  private releaseAfterKeep(lease: Lease): void {
    void (async () => {
      for (let i = 0; i < 4 && this.keeping && this.keepRun; i++) await this.keepRun
      lease.release()
    })()
  }
  phones(): PhoneInfo[] { return this.opts.store.list() }
  async removePhone(id: string): Promise<Result> {
    try {
      await this.revoke(id)
      return { ok: true }
    } catch { return { ok: false, error: "Couldn't remove this phone. Try again." } }
  }
  /** Remove a phone. Anything it queued is dropped at once, and none of it runs while the write is in flight. */
  private async revoke(id: string): Promise<void> {
    this.revoking.add(id)
    this.drop((job) => job.phone === id)
    try { await this.opts.store.remove(id) } finally { this.revoking.delete(id) }
    this.changed()
  }
  private drop(match: (job: PhoneRemote['actions'][number]) => boolean): void {
    for (const job of this.actions) if (match(job)) job.resolve()
    this.actions = this.actions.filter((job) => !match(job))
  }
  private changed(): void { this.refresh(); if (!this.disposed) this.opts.emit('remotePhones', {}) }
  private wanted(): boolean { return this.enabled() && this.opts.store.count() > 0 }
  private refresh(): void {
    if (this.disposed) return
    if (!this.enabled()) { this.end('off'); this.drop(() => true) }
    if (!this.wanted()) { this.keeper?.release(); this.keeper = undefined }
    if (this.keeping) { this.keepAgain = true; return }
    this.keeping = true
    this.keepRun = this.keep().catch(() => this.logger.warn('Phone remote listener unavailable')).finally(() => {
      this.keeping = false
      if (this.keepAgain) { this.keepAgain = false; this.refresh() }
    })
  }
  private async keep(): Promise<void> {
    if (!this.wanted()) return
    const port = this.opts.settings.get().remote.port
    if (this.keeper) {
      let host: string | null
      try { host = await this.opts.bindHost() } catch { host = null }
      if (!this.wanted()) return
      if (this.keeper && (host !== this.keeper.host || port !== this.keeperPort)) {
        // Another lease (pairing or VPN upload) can keep the old listener alive until it too is released.
        this.keeper.release(); this.keeper = undefined
      }
    }
    if (this.keeper || !this.wanted()) return
    const lease = await this.opts.server.acquire()
    if (!lease.ok) return // The injected 30-second timer retries.
    if (!this.wanted() || port !== this.opts.settings.get().remote.port) { lease.release(); return }
    // Use the listener's actual port: another lease may have kept an old port alive during this acquire.
    this.keeper = lease; this.keeperPort = lease.port
  }
  private method(res: ServerResponse, allow: string): void {
    res.setHeader('Allow', allow); this.json(res, 405, { error: 'bad-request' })
  }
  private json(res: ServerResponse, status: number, body: object): void {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body))
  }
  private async handle(path: 'pair' | 'key' | 'text' | 'forget', req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { this.method(res, 'POST'); return }
    const body = await this.body(req, res)
    if (!body) return
    if (!this.enabled()) { this.json(res, 403, { error: 'off' }); return }
    try {
      if (path === 'pair') { await this.pair(req, res, body); return }
      const source = normaliseAddress(req.socket.remoteAddress), now = this.clock.now()
      if (this.authLimits.blocked(source, now)) { this.json(res, 429, { error: 'rate' }); return }
      const auth = req.headers.authorization, token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
      const phone = this.opts.store.find(token)
      if (!phone) {
        this.authLimits.allow(source, now)
        this.json(res, 401, { error: 'unpaired' }); return
      }
      await this.opts.store.touch(phone.id)
      if (!this.enabled()) { this.json(res, 403, { error: 'off' }); return }
      if (path === 'forget') {
        if (Object.keys(body).length) { this.json(res, 400, { error: 'bad-request' }); return }
        await this.revoke(phone.id)
        this.json(res, 200, { ok: true }); return
      }
      if (path === 'key') {
        if (typeof body.action !== 'string' || !PHONE_ACTIONS.includes(body.action as PhoneAction)) {
          this.json(res, 400, { error: 'bad-request' }); return
        }
        const action = body.action as PhoneAction
        const volume = await this.enqueue(phone.id, () => this.opts.action(action))
        this.json(res, 200, { ok: true, ...(typeof volume === 'number' ? { volume } : {}) }); return
      }
      const keys = Object.keys(body)
      if (keys.length !== 1 || !(keys[0] === 'text' && typeof body.text === 'string' &&
        body.text.length >= 1 && body.text.length <= PHONE_TEXT_LIMIT) &&
        !(keys[0] === 'backspace' && body.backspace === true)) {
        this.json(res, 400, { error: 'bad-request' }); return
      }
      const text = typeof body.text === 'string' ? body.text.replace(/[\p{Cc}\p{Cf}]/gu, '') : undefined
      if (text !== '') await this.enqueue(phone.id, () => this.opts.text(text === undefined ? { backspace: true } : { text }))
      this.json(res, 200, { ok: true })
    } catch {
      this.logger.warn('Phone remote request could not be completed')
      this.json(res, 503, { error: 'unavailable' })
    }
  }
  private async pair(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const session = this.session
    if (session && this.clock.now() >= session.expires) this.end('expired')
    if (!session || this.session !== session || session.claimed) { this.json(res, 403, { error: 'expired' }); return }
    if (typeof body.code !== 'string' || (body.previous !== undefined && typeof body.previous !== 'string')) {
      this.json(res, 400, { error: 'bad-request' }); return
    }
    const supplied = Buffer.from(body.code), expected = Buffer.from(session.code)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      if (++session.wrong >= 5) this.end('too-many-tries')
      this.json(res, 403, { error: 'wrong-code' }); return
    }
    session.claimed = true // Claim synchronously, before either store write can yield.
    try {
      const previous = typeof body.previous === 'string' ? this.opts.store.find(body.previous) : undefined
      if (previous) { this.revoking.add(previous.id); this.drop((job) => job.phone === previous.id) }
      let added: Awaited<ReturnType<PhoneStore['add']>>
      try { added = await this.opts.store.add(phoneName(req.headers['user-agent']), previous?.id) }
      finally { if (previous) this.revoking.delete(previous.id) }
      this.changed()
      if (this.session !== session || this.clock.now() >= session.expires || !this.enabled()) {
        if (this.session === session) this.end(this.enabled() ? 'expired' : 'off')
        await added.undo(); this.changed() // Puts back the previous phone and any phone evicted to make room.
        this.json(res, 403, { error: this.enabled() ? 'expired' : 'off' }); return
      }
      const phone = this.opts.store.list().find((p) => p.id === added.id)!
      this.opts.emit('remotePaired', { id: added.id, name: phone.name, ...(added.replaced ? { replaced: added.replaced } : {}) })
      this.end('paired')
      this.json(res, 200, { ok: true, token: added.token })
    } catch (error) {
      if (this.session === session) this.end('expired')
      throw error
    }
  }
  private enqueue(phone: string, work: () => Promise<number | void>): Promise<number | void> {
    if (this.disposed || this.actions.length >= 8) return Promise.resolve()
    const result = new Promise<number | void>((resolve, reject) => this.actions.push({ phone, work, resolve, reject }))
    void this.drain()
    return result
  }
  private async drain(): Promise<void> {
    if (this.acting) return
    this.acting = true
    try {
      while (this.actions.length) {
        const job = this.actions.shift()!
        try { job.resolve(this.live(job.phone) ? await job.work() : undefined) } catch (error) { job.reject(error) }
      }
    } finally { this.acting = false }
  }
  /** A queued job may run only while the remote is on and its phone is still paired. */
  private live(phone: string): boolean {
    return this.enabled() && !this.revoking.has(phone) && this.opts.store.has(phone)
  }
  private async body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    if (req.headers['x-mediaos-remote'] !== '1' ||
      !/^application\/json\s*(?:;[^\r\n]*)?$/i.test(req.headers['content-type'] ?? '')) {
      this.json(res, 400, { error: 'bad-request' }); return
    }
    const tooLarge = (): void => { req.pause(); this.json(res, 413, { error: 'bad-request' }) }
    if (Number(req.headers['content-length']) > 1024) { tooLarge(); return }
    const data = await new Promise<Buffer | undefined>((resolve) => {
      const chunks: Buffer[] = []
      let size = 0, done = false
      const finish = (value?: Buffer): void => {
        if (done) return
        done = true; req.off('data', chunk); req.off('end', end); req.off('aborted', abort); resolve(value)
      }
      const abort = (): void => finish()
      const end = (): void => finish(Buffer.concat(chunks, size))
      const chunk = (value: Buffer): void => {
        size += value.length
        if (size > 1024) { tooLarge(); finish() } else chunks.push(value)
      }
      req.on('data', chunk); req.once('end', end); req.once('aborted', abort); req.once('error', abort)
    })
    if (!data) return
    try {
      const value: unknown = JSON.parse(data.toString('utf8'))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* Never log body text or JSON parse errors. */ }
    this.json(res, 400, { error: 'bad-request' })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe(); this.clock.clearInterval(this.interval)
    this.end(); this.keeper?.release(); this.keeper = undefined
    for (const job of this.actions.splice(0)) job.resolve()
  }
}
