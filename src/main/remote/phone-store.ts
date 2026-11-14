import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PhoneInfo } from '../../shared/remote-types'
import { silentLog, type Log } from '../log/Logger'
import type { SecretStore } from '../settings/SecretStore'

interface SavedPhone extends PhoneInfo { hash: string }
const NAMES = ['iPhone', 'iPad', 'Android phone', 'Android tablet', 'Phone']
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
const info = ({ id, name, pairedAt, lastUsed }: SavedPhone): PhoneInfo => ({ id, name, pairedAt, lastUsed })

export function phoneName(agent: string | undefined): string {
  if (agent?.includes('iPhone')) return 'iPhone'
  if (agent?.includes('iPad')) return 'iPad'
  if (agent?.includes('Android')) return agent.includes('Mobile') ? 'Android phone' : 'Android tablet'
  return 'Phone'
}

export class PhoneStore {
  private phones = new Map<string, SavedPhone>()
  private written = new Map<string, number>()
  private tail: Promise<unknown> = Promise.resolve()
  private now: () => number
  private logger: Log
  constructor(private secrets: Pick<SecretStore, 'get' | 'set'>, opts: { now?: () => number; logger?: Log } = {}) {
    this.now = opts.now ?? Date.now; this.logger = opts.logger ?? silentLog
    for (const [id, value] of Object.entries(secrets.get('remote-phones') ?? {})) {
      try {
        const p: unknown = JSON.parse(value)
        if (!p || typeof p !== 'object' || !('hash' in p) || typeof p.hash !== 'string' || !/^[a-f0-9]{64}$/.test(p.hash) ||
          !('name' in p) || typeof p.name !== 'string' || !NAMES.includes(p.name) ||
          !('pairedAt' in p) || typeof p.pairedAt !== 'string' || !validTime(p.pairedAt) ||
          !('lastUsed' in p) || typeof p.lastUsed !== 'string' || !validTime(p.lastUsed)) continue
        this.phones.set(id, { id, hash: p.hash, name: p.name, pairedAt: p.pairedAt, lastUsed: p.lastUsed })
        this.written.set(id, Date.parse(p.lastUsed))
      } catch { /* Damaged entries are omitted from the next save. */ }
    }
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const job = this.tail.then(work)
    this.tail = job.catch(() => undefined)
    return job
  }
  private async save(phones = this.phones): Promise<void> {
    const values: Record<string, string> = Object.create(null)
    for (const p of phones.values()) {
      values[p.id] = JSON.stringify({ hash: p.hash, name: p.name, pairedAt: p.pairedAt, lastUsed: p.lastUsed })
    }
    try { await this.secrets.set('remote-phones', values) }
    catch {
      this.logger.warn('Paired phones could not be saved')
      throw new Error("Couldn't save the paired phones. Try again.")
    }
  }
  /**
   * Add a phone in one write, removing `previousId` (a re-pair) and the least recently used phone when full. `undo`
   * puts back exactly what this write displaced and removes the new phone, for a pairing that lost a race.
   */
  add(name: string, previousId?: string): Promise<{ id: string; token: string; replaced?: string; undo(): Promise<void> }> {
    return this.queue(async () => {
      const next = new Map(this.phones)
      const displaced: SavedPhone[] = []
      const previous = previousId === undefined ? undefined : next.get(previousId)
      if (previous) { next.delete(previous.id); displaced.push(previous) }
      let replaced: string | undefined
      if (next.size >= 8) {
        const oldest = [...next.values()].sort((a, b) => a.lastUsed.localeCompare(b.lastUsed) ||
          a.pairedAt.localeCompare(b.pairedAt))[0]!
        next.delete(oldest.id); displaced.push(oldest); replaced = oldest.name
      }
      const id = randomUUID(), token = randomBytes(32).toString('base64url'), time = new Date(this.now()).toISOString()
      next.set(id, { id, hash: hashToken(token), name: NAMES.includes(name) ? name : 'Phone', pairedAt: time, lastUsed: time })
      await this.save(next)
      this.phones = next; this.written.set(id, this.now())
      for (const key of this.written.keys()) if (!next.has(key)) this.written.delete(key)
      const undo = (): Promise<void> => this.queue(async () => {
        const back = new Map(this.phones)
        back.delete(id)
        for (const p of displaced) if (!back.has(p.id)) back.set(p.id, p)
        await this.save(back)
        this.phones = back; this.written.delete(id)
        for (const p of displaced) if (!this.written.has(p.id)) this.written.set(p.id, Date.parse(p.lastUsed))
      })
      return { id, token, ...(replaced ? { replaced } : {}), undo }
    })
  }
  has(id: string): boolean { return this.phones.has(id) }
  find(token: string): PhoneInfo | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const supplied = Buffer.from(hashToken(token), 'hex')
    let match: PhoneInfo | undefined
    for (const p of this.phones.values()) {
      if (timingSafeEqual(supplied, Buffer.from(p.hash, 'hex'))) match = info(p)
    }
    return match
  }
  touch(id: string): Promise<void> {
    const phone = this.phones.get(id), now = this.now()
    if (!phone) return Promise.resolve()
    phone.lastUsed = new Date(now).toISOString()
    if (now - (this.written.get(id) ?? -Infinity) < 3600000) return Promise.resolve()
    this.written.set(id, now)
    return this.queue(async () => {
      try { await this.save() }
      catch (error) { this.written.delete(id); throw error }
    })
  }
  remove(id: string): Promise<void> {
    return this.queue(async () => {
      const next = new Map(this.phones)
      next.delete(id)
      await this.save(next)
      this.phones = next; this.written.delete(id)
    })
  }
  list(): PhoneInfo[] { return [...this.phones.values()].sort((a, b) => b.pairedAt.localeCompare(a.pairedAt)).map(info) }
  count(): number { return this.phones.size }
}

function validTime(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
