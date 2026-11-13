import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { silentLog } from '../../src/main/log/Logger'
import { deferred, temporary, until } from './helpers'

describe('damaged-file recovery and permanent erasure', () => {
  it.each([false, true])('starts with defaults if damaged settings cannot be set aside (old bad locked: %s)', async (oldBad) => {
    const temp = await temporary(), warn = vi.fn()
    const busy = Object.assign(new Error('private path and credential'), { code: 'EPERM' })
    try {
      const file = join(temp.dir, 'settings.json')
      await fs.writeFile(file, '{damaged', 'utf8')
      const rename = vi.fn(fs.rename).mockRejectedValue(busy)
      const rm = vi.fn(fs.rm)
      if (oldBad) rm.mockRejectedValue(busy)
      const store = await SettingsStore.open(file, { fs: { ...fs, rename, rm }, logger: { ...silentLog, warn } })
      expect(store.get().deviceName).toBe('MediaOS')
      expect(store.recoveredFrom).toContain('damaged')
      expect(rename).toHaveBeenCalledTimes(oldBad ? 0 : 5)
      expect(warn.mock.calls).toEqual([['settings file damaged; could not set aside']])
      rename.mockImplementation(fs.rename)
      store.update({ deviceName: 'Recovered' }); await store.flush()
      expect((await SettingsStore.open(file)).get().deviceName).toBe('Recovered')
    } finally { await temp.dispose() }
  })
  it('retries the settings recovery rename twice before successfully setting aside', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json'), busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
      await fs.writeFile(file, '{damaged', 'utf8')
      const rename = vi.fn(fs.rename).mockRejectedValueOnce(busy).mockRejectedValueOnce(busy)
      const store = await SettingsStore.open(file, { fs: { ...fs, rename } })
      expect(rename).toHaveBeenCalledTimes(3); expect(store.recoveredFrom).toContain('damaged')
      expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe('{damaged')
    } finally { await temp.dispose() }
  })
  it.each(['secrets.json', 'secrets.json.bad'])('starts with empty secrets if deleting %s fails', async (locked) => {
    const temp = await temporary(), warn = vi.fn()
    try {
      const file = join(temp.dir, 'secrets.json')
      await fs.writeFile(file, '{private-fragment', 'utf8')
      await fs.writeFile(`${file}.bad`, 'old-private-fragment', 'utf8')
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => {
        if (args[0] === join(temp.dir, locked)) throw new Error('private-fragment')
        await fs.rm(...args)
      })
      const store = await SecretStore.open(file, { ...fs, rm }, { ...silentLog, warn })
      expect(store.get('demo')).toBeUndefined(); expect(store.recoveredFrom).toContain('damaged')
      expect(warn.mock.calls).toEqual([
        ['secrets file damaged; starting empty'], ['Damaged sign-ins could not be deleted'],
      ])
      expect(rm).toHaveBeenCalledTimes(2)
      await store.set('demo', { token: 'replacement' })
      expect((await SecretStore.open(file)).get('demo')).toEqual({ token: 'replacement' })
    } finally { await temp.dispose() }
  })
  it('keeps settings erased after updates, debounce time and the disposal flush', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json'), open = vi.fn(fs.open)
      const store = await SettingsStore.open(file, { fs: { ...fs, open }, debounceMs: 1 })
      store.update({ deviceName: 'Before reset' }); await store.flush()
      await store.erase(); open.mockClear()
      expect(() => store.update({ deviceName: 'After reset', setupDone: true }))
        .toThrow('MediaOS is restarting after the reset. Try again in a moment.')
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      await store.flush()
      expect(store.get().deviceName).toBe('MediaOS'); expect(store.get().setupDone).toBe(false)
      expect(open).not.toHaveBeenCalled()
      await expect(fs.stat(file)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { await temp.dispose() }
  })
  it('waits for an in-progress settings rename before erasing every settings file', async () => {
    const temp = await temporary(), release = deferred<void>()
    let saved: Promise<void> | undefined, erased: Promise<void> | undefined
    try {
      const file = join(temp.dir, 'settings.json'), rm = vi.fn(fs.rm)
      const rename = vi.fn(async (...args: Parameters<typeof fs.rename>) => { await release.promise; await fs.rename(...args) })
      const store = await SettingsStore.open(file, { fs: { ...fs, rename, rm } })
      store.update({ deviceName: 'Saving during reset' }); saved = store.flush()
      await until(() => rename.mock.calls.length === 1)
      erased = store.erase()
      // Give an incorrectly detached erase job time to start, while rename still owns the temporary file.
      for (let n = 0; n < 10; n++) await Promise.resolve()
      expect(rm).not.toHaveBeenCalled()
      release.resolve(); await Promise.all([saved, erased])
      expect(await fs.readdir(temp.dir)).toEqual([])
    } finally {
      release.resolve(); await Promise.allSettled([saved, erased]); await temp.dispose()
    }
  })
  it('makes flush wait for a running erase to finish', async () => {
    const temp = await temporary(), gate = deferred<void>()
    let erased: Promise<void> | undefined
    try {
      const file = join(temp.dir, 'settings.json')
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => { await gate.promise; await fs.rm(...args) })
      const store = await SettingsStore.open(file, { fs: { ...fs, rm } })
      store.update({ deviceName: 'Before reset' }); await store.flush()
      erased = store.erase()
      let done = false
      const flushed = store.flush().then(() => { done = true })
      await until(() => rm.mock.calls.length > 0)
      for (let n = 0; n < 10; n++) await Promise.resolve()
      expect(done).toBe(false)
      // The erase hasn't failed (it is still running), so an update now must not say it failed.
      expect(() => store.update({ deviceName: 'During reset' }))
        .toThrow('MediaOS is restarting after the reset. Try again in a moment.')
      gate.resolve(); await Promise.all([erased, flushed])
      expect(done).toBe(true)
      expect(await fs.readdir(temp.dir)).toEqual([])
    } finally { gate.resolve(); await Promise.allSettled([erased]); await temp.dispose() }
  })
  it('allows flush after a failed erase but rejects later updates without writing', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json'), open = vi.fn(fs.open)
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => {
        if (args[0] === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await fs.rm(...args)
      })
      const store = await SettingsStore.open(file, { fs: { ...fs, open, rm } })
      store.update({ deviceName: 'Before reset' }); await store.flush(); open.mockClear()
      await expect(store.erase()).rejects.toHaveProperty('code', 'EBUSY')
      // The settings are still on disk, so the screen must keep showing them (not send the user to Setup).
      expect(store.get().deviceName).toBe('Before reset')
      await expect(store.flush()).resolves.toBeUndefined()
      expect(() => store.update({ setupDone: true }))
        .toThrow("MediaOS couldn't finish erasing everything. Restart the box and try again.")
      await store.flush()
      expect(open).not.toHaveBeenCalled()
      expect(JSON.parse(await fs.readFile(file, 'utf8')).deviceName).toBe('Before reset')
      expect(await fs.readdir(temp.dir)).toEqual(['settings.json'])
    } finally { await temp.dispose() }
  })
  it('erases every secrets artefact and ignores all later mutations', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'secrets.json'), open = vi.fn(fs.open)
      const store = await SecretStore.open(file, { ...fs, open })
      await store.set('old', { token: 'private' })
      await fs.writeFile(`${file}.bad`, 'old private data', 'utf8')
      await fs.writeFile(`${file}.tmp`, 'unfinished private data', 'utf8')
      await store.erase(); open.mockClear()
      expect(await fs.readdir(temp.dir)).toEqual([])
      await store.set('new', { token: 'late' }); await store.delete('old'); await store.clear()
      expect(store.get('new')).toBeUndefined(); expect(open).not.toHaveBeenCalled()
      expect(await fs.readdir(temp.dir)).toEqual([])
    } finally { await temp.dispose() }
  })
})
