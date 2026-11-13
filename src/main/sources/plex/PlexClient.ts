import { SourceError } from '../MediaSource'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import { isSecretKey } from '../../log/redact'
import type { Query } from '../jellyfin/JellyfinClient'
export type { Query } from '../jellyfin/JellyfinClient'

export interface PlexClientOptions {
  url: string; name: string; clientId: string; deviceName: string; appVersion: string
  token?: string; fetch?: typeof fetch; clock?: Runtime; logger?: Log; onAuthError?: () => void
}
export class PlexHttpError extends SourceError {
  constructor(message: string, code: SourceError['code'], readonly status: number) { super(message, code) }
}

/** Connections never contain credentials, queries or fragments, including those supplied by resources. */
export function connectionUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined
    return url.toString().replace(/\/+$/, '')
  } catch { return undefined }
}

export class PlexClient {
  readonly base: string
  readonly headers: Record<string, string>
  private clock: Runtime
  private pending = new Set<AbortController>()
  private disposed = false
  constructor(private opts: PlexClientOptions) {
    this.base = connectionUrl(opts.url) ?? ''
    this.clock = opts.clock ?? runtime
    this.headers = { Accept: 'application/json', 'X-Plex-Product': 'MediaOS', 'X-Plex-Version': opts.appVersion,
      'X-Plex-Client-Identifier': opts.clientId, 'X-Plex-Platform': 'Linux', 'X-Plex-Device': 'MediaOS',
      'X-Plex-Device-Name': opts.deviceName, ...(opts.token ? { 'X-Plex-Token': opts.token } : {}) }
  }
  failure(code: SourceError['code']): SourceError {
    const name = this.opts.name
    const messages: Partial<Record<SourceError['code'], string>> = {
      offline: name === 'Plex' ? "Can't reach Plex. Check this TV is online." :
        `Can't reach ${name}. Check the server is switched on.`,
      auth: `${name} signed MediaOS out. Remove it in Settings and add it again.`,
      notFound: `That's no longer on ${name}.`, unsupported: `${name} can't play this file on the TV.`,
    }
    if (code === 'timeout') return new SourceError(this.failure('offline').message, code)
    return new SourceError(messages[code] ?? `Something went wrong on ${name}. Try again in a moment.`, code)
  }
  deliveryUrl(path: string): string {
    try {
      if (!this.base || (!path.startsWith('/') && !/^https?:\/\//i.test(path)) || path.startsWith('//') || /\\/.test(path)) {
        throw Error()
      }
      const url = new URL(/^https?:\/\//i.test(path) ? path : `${this.base}${path}`)
      if (url.origin !== new URL(this.base).origin || url.username || url.password || url.hash) throw Error()
      // Never preserve a server-supplied token in an artwork, part or subtitle path.
      if ([...url.searchParams.keys()].some(isSecretKey)) throw Error()
      return url.toString()
    } catch { throw this.failure('unsupported') }
  }
  url(path: string, query: Query = {}): string {
    const url = new URL(this.deliveryUrl(path))
    for (const [key, value] of Object.entries(query)) {
      if (isSecretKey(key)) throw this.failure('unsupported')
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }
  async request(path: string, query: Query = {}, method = 'GET', options: {
    signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>
  } = {}): Promise<unknown> {
    if (this.disposed || options.signal?.aborted) throw this.failure('offline')
    const url = this.url(path, query)
    const controller = new AbortController()
    this.pending.add(controller)
    let timedOut = false
    const timer = this.clock.setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 15_000)
    const cancel = (): void => controller.abort()
    options.signal?.addEventListener('abort', cancel, { once: true })
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.failure(timedOut ? 'timeout' : 'offline'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const work = async (): Promise<unknown> => {
      const response = await (this.opts.fetch ?? globalThis.fetch)(url, { method, redirect: 'error', signal: controller.signal,
        headers: { ...this.headers, ...options.headers } })
      ;(this.opts.logger ?? silentLog).debug(method, new URL(url).pathname, response.status)
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        const code = [401, 403].includes(response.status) ? 'auth' : response.status === 404 ? 'notFound' : 'server'
        if (code === 'auth') this.opts.onAuthError?.()
        throw new PlexHttpError(this.failure(code).message, code, response.status)
      }
      if (!response.body) return undefined
      const reader = response.body.getReader()
      const stop = (): void => { void reader.cancel().catch(() => undefined) }
      controller.signal.addEventListener('abort', stop, { once: true })
      if (controller.signal.aborted) stop()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > 8 * 1024 * 1024) { stop(); throw this.failure('server') }
          chunks.push(value)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return undefined
        try { return JSON.parse(text) as unknown } catch { throw this.failure('server') }
      } finally { controller.signal.removeEventListener('abort', stop); reader.releaseLock() }
    }
    try { return await Promise.race([work(), aborted]) } catch (error) {
      if (error instanceof SourceError) throw error
      throw this.failure(timedOut ? 'timeout' : 'offline')
    } finally {
      this.clock.clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', onAbort)
      this.pending.delete(controller)
    }
  }
  dispose(): void {
    this.disposed = true
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
  }
}
