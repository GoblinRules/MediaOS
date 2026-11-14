import { randomInt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'
import { stripDisplayControls } from '../vpn/display-text'
import { RemoteServer, type RemoteLease } from './RemoteServer'
import { UPLOAD_LIMIT_BYTES, uploadPage } from './upload-page'

export type UploadOpenResult = { ok: true; url: string; code: string; expiresAt: string } |
  { ok: false; error: 'no-network' | 'upload-unavailable' }
export interface VpnUploadPort { open(): Promise<UploadOpenResult>; close(): void }
/** receiveFile resolves false when the TV's import ended before the file arrived, so the phone hears "expired". */
export interface UploadReceiver {
  receiveFile(name: string, data: Buffer, code: string): Promise<boolean>
  uploadTooLarge(code: string): void
}
interface Session { code: string; expires: number; claimed: boolean; lease: Extract<RemoteLease, { ok: true }> }

export class VpnUpload implements VpnUploadPort {
  private session?: Session
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
  private readonly clock: Runtime
  private readonly logger: Log
  constructor(private server: RemoteServer, private receiver: UploadReceiver, opts: { clock?: Runtime; logger?: Log } = {}) {
    this.clock = opts.clock ?? runtime; this.logger = opts.logger ?? silentLog
    server.mount('/vpn-upload', (req, res, { url, nonce }) => this.handle(req, res, url, nonce))
  }
  async open(): Promise<UploadOpenResult> {
    this.close()
    const revision = this.revision, lease = await this.server.acquire()
    if (revision !== this.revision) {
      if (lease.ok) lease.release()
      return { ok: false, error: 'upload-unavailable' }
    }
    if (!lease.ok) return { ok: false, error: lease.reason === 'no-network' ? 'no-network' : 'upload-unavailable' }
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0'), expires = this.clock.now() + 300000
    this.session = { code, expires, claimed: false, lease }
    this.timer = this.clock.setTimeout(() => this.close(), 300000)
    return { ok: true, code, url: `http://${lease.host}:${lease.port}/vpn-upload?code=${code}`,
      expiresAt: new Date(expires).toISOString() }
  }
  close(): void {
    ++this.revision
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    const session = this.session
    this.session = undefined; session?.lease.release()
  }
  private live(code: string | null): Session | undefined {
    const session = this.session
    if (!session || session.claimed || this.clock.now() >= session.expires || code === null) return undefined
    const supplied = Buffer.from(code), expected = Buffer.from(session.code)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? session : undefined
  }
  private json(res: ServerResponse, status: number, body: object): void {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body))
  }
  private async handle(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string): Promise<void> {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(uploadPage({ nonce, state: this.live(url.searchParams.get('code')) ? 'ready' : 'expired' })); return
    }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'GET, POST'); res.end('Method not allowed.'); return }
    const type = req.headers['content-type'] ?? '', plain = /^text\/plain(?:\s*;\s*charset\s*=\s*[^;]+)?\s*$/i.test(type)
    const binary = /^application\/octet-stream(?:\s*;\s*charset\s*=\s*[^;]+)?\s*$/i.test(type)
    if (req.headers['x-mediaos-upload'] !== '1' || (!plain && !binary)) {
      this.json(res, 400, { error: 'bad-request' }); return
    }
    const session = this.live(url.searchParams.get('code'))
    if (!session) { this.logger.info('upload refused: expired code'); this.json(res, 403, { error: 'expired' }); return }
    session.claimed = true
    const tooLarge = (): void => {
      req.pause()
      if (this.session === session) this.close()
      this.receiver.uploadTooLarge(session.code)
      this.logger.info('upload refused: too large'); this.json(res, 413, { error: 'too-large' })
    }
    if (Number(req.headers['content-length']) > UPLOAD_LIMIT_BYTES) { tooLarge(); return }
    const data = await this.body(req, tooLarge)
    if (data === null) {
      if (this.session === session) session.claimed = false
      return
    }
    if (!data.length || (plain && !data.toString('utf8').trim())) {
      if (this.session === session) session.claimed = false
      this.json(res, 400, { error: 'empty' }); return
    }
    if (this.session !== session || this.clock.now() >= session.expires) {
      this.json(res, 403, { error: 'expired' }); return
    }
    const name = binary ? [...stripDisplayControls((url.searchParams.get('name') ?? '').split(/[/\\]/).at(-1) ?? '')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')]
      .slice(0, 100).join('') : ''
    this.close()
    if (!await this.receiver.receiveFile(name, data, session.code)) {
      this.logger.info('upload refused: import already ended'); this.json(res, 403, { error: 'expired' }); return
    }
    this.logger.info('upload received'); this.json(res, 200, { ok: true })
  }
  private body(req: IncomingMessage, tooLarge: () => void): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let length = 0, ended = false
      const finish = (data: Buffer | null): void => {
        if (ended) return
        ended = true
        req.off('data', chunk); req.off('end', end); req.off('aborted', abort)
        // IncomingMessage can emit an error after 'aborted'; retain the error listener through teardown.
        resolve(data)
      }
      const abort = (): void => finish(null)
      const end = (): void => finish(Buffer.concat(chunks, length))
      const chunk = (data: Buffer): void => {
        length += data.length
        if (length > UPLOAD_LIMIT_BYTES) { tooLarge(); finish(null) } else chunks.push(data)
      }
      req.on('data', chunk); req.once('end', end); req.once('aborted', abort); req.once('error', abort)
    })
  }
}
