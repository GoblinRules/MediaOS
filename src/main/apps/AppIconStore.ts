import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppEntry } from '@shared/apps'
import type { ImageResult } from '../images/ImageResolver'
import { silentLog, type Log } from '../log/Logger'
import { redactUrl } from '../log/redact'
import { APP_CATALOG } from './app-catalog'
import { orderIconCandidates, parseIconHtml, parseIconManifest, type IconCandidate } from './icon-parse'

export const ICON_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** Pages are only read this far: icon links sit in the head, and streaming home pages run to megabytes. */
const HTML_CAP = 1024 * 1024, MANIFEST_CAP = 256 * 1024, ICON_CAP = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const missing = (): ImageResult => ({ status: 404, mime: 'text/plain', body: new Uint8Array() })

export interface AppIconOptions {
  apps?: readonly AppEntry[]
  fetch?: typeof fetch
  now?: () => number
  logger?: Log
  mode?: 'fetch' | 'off'
}
interface Note { mime?: string; fetchedAt?: number; url?: string; failedAt?: number }
interface Cached { note: Note; body?: Uint8Array }

/** No Electron or cookie jar: fetches public site icons and keeps successful bytes across shell restarts. */
export class AppIconStore {
  private cached = new Map<string, Promise<Cached>>()
  private pending = new Map<string, Promise<ImageResult>>()
  private stop = new AbortController()
  private now: () => number
  private logger: Log

  constructor(readonly folder: string, private opts: AppIconOptions = {}) {
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? silentLog
  }

  async resolve(appId: string): Promise<ImageResult> {
    const app = (this.opts.apps ?? APP_CATALOG).find((entry) => entry.id === appId)
    if (!appId || appId.length > 64 || /[^a-z0-9-]/.test(appId) || !app ||
      this.opts.mode === 'off' || this.stop.signal.aborted) return missing()
    let cached = this.cached.get(appId)
    if (!cached) { cached = this.read(appId); this.cached.set(appId, cached) }
    const entry = await cached
    const retry = entry.note.failedAt === undefined || this.now() - entry.note.failedAt >= DAY
    if (entry.body && entry.note.mime) {
      if (this.now() - (entry.note.fetchedAt ?? 0) >= 30 * DAY && retry) void this.lookup(app, entry)
      return { status: 200, mime: entry.note.mime, body: Buffer.from(entry.body) }
    }
    return retry ? this.lookup(app, entry) : missing()
  }

  private lookup(app: AppEntry, cached: Cached): Promise<ImageResult> {
    if (this.stop.signal.aborted) return Promise.resolve(missing())
    const pending = this.pending.get(app.id)
    if (pending) return pending.then(copy)
    const job = this.refresh(app, cached).finally(() => this.pending.delete(app.id))
    this.pending.set(app.id, job)
    return job.then(copy)
  }

  private async refresh(app: AppEntry, cached: Cached): Promise<ImageResult> {
    const lookup = new AbortController()
    const timer = setTimeout(() => lookup.abort(), 30_000)
    const signal = AbortSignal.any([lookup.signal, this.stop.signal])
    let found: { body: Uint8Array; mime: string; url: string } | undefined
    try {
      const icons = await this.discover(app, signal)
      for (const icon of orderIconCandidates(icons)) {
        if (signal.aborted) break
        try {
          const result = await this.request(icon.url, ICON_CAP, signal)
          const mime = iconMime(result.body)
          if (mime) { found = { ...result, mime }; break }
        } catch { /* Try the next candidate within the same overall deadline. */ }
      }
    } catch { /* The old icon survives a failed page request or refresh. */ }
    finally { clearTimeout(timer) }
    // Switching off mid-lookup is not a failure: try again next time instead of waiting a day.
    if (!found && this.stop.signal.aborted) return missing()
    if (found) {
      cached.body = found.body
      cached.note = { mime: found.mime, fetchedAt: this.now(), url: withoutQuery(found.url) }
    } else cached.note = { ...cached.note, failedAt: this.now() }
    let host = ''
    try { host = new URL(found?.url ?? app.iconUrl ?? app.url).origin } catch { /* Invalid catalogue URL. */ }
    this.logger.info(`${app.id}: ${found ? 'icon found' : 'no icon'} (${redactUrl(host)})`)
    await this.write(app.id, cached, !!found)
    return found ? { status: 200, mime: found.mime, body: found.body } : missing()
  }

  private async discover(app: AppEntry, signal: AbortSignal): Promise<IconCandidate[]> {
    if (app.iconUrl) return [{ url: app.iconUrl, sizes: '', type: '', purpose: 'any' }]
    const page = await this.request(app.iconPage ?? app.url, HTML_CAP, signal, true)
    const parsed = parseIconHtml(Buffer.from(page.body).toString('utf8'), page.url)
    for (const manifest of new Set(parsed.manifests)) {
      if (signal.aborted) break
      try {
        const result = await this.request(manifest, MANIFEST_CAP, signal)
        parsed.icons.push(...parseIconManifest(Buffer.from(result.body).toString('utf8'), result.url))
      } catch { /* A missing manifest need not prevent a touch icon from working. */ }
    }
    const origin = new URL(page.url).origin
    parsed.icons.push({ url: `${origin}/apple-touch-icon.png`, sizes: '', type: '', purpose: 'any' },
      { url: `${origin}/favicon.ico`, sizes: '', type: '', purpose: 'any', fallback: true })
    return parsed.icons
  }

