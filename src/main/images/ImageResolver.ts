import type { MediaHub } from '../hub/MediaHub'
import { DiskCache } from './DiskCache'
import { parseImageUrl, type ParsedImageUrl } from './parseImageUrl'
import { silentLog, type Log } from '../log/Logger'
import { redactUrl } from '../log/redact'

export interface ImageResult { status: number; mime: string; body: Uint8Array }
export interface ResolverOptions { fetch?: typeof fetch; maxBytes?: number; logger?: Log; timeoutSignal?: (ms: number) => AbortSignal }
const failure = (status: number): ImageResult => ({ status, mime: 'text/plain', body: new Uint8Array() })

export class ImageResolver {
  private pending = new Map<string, Promise<ImageResult>>()
  constructor(private hub: Pick<MediaHub, 'get'>, readonly cache: DiskCache, private opts: ResolverOptions = {}) {}

  async resolve(url: string): Promise<ImageResult> {
    let parsed: ParsedImageUrl
    try { parsed = parseImageUrl(url) } catch { return failure(400) }
    const key = DiskCache.key([parsed.sourceId, parsed.itemId, parsed.kind, parsed.w, parsed.h])
    let job = this.pending.get(key)
    if (!job) {
      job = this.load(parsed, key).catch((error: unknown) => {
        ;(this.opts.logger ?? silentLog).warn('Artwork could not be loaded', error)
        return failure(502)
      }).finally(() => this.pending.delete(key))
      this.pending.set(key, job)
    }
    const result = await job
    return { ...result, body: result.body.slice() }
  }

  private async load(p: ParsedImageUrl, key: string): Promise<ImageResult> {
    const generation = this.cache.revision
    const source = this.hub.get(p.sourceId)
    if (!source) return failure(404)
    const cached = await this.cache.get(key)
    if (cached) return { status: 200, ...cached }
    const image = source.image(p.itemId, p.kind, p.w, p.h)
    if (image.kind === 'none') return failure(404)
    if (image.kind === 'inline') {
      if (!/^image\/(jpeg|png|webp|gif|avif|svg\+xml)$/.test(image.mime)) return failure(502)
      return { status: 200, mime: image.mime,
        body: typeof image.body === 'string' ? Buffer.from(image.body, 'utf8') : image.body }
    }
    let response: Response
    try {
      let url = new URL(image.url)
      const origin = image.authOrigin ? new URL(image.authOrigin).origin : undefined
      const signal = (this.opts.timeoutSignal ?? AbortSignal.timeout)(10_000)
      for (let hops = 0; ; hops++) {
        if (!['http:', 'https:'].includes(url.protocol)) return failure(502)
        response = await (this.opts.fetch ?? fetch)(url.toString(), { redirect: 'manual',
          headers: url.origin === origin ? image.headers : {}, signal })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || hops >= 5) return failure(502)
        url = new URL(location, url)
      }
    } catch {
      const parsed = URL.canParse(image.url) ? new URL(image.url) : undefined
      ;(this.opts.logger ?? silentLog).warn('Artwork request failed',
        parsed ? redactUrl(`${parsed.origin}${parsed.pathname}`) : 'Invalid address')
      return failure(502)
    }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const cap = this.opts.maxBytes ?? 15 * 1024 * 1024
    if (!response.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(mime) || Number(response.headers.get('content-length')) > cap) {
      await response.body?.cancel()
      return failure(response.status === 404 ? 404 : 502)
    }
    if (!response.body) return failure(502)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        if (length > cap) { await reader.cancel(); return failure(413) }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const body = Buffer.concat(chunks)
    await this.cache.put(key, { mime, body }, generation)
    return { status: 200, mime, body }
  }
}
