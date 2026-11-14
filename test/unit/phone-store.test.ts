import { createHash, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PhoneStore, phoneName } from '../../src/main/remote/phone-store'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { silentLog } from '../../src/main/log/Logger'
import { temporary } from './helpers'

vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>()
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) }
})

function memory(values: Record<string, string> = {}) {
  return { get: vi.fn(() => structuredClone(values)), set: vi.fn(async (_id: string, next: Record<string, string>) => {
    values = structuredClone(next)
  }) }
}

describe('paired phone storage', () => {
  it('persists hashes only through SecretStore and reloads without exposing hashes', async () => {
    const temp = await temporary(), file = join(temp.dir, 'secrets.json')
    try {
      const secrets = await SecretStore.open(file), store = new PhoneStore(secrets)
      const { id, token } = await store.add('iPhone')
      const raw = await fs.readFile(file, 'utf8')
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(raw).not.toContain(token)
      const saved = JSON.parse(secrets.get('remote-phones')![id]!) as Record<string, string>
      expect(saved.hash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(Object.keys(saved).sort()).toEqual(['hash', 'lastUsed', 'name', 'pairedAt'])
      const loaded = new PhoneStore(await SecretStore.open(file))
      expect(loaded.find(token)).toEqual({ id, name: 'iPhone', pairedAt: saved.pairedAt, lastUsed: saved.lastUsed })
      expect(loaded.list()[0]).not.toHaveProperty('hash')
      expect(loaded.find(token.slice(1))).toBeUndefined()
      expect(loaded.find(`${token}x`)).toBeUndefined()
      expect(loaded.find('!'.repeat(43))).toBeUndefined()
      expect(loaded.find('a'.repeat(43))).toBeUndefined()
      await loaded.remove(id); expect(loaded.count()).toBe(0); expect(loaded.find(token)).toBeUndefined()
    } finally { await temp.dispose() }
  })
  it('keeps eight phones, evicts the least recently used and breaks ties by pairing date', async () => {
    let now = 0
    const store = new PhoneStore(memory(), { now: () => now })
    const phones = []
    for (let i = 0; i < 8; i++) { now = i * 1000; phones.push(await store.add(i === 1 ? 'iPad' : 'iPhone')) }
    now = 10000; await store.touch(phones[0]!.id)
    const next = await store.add('Phone')
    expect(next.replaced).toBe('iPad'); expect(store.count()).toBe(8)
    expect(store.find(phones[0]!.token)).toBeDefined(); expect(store.find(phones[1]!.token)).toBeUndefined()
    expect(store.list()[0]!.id).toBe(next.id)
    const io = memory(), tied = new PhoneStore(io, { now: () => now })
    const ids = []
    for (let i = 0; i < 8; i++) { now++; ids.push(await tied.add('Phone')) }
    now++; for (const p of ids) await tied.touch(p.id)
    await tied.add('Phone')
    expect(tied.find(ids[0]!.token)).toBeUndefined(); expect(tied.find(ids[1]!.token)).toBeDefined()
  })
  it('ignores damaged entries and drops them on the next successful save', async () => {
    const io = memory({ bad: '{', array: '[]', missing: '{}', hash: JSON.stringify({ hash: 'x' }) })
    const store = new PhoneStore(io)
    expect(store.count()).toBe(0)
    const added = await store.add('Phone')
    expect(Object.keys(io.get())).toEqual([added.id])
  })
  it('updates lastUsed immediately and saves touches at most hourly per phone', async () => {
    let now = 0
    const io = memory(), store = new PhoneStore(io, { now: () => now }), a = await store.add('Phone')
    now = 1000; const b = await store.add('iPad')
    io.set.mockClear()
    now = 3599999; await store.touch(a.id)
    expect(store.find(a.token)!.lastUsed).toBe(new Date(now).toISOString()); expect(io.set).not.toHaveBeenCalled()
    now = 3600000; await Promise.all([store.touch(a.id), store.touch(a.id)])
    expect(io.set).toHaveBeenCalledTimes(1)
    await store.touch(b.id); expect(io.set).toHaveBeenCalledTimes(1)
    now = 3601000; await store.touch(b.id); expect(io.set).toHaveBeenCalledTimes(2)
    now = 7200000; await store.touch(a.id); expect(io.set).toHaveBeenCalledTimes(3)
  })
  it('serialises simultaneous additions so the cap cannot be exceeded', async () => {
    const store = new PhoneStore(memory())
    const phones = await Promise.all(Array.from({ length: 12 }, () => store.add('Phone')))
    expect(store.count()).toBe(8)
    expect(phones.filter((p) => store.find(p.token))).toHaveLength(8)
  })
  it('compares every hash in constant time even after finding a match, and rejects bad lengths first', async () => {
    const store = new PhoneStore(memory()), phones = []
    for (let i = 0; i < 3; i++) phones.push(await store.add('Phone'))
    vi.mocked(timingSafeEqual).mockClear()
    expect(store.find(phones[0]!.token)?.id).toBe(phones[0]!.id)
    expect(timingSafeEqual).toHaveBeenCalledTimes(3)
    vi.mocked(timingSafeEqual).mockClear()
    expect(store.find(phones[0]!.token.slice(1))).toBeUndefined()
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })
  it('saves the first touch after loading a phone last used more than an hour ago', async () => {
    let now = 0
    const io = memory(), first = new PhoneStore(io, { now: () => now }), phone = await first.add('Phone')
    now = 3600001
    const reloaded = new PhoneStore(io, { now: () => now })
    io.set.mockClear(); await reloaded.touch(phone.id)
    expect(io.set).toHaveBeenCalledOnce()
  })
  it('reports save failures without logging credentials and keeps the last committed phone list', async () => {
    const io = memory(), warn = vi.fn(), store = new PhoneStore(io, { logger: { ...silentLog, warn } })
    const a = await store.add('Phone')
    io.set.mockRejectedValueOnce(new Error('sensitive storage details'))
    await expect(store.remove(a.id)).rejects.toThrow("Couldn't save the paired phones. Try again.")
    expect(store.find(a.token)).toBeDefined()
    io.set.mockRejectedValueOnce(new Error(a.token))
    await expect(store.add('iPad')).rejects.toThrow("Couldn't save the paired phones. Try again.")
    expect(store.count()).toBe(1)
    expect(warn.mock.calls).toEqual([['Paired phones could not be saved'], ['Paired phones could not be saved']])
  })
  it.each([
    ['Mozilla iPhone private detail', 'iPhone'], ['Mozilla iPad', 'iPad'], ['Android Mobile', 'Android phone'],
    ['Android browser', 'Android tablet'], ['Desktop browser', 'Phone'], [undefined, 'Phone'],
  ])('reduces the user agent to a coarse name (%s)', (agent, expected) => expect(phoneName(agent)).toBe(expected))
})
