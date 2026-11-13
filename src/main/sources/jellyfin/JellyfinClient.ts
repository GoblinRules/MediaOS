import { SourceError } from '../MediaSource'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'

export interface ClientOptions {
  url: string; name: string; deviceId: string; deviceName: string; appVersion: string
  token?: string; fetch?: typeof fetch; clock?: Runtime; logger?: Log; onAuthError?: () => void
}

export class JellyfinHttpError extends SourceError {
  constructor(message: string, code: SourceError['code'], readonly status: number) { super(message, code) }
}

export function normaliseAddress(value: string): string {
  try {
    const text = value.trim()
    if (!text || /[\s\\]/.test(text) || (/^[a-z][a-z\d+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text))) throw Error()
    const explicit = /^https?:\/\//i.test(text)
    if (!explicit && !/^(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?|\[[a-f\d:.]+\])(?::\d+)?(?:\/[^?#]*)?$/i.test(text)) throw Error()
    const url = new URL(explicit ? text : `http://${text}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Error()
    const authority = text.split(/[/?#]/)[0]!.split('@').at(-1)!
    if (!explicit && !url.port && !/:\d+$/.test(authority)) url.port = '8096'
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/web$/i, '')
    return url.toString().replace(/\/+$/, '')
  } catch { throw new SourceError('That server address is not valid. Check it and try again.', 'unsupported') }
}

const quote = (value: string): string => value.replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
export type Query = Record<string, string | number | boolean | undefined>

/** The only JSON transport: never forwards server bodies or native fetch errors to logs or the screen. */
export class JellyfinClient {
  readonly base: string
  readonly authorization: string
  private clock: Runtime
  private pending = new Set<AbortController>()
  private disposed = false
  constructor(private opts: ClientOptions) {
    this.base = normaliseAddress(opts.url)
    this.clock = opts.clock ?? runtime
    this.authorization = `MediaBrowser Client="MediaOS", Device="${quote(opts.deviceName)}", ` +
      `DeviceId="${quote(opts.deviceId)}", Version="${quote(opts.appVersion)}"` +
      (opts.token ? `, Token="${quote(opts.token)}"` : '')
  }

  url(path: string, query: Query = {}): string {
    const url = new URL(`${this.base}${path}`)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    return url.toString()
  }

  /** Delivery and transcode paths are server-local; never give mpv credentials for a different origin. */
  deliveryUrl(path: string): string {
    try {
      const base = new URL(this.base)
      const prefix = base.pathname.replace(/\/$/, '')
      const url = /^https?:\/\//i.test(path) ? new URL(path) :
        new URL(prefix && path.startsWith(`${prefix}/`) ? `${base.origin}${path}` : `${this.base}/${path.replace(/^\/+/, '')}`)
      if (url.origin !== base.origin || url.username || url.password) throw Error()
      return url.toString()
    } catch { throw this.failure('unsupported') }
  }

  private failure(code: SourceError['code']): SourceError {
    const name = this.opts.name
    const messages: Partial<Record<SourceError['code'], string>> = {
      offline: `Can't reach ${name}. Check the server is switched on.`,
      timeout: `Can't reach ${name}. Check the server is switched on.`,
      auth: `${name} signed MediaOS out. Remove it in Settings and add it again.`,
      notFound: `That's no longer on ${name}.`,
      unsupported: `${name} can't play this file on the TV.`,
    }
    return new SourceError(messages[code] ?? `Something went wrong on ${name}. Try again in a moment.`, code)
  }

  async request<T>(path: string, query: Query = {}, method = 'GET', body?: unknown): Promise<T> {
    if (this.disposed) throw this.failure('offline')
    const controller = new AbortController()
    this.pending.add(controller)
    let timedOut = false
    const timer = this.clock.setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.failure(timedOut ? 'timeout' : 'offline'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const work = async (): Promise<T> => {
      const response = await (this.opts.fetch ?? globalThis.fetch)(this.url(path, query), {
        method, signal: controller.signal, redirect: 'error',
        headers: { Authorization: this.authorization, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      ;(this.opts.logger ?? silentLog).debug(method, path.split('?')[0], response.status)
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        const code = response.status === 401 || response.status === 403 ? 'auth' :
          response.status === 404 ? 'notFound' : 'server'
        if (code === 'auth') this.opts.onAuthError?.()
        throw new JellyfinHttpError(this.failure(code).message, code, response.status)
      }
      const text = await this.readBody(response, controller.signal)
      if (!text) return undefined as T
      try { return JSON.parse(text) as T } catch { throw this.failure('server') }
    }
    try { return await Promise.race([work(), aborted]) } catch (error) {
      if (error instanceof SourceError) throw error
      throw this.failure(controller.signal.aborted ? timedOut ? 'timeout' : 'offline' : 'offline')
    } finally {
      this.clock.clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      this.pending.delete(controller)
    }
  }

  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const cancel = (): void => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 8 * 1024 * 1024) { cancel(); throw this.failure('server') }
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
  }
}
