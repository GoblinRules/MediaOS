import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FileSystem } from '../settings/atomic'
import { silentLog, type Log } from '../log/Logger'

export interface CachedImage { mime: string; body: Uint8Array }
interface Entry { bytes: number; used: number }
export interface DiskCacheOptions { maxBytes?: number; fs?: FileSystem; now?: () => number; logger?: Log }

export class DiskCache {
  private index = new Map<string, Entry>()
  private ready: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private io: FileSystem
  private now: () => number
  private generation = 0
  private clearing = 0
  get revision(): number { return this.generation }

  constructor(readonly dir: string, private opts: DiskCacheOptions = {}) {
    this.io = opts.fs ?? fs
    this.now = opts.now ?? Date.now
    this.ready = this.rebuild().catch(() => undefined)
  }
  static key(parts: readonly unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex') }
  private valid(key: string): boolean { return /^[a-f0-9]{64}$/.test(key) }
  private async rebuild(): Promise<void> {
    await this.io.mkdir(this.dir, { recursive: true })
    const files = await this.io.readdir(this.dir)
    await Promise.all(files.filter((f) => /^[a-f0-9]{64}\.img\.tmp$/.test(f)).map((file) =>
      this.io.rm(join(this.dir, file), { force: true })))
    await Promise.all(files.filter((f) => /^[a-f0-9]{64}\.img$/.test(f)).map(async (file) => {
      const stat = await this.io.stat(join(this.dir, file))
      this.index.set(file.slice(0, -4), { bytes: stat.size, used: stat.mtimeMs })
    }))
    await this.evict()
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(() => this.ready).then(fn)
    this.queue = job.then(() => undefined, () => undefined)
    return job
  }
  async get(key: string): Promise<CachedImage | undefined> {
    if (!this.valid(key)) return undefined
    return this.serial(async () => {
      try {
        if (!this.index.has(key)) return undefined
        const file = join(this.dir, `${key}.img`)
        const data = await this.io.readFile(file)
        const end = data.indexOf(10)
        if (end < 1 || end > 200) throw new Error('Invalid cached image')
        const mime = data.subarray(0, end).toString('utf8')
        if (!/^image\/(jpeg|png|webp|gif|avif)$/i.test(mime)) throw new Error('Invalid cached image')
        const used = this.now()
        this.index.set(key, { bytes: data.length, used })
        await this.io.utimes(file, used / 1000, used / 1000).catch(() => undefined)
        return { mime, body: data.subarray(end + 1) }
      } catch { this.index.delete(key); return undefined }
    }).catch(() => undefined)
  }
  async put(key: string, value: CachedImage, generation = this.generation): Promise<void> {
    if (this.clearing || !this.valid(key) || !/^image\/(jpeg|png|webp|gif|avif)$/i.test(value.mime)) return
    await this.serial(async () => {
      if (this.clearing || generation !== this.generation) return
      const data = Buffer.concat([Buffer.from(`${value.mime}\n`, 'utf8'), value.body])
      if (data.length > (this.opts.maxBytes ?? 500 * 1024 * 1024)) return
      await this.io.mkdir(this.dir, { recursive: true })
      const file = join(this.dir, `${key}.img`)
      await this.io.writeFile(`${file}.tmp`, data)
      await this.io.rename(`${file}.tmp`, file)
      const used = this.now()
      await this.io.utimes(file, used / 1000, used / 1000).catch(() => undefined)
      this.index.set(key, { bytes: data.length, used })
      await this.evict()
    }).catch(() => undefined)
  }
  private async evict(): Promise<void> {
    let total = [...this.index.values()].reduce((n, e) => n + e.bytes, 0)
    for (const [key, entry] of [...this.index].sort((a, b) => a[1].used - b[1].used)) {
      if (total <= (this.opts.maxBytes ?? 500 * 1024 * 1024)) break
      await this.io.rm(join(this.dir, `${key}.img`), { force: true })
      this.index.delete(key)
      total -= entry.bytes
    }
  }
  async clear(): Promise<void> {
    this.generation++
    this.clearing++
    try {
      await this.serial(async () => {
        try {
          const files = await this.io.readdir(this.dir)
          for (const file of files) if (/^[a-f0-9]{64}\.img(?:\.tmp)?$/.test(file)) {
            await this.io.rm(join(this.dir, file), { force: true }).catch(() => {
              ;(this.opts.logger ?? silentLog).warn('A cached image could not be removed')
            })
          }
        } finally { this.index.clear() }
      })
    } catch { (this.opts.logger ?? silentLog).warn('The image cache could not be cleared') }
    finally { this.generation++; this.clearing-- }
  }
}
