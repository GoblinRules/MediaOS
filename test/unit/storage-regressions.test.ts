import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { atomicWrite } from '../../src/main/settings/atomic'
import { Logger, silentLog } from '../../src/main/log/Logger'
import { temporary, deferred, until } from './helpers'

afterEach(() => vi.useRealTimers())
describe('storage recovery and reset', () => {
  const damagedSecrets = ['{"token":"credential-fragment"', '{"good":{"token":"secret"},"bad":{"token":5}}', '[]']
  it.each(damagedSecrets)('recovers damaged secrets without forwarding any file contents: %s', async (text) => {
      const temp = await temporary(), warn = vi.fn()
      try {
        const file = join(temp.dir, 'secrets.json')
        await fs.writeFile(file, text, 'utf8'); await fs.writeFile(`${file}.bad`, 'older', 'utf8')
        const store = await SecretStore.open(file, fs, { ...silentLog, warn })
        expect(store.get('good')).toBeUndefined()
        expect(store.recoveredFrom).toBe("Saved sign-ins were damaged, so you'll need to sign in to your servers again.")
        expect(warn.mock.calls).toEqual([['secrets file damaged; starting empty']])
        await expect(fs.stat(file)).rejects.toHaveProperty('code', 'ENOENT')
        await expect(fs.stat(`${file}.bad`)).rejects.toHaveProperty('code', 'ENOENT')
        await store.set('new', { token: 'new secret' })
        expect((await SecretStore.open(file)).get('new')).toEqual({ token: 'new secret' })
      } finally { await temp.dispose() }
    })
  it('rethrows read permission failures without treating them as damaged content', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' }), rename = vi.fn(fs.rename)
    const io = { ...fs, readFile: async () => { throw error }, rename }
    await expect(SecretStore.open('unused', io)).rejects.toBe(error)
    await expect(SettingsStore.open('unused', { fs: io })).rejects.toBe(error)
    expect(rename).not.toHaveBeenCalled()
  })
  it('erases secrets after failed writes and blocks new saves throughout the erase', async () => {
    const temp = await temporary(), removed = deferred<void>()
    try {
      const file = join(temp.dir, 'secrets.json')
      await fs.writeFile(file, '{"old":{"token":"private"}}', 'utf8')
      const rename = vi.fn(fs.rename).mockRejectedValueOnce(new Error('disk full'))
      const events: string[] = [], open = vi.fn(fs.open)
      const rm = vi.fn(async (...args: Parameters<typeof fs.rm>) => {
        if (args[0] === file) await removed.promise
        await fs.rm(...args)
        if (args[0] === file) events.push('rm-end')
      })
      const store = await SecretStore.open(file, { ...fs, open, rename, rm })
      await expect(store.set('old', { token: 'changed' })).rejects.toThrow('disk full')
      open.mockClear()
      const erased = store.erase()
      await until(() => rm.mock.calls.length > 0)
      const saved = store.set('new', { token: 'after erase' })
      const erasedAgain = store.erase()
      await until(() => open.mock.calls.length > 0 || rm.mock.calls.filter(([path]) => path === file).length > 1)
        .catch(() => undefined)
      expect(open).not.toHaveBeenCalled()
      expect(rm.mock.calls.filter(([path]) => path === file)).toHaveLength(1)
      expect(events).toEqual([])
      removed.resolve(); await erased; await erasedAgain; await saved
      expect(events).toEqual(['rm-end', 'rm-end']); expect(open).not.toHaveBeenCalled()
      expect(store.get('new')).toBeUndefined()
      await store.erase(); await expect(fs.stat(file)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { await temp.dispose() }
  })
  it('drops debounced settings on erase and removes files despite an earlier failed flush', async () => {
    vi.useFakeTimers()
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json'), rename = vi.fn(fs.rename).mockRejectedValue(new Error('disk full'))
      const store = await SettingsStore.open(file, { fs: { ...fs, rename } })
      store.update({ deviceName: 'failed' }); await expect(store.flush()).rejects.toThrow('disk full')
      await fs.writeFile(file, '{}', 'utf8'); await fs.writeFile(`${file}.bad`, 'old', 'utf8')
      store.update({ deviceName: 'pending' }); await store.erase()
      await vi.advanceTimersByTimeAsync(1000)
      expect(rename).toHaveBeenCalledTimes(1); expect(await fs.readdir(temp.dir)).toEqual([])
      expect(store.get().deviceName).toBe('MediaOS')
    } finally { await temp.dispose() }
  })
  it('writes settings from the debounce timer without any explicit flush', async () => {
    vi.useFakeTimers()
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json'), rename = vi.fn(fs.rename)
      const store = await SettingsStore.open(file, { fs: { ...fs, rename } })
      store.update({ deviceName: 'Timer saved' })
      await vi.advanceTimersByTimeAsync(299); expect(rename).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
      expect(JSON.parse(await fs.readFile(file, 'utf8')).deviceName).toBe('Timer saved')
    } finally { await temp.dispose() }
  })
  it('logs failed debounced settings writes with fixed text and retains lastWriteError', async () => {
    vi.useFakeTimers()
    const temp = await temporary(), error = vi.fn()
    try {
      const failure = new Error('private settings content')
      const store = await SettingsStore.open(join(temp.dir, 'settings.json'), {
        fs: { ...fs, rename: async () => { throw failure } }, logger: { ...silentLog, error },
      })
      store.update({ deviceName: 'TV' }); await vi.advanceTimersByTimeAsync(300)
      await vi.waitFor(() => expect(store.lastWriteError).toBe(failure))
      expect(error.mock.calls).toEqual([['Settings could not be saved']])
      await store.erase()
    } finally { await temp.dispose() }
  })
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries only rename for %s and caps attempts at five', async (code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'atomic'), busy = Object.assign(new Error('busy'), { code })
      const open = vi.fn(fs.open), rename = vi.fn(fs.rename).mockRejectedValueOnce(busy).mockRejectedValueOnce(busy)
      const saved = atomicWrite(file, 'saved', undefined, { ...fs, open, rename })
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(3)); await saved
      expect(open).toHaveBeenCalledTimes(1); expect(rename).toHaveBeenCalledTimes(3)
      expect(await fs.readFile(file, 'utf8')).toBe('saved')
      rename.mockClear().mockRejectedValue(busy)
      const rejected = expect(atomicWrite(file, 'lost', undefined, { ...fs, rename })).rejects.toBe(busy)
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(5)); await rejected
      expect(rename).toHaveBeenCalledTimes(5)
      expect(await fs.readFile(file, 'utf8')).toBe('saved')
      await expect(fs.stat(`${file}.tmp`)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { await temp.dispose() }
  })
  it('clears only owned log files on the shared queue and keeps logging afterwards', async () => {
    const temp = await temporary()
    try {
      const logger = new Logger(temp.dir), child = logger.child('test')
      await fs.writeFile(join(temp.dir, 'settings.json'), '{}', 'utf8')
      await fs.writeFile(join(temp.dir, 'diagnostics-1.txt'), 'old diagnostics', 'utf8')
      await fs.writeFile(join(temp.dir, 'mediaos.log.3'), 'old rotation', 'utf8')
      child.info('before reset')
      await child.clearFiles()
      expect(await fs.readdir(temp.dir)).toEqual(['settings.json'])
      child.info('after reset'); await logger.close()
      const text = await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')
      expect(text).toContain('after reset'); expect(text).not.toContain('before reset')
    } finally { await temp.dispose() }
  })
})
