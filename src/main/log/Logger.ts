import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { isSecretKey, redact } from './redact'
import type { FileSystem } from '../settings/atomic'

export interface Log { debug(message: unknown, ...data: unknown[]): void; info(message: unknown, ...data: unknown[]): void
  warn(message: unknown, ...data: unknown[]): void; error(message: unknown, ...data: unknown[]): void }
export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} }
export interface LoggerOptions { dev?: boolean; maxBytes?: number; fs?: FileSystem; now?: () => number }

export class Logger implements Log {
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private readonly io: FileSystem

  constructor(readonly dir: string, private opts: LoggerOptions = {}, private scope = '', private root?: Logger) {
    this.io = opts.fs ?? fs
  }

  child(scope: string): Logger { return new Logger(this.dir, this.opts, [this.scope, scope].filter(Boolean).join(':'), this.root ?? this) }
  debug(message: unknown, ...data: unknown[]): void { this.write('debug', message, data) }
  info(message: unknown, ...data: unknown[]): void { this.write('info', message, data) }
  warn(message: unknown, ...data: unknown[]): void { this.write('warn', message, data) }
  error(message: unknown, ...data: unknown[]): void { this.write('error', message, data) }

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: unknown, data: unknown[]): void {
    const owner = this.root ?? this
    if (owner.closed) return
    const text = redact([message, ...data].map(format).join(' ')).replace(/\r?\n/g, '\\n')
    const line = `${new Date((this.opts.now ?? Date.now)()).toISOString()} ${level.toUpperCase()} [${this.scope || 'core'}] ${text}\n`
    if (this.opts.dev) console[level](line.trimEnd())
    owner.queue = owner.queue.then(() => owner.append(line)).catch(() => undefined)
  }

  private async append(line: string): Promise<void> {
    await this.io.mkdir(this.dir, { recursive: true })
    const file = join(this.dir, 'mediaos.log')
    const size = await this.io.stat(file).then((s) => s.size).catch(() => 0)
    if (size && size + Buffer.byteLength(line) > (this.opts.maxBytes ?? 5 * 1024 * 1024)) {
      await this.io.rm(`${file}.3`, { force: true })
      for (let n = 2; n >= 0; n--) {
        await this.io.rename(n ? `${file}.${n}` : file, `${file}.${n + 1}`).catch(() => undefined)
      }
    }
    await this.io.appendFile(file, line, 'utf8')
  }

  async close(): Promise<void> { const owner = this.root ?? this; owner.closed = true; await owner.queue }
  async clearFiles(): Promise<void> {
    const owner = this.root ?? this
    const job = owner.queue.then(async () => {
      const results = await Promise.allSettled((await owner.io.readdir(owner.dir).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
      })).filter((name) => /^mediaos\.log(?:\.\d+)?$|^diagnostics-.*\.txt$/.test(name))
        .map((name) => owner.io.rm(join(owner.dir, name), { force: true })))
      if (results.some((r) => r.status === 'rejected')) throw new Error('Some log files could not be removed')
    })
    owner.queue = job.catch(() => undefined)
    await job
  }
}

function format(value: unknown, depth = 0): string {
  if (value instanceof Error) {
    // Capped, because an error can name itself (or an earlier error) as its cause.
    const cause = !value.cause ? '' : depth < 8 ? format(value.cause, depth + 1) : '[further causes not shown]'
    return `${value.stack ?? value.message}${cause ? ` Cause: ${cause}` : ''}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, (key: string, leaf: unknown) => {
      if (isSecretKey(key)) return '[REDACTED]'
      return typeof leaf === 'string' ? redact(leaf) : leaf
    }) ?? String(value)
  } catch { return '[unprintable value]' }
}
