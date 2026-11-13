import * as fs from 'node:fs/promises'
import { atomicWrite, missing, type FileSystem } from './atomic'
import { silentLog, type Log } from '../log/Logger'

export class SecretStore {
  recoveredFrom?: string
  private values: Record<string, Record<string, string>> = Object.create(null)
  private writing: Promise<void> = Promise.resolve()
  private erased = false

  private constructor(readonly file: string, private io: FileSystem) {}

  static async open(file: string, io: FileSystem = fs, logger: Log = silentLog): Promise<SecretStore> {
    const store = new SecretStore(file, io)
    let text: string
    try { text = await io.readFile(file, 'utf8') } catch (error) {
      if (missing(error)) return store
      throw error
    }
    try {
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid secrets file')
      for (const [id, values] of Object.entries(raw)) {
        if (!values || typeof values !== 'object' || Array.isArray(values) ||
          Object.values(values).some((v) => typeof v !== 'string')) throw new Error('Invalid secrets file')
        store.values[id] = values as Record<string, string>
      }
    } catch {
      // Parse errors may include credentials from the input. Never forward the error or file text.
      logger.warn('secrets file damaged; starting empty')
      const results = await Promise.allSettled([`${file}.bad`, file].map((path) => io.rm(path, { force: true })))
      if (results.some((result) => result.status === 'rejected')) logger.warn('Damaged sign-ins could not be deleted')
      store.values = Object.create(null)
      store.recoveredFrom = "Saved sign-ins were damaged, so you'll need to sign in to your servers again."
    }
    return store
  }

  get(id: string): Record<string, string> | undefined {
    return Object.hasOwn(this.values, id) ? structuredClone(this.values[id]) : undefined
  }

  set(id: string, values: Record<string, string>): Promise<void> {
    if (this.erased) return Promise.resolve()
    this.values[id] = structuredClone(values)
    return this.save()
  }

  delete(id: string): Promise<void> {
    if (this.erased) return Promise.resolve()
    delete this.values[id]; return this.save()
  }
  clear(): Promise<void> {
    if (this.erased) return Promise.resolve()
    this.values = Object.create(null); return this.save()
  }

  private save(): Promise<void> {
    if (this.erased) return Promise.resolve()
    const text = `${JSON.stringify(this.values, null, 2)}\n`
    this.writing = this.writing.catch(() => undefined).then(() => atomicWrite(this.file, text, 0o600, this.io))
    return this.writing
  }

  async erase(): Promise<void> {
    this.erased = true
    this.values = Object.create(null)
    const job = this.writing.catch(() => undefined).then(async () => {
      const results = await Promise.allSettled([this.file, `${this.file}.bad`, `${this.file}.tmp`]
        .map((p) => this.io.rm(p, { force: true })))
      const failed = results.find((r) => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    this.writing = job
    await job
  }
}