  /** `truncate` keeps the first `cap` bytes of a longer body instead of failing (for pages, never for icons). */
  private async request(value: string, cap: number, lookup: AbortSignal, truncate = false): Promise<{ body: Uint8Array; url: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let signal = lookup
    let response: Response | undefined
    try {
      let url = new URL(value)
      for (let hops = 0; ; hops++) {
        const controller = new AbortController()
        timer = setTimeout(() => controller.abort(), 10_000)
        signal = AbortSignal.any([controller.signal, lookup])
        signal.throwIfAborted()
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid icon URL')
        response = await abortable(() => (this.opts.fetch ?? fetch)(url.href, { redirect: 'manual', credentials: 'omit',
          headers: { 'User-Agent': ICON_USER_AGENT }, signal }), signal)
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        void response.body?.cancel().catch(() => undefined)
        if (!location || hops >= 5) throw new Error('Invalid icon redirect')
        url = new URL(location, url)
        clearTimeout(timer)
      }
      if (!response.ok || !response.body || (!truncate && Number(response.headers.get('content-length')) > cap)) {
        throw new Error('Icon request failed')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { value: chunk, done } = await abortable(() => reader.read(), signal)
          if (done) break
          if (length + chunk.length > cap) {
            if (!truncate) throw new Error('Icon body too large')
            chunks.push(chunk.subarray(0, cap - length))
            void reader.cancel().catch(() => undefined)
            break
          }
          length += chunk.length
          chunks.push(chunk)
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined)
        throw error
      } finally { reader.releaseLock() }
      return { body: Buffer.concat(chunks), url: url.href }
    } finally {
      clearTimeout(timer)
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
    }
  }

  private async read(id: string): Promise<Cached> {
    try {
      const file = join(this.folder, `${id}.json`)
      if ((await fs.stat(file)).size > 4096) return { note: {} }
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!value || typeof value !== 'object') return { note: {} }
      const note = value as Note
      if ([note.fetchedAt, note.failedAt].some((time) => time !== undefined && (typeof time !== 'number' || !Number.isFinite(time)))) {
        return { note: {} }
      }
      if (!note.mime || typeof note.url !== 'string' || note.fetchedAt === undefined) {
        return { note: { failedAt: note.failedAt } }
      }
      const icon = join(this.folder, `${id}.bin`)
      if ((await fs.stat(icon)).size > ICON_CAP) return { note: {} }
      const body = await fs.readFile(icon)
      return iconMime(body) === note.mime ? { note, body } : { note: {} }
    } catch { return { note: {} } }
  }

  private async write(id: string, cached: Cached, image: boolean): Promise<void> {
    try {
      await fs.mkdir(this.folder, { recursive: true })
      if (image && cached.body) await this.atomic(join(this.folder, `${id}.bin`), cached.body)
      await this.atomic(join(this.folder, `${id}.json`), JSON.stringify(cached.note))
    } catch { /* Read-only or full storage must not stop the tiles from working. */ }
  }

  private async atomic(file: string, body: string | Uint8Array): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`
    try { await fs.writeFile(temp, body, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temp, file) }
    finally { await fs.rm(temp, { force: true }).catch(() => undefined) }
  }

  async dispose(): Promise<void> {
    this.stop.abort()
    await Promise.allSettled(this.pending.values())
  }
}

function withoutQuery(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}

function copy(result: ImageResult): ImageResult { return { ...result, body: Buffer.from(result.body) } }

/** Race even injected transports/readers against the deadline, without leaving event listeners behind. */
async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Icon request timed out'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([work(), cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

export function iconMime(bytes: Uint8Array): string | undefined {
  const body = Buffer.from(bytes)
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg'
  if (body.length >= 12 && body.toString('latin1', 0, 4) === 'RIFF' && body.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (['GIF87a', 'GIF89a'].includes(body.toString('latin1', 0, 6))) return 'image/gif'
  if (body.length >= 6 && body.readUInt32LE(0) === 0x00010000 && body.readUInt16LE(4) > 0) return 'image/x-icon'
  const text = body.toString('utf8')
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    const comment = text.startsWith('<!--', i), xml = text.startsWith('<?xml', i)
    if (!comment && !xml) break
    const end = text.indexOf(comment ? '-->' : '?>', i + (comment ? 4 : 5))
    if (end < 0) return undefined
    i = end + (comment ? 3 : 2)
  }
  return /^<svg(?:\s|\/?>)/.test(text.slice(i)) ? 'image/svg+xml' : undefined
}
