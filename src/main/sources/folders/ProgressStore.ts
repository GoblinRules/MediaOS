import * as fs from 'node:fs/promises'
import { z } from 'zod'
import { atomicWrite } from '../../settings/atomic'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'

const entrySchema = z.object({
  title: z.string(), subtitle: z.string().optional(), type: z.enum(['folder', 'video']),
  durationSec: z.number().finite().positive().optional(), positionSec: z.number().finite().nonnegative().optional(),
  watched: z.boolean().optional(), favourite: z.boolean().optional(), lastPlayedAt: z.string().datetime().optional(),
})
export type ProgressEntry = z.infer<typeof entrySchema>
const schema = z.record(z.string().min(1), entrySchema)

export class ProgressStore {
  private data = new Map<string, ProgressEntry>()
  private timer?: ReturnType<typeof setTimeout>
  private queue: Promise<void> = Promise.resolve()
  private dirty = false
  private clock: Runtime
  private logger: Log
  constructor(private file: string, opts: { clock?: Runtime; logger?: Log } = {}) {
    this.clock = opts.clock ?? runtime; this.logger = opts.logger ?? silentLog
  }
  static async open(file: string, opts: { clock?: Runtime; logger?: Log } = {}): Promise<ProgressStore> {
    const store = new ProgressStore(file, opts)
    try { store.data = new Map(Object.entries(schema.parse(JSON.parse(await fs.readFile(file, 'utf8'))))); store.cap() }
    catch { store.logger.warn('Folder progress could not be read; starting empty') }
    return store
  }
  get(id: string): ProgressEntry | undefined { const v = this.data.get(id); return v ? { ...v } : undefined }
  entries(): Array<[string, ProgressEntry]> { return [...this.data].map(([id, entry]) => [id, { ...entry }]) }
  set(id: string, entry: ProgressEntry): void {
    this.data.set(id, entrySchema.parse(entry)); this.cap(); this.dirty = true
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => this.logger.warn('Folder progress could not be saved'))
    }, 2000)
  }
  private cap(): void {
    if (this.data.size <= 3000) return
    const oldest = [...this.data].sort((a, b) => Number(!!a[1].favourite) - Number(!!b[1].favourite) ||
      (a[1].lastPlayedAt ?? '').localeCompare(b[1].lastPlayedAt ?? ''))
    for (const [id] of oldest.slice(0, this.data.size - 3000)) this.data.delete(id)
  }
  async flush(): Promise<void> {
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined }
    if (!this.dirty) return this.queue
    const text = JSON.stringify(Object.fromEntries(this.data)) + '\n'
    this.dirty = false
    const job = this.queue.then(() => atomicWrite(this.file, text, 0o600))
    this.queue = job.catch(() => { this.dirty = true })
    return job
  }
}
