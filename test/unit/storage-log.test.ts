import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { atomicWrite } from '../../src/main/settings/atomic'
import { Logger } from '../../src/main/log/Logger'
import { redact, redactUrl } from '../../src/main/log/redact'
import { temporary } from './helpers'

afterEach(() => vi.useRealTimers())

describe('settings', () => {
  it('starts with defaults without writing, migrates old data, and returns isolated copies', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json')
      const store = await SettingsStore.open(file)
      await store.flush()
      await expect(fs.stat(file)).rejects.toHaveProperty('code', 'ENOENT')
      const copy = store.get(); copy.home.rows.length = 0
      expect(store.get().home.rows.length).toBeGreaterThan(0)
      await fs.writeFile(file, JSON.stringify({ deviceName: 'My TV' }), 'utf8')
      const loaded = await SettingsStore.open(file)
      expect(loaded.get()).toMatchObject({ version: 1, deviceName: 'My TV' })
    } finally { await temp.dispose() }
  })
  it.each(['{broken', '{"version":999}', '[]'])('recovers damaged settings %s and replaces only the newest backup', async (raw) => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json')
      await fs.writeFile(file, raw, 'utf8'); await fs.writeFile(`${file}.bad`, 'old', 'utf8')
      const store = await SettingsStore.open(file)
      expect(store.recoveredFrom).toContain('damaged')
      expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe(raw)
      expect(store.get().deviceName).toBe('MediaOS')
    } finally { await temp.dispose() }
  })
  it('merges one level, replaces arrays, validates before mutation and unsubscribes', async () => {
    const temp = await temporary()
    try {
      const store = await SettingsStore.open(join(temp.dir, 'settings.json'))
      const cb = vi.fn(); const unsub = store.onChange(cb)
      // Direct callers can provide a nested partial; the shared SettingsPatch type currently requires complete objects.
      const patch = { home: { hero: false }, keymap: { Enter: 'select' } } as unknown as Parameters<typeof store.update>[0]
      store.update(patch)
      expect(store.get().home).toMatchObject({ hero: false, mergeContinue: true })
      store.update({ keymap: { Escape: 'back' } })
      expect(store.get().keymap).toEqual({ Enter: 'select', Escape: 'back' })
      store.update({ sources: [{ id: 'a', kind: 'fixture', name: 'A', enabled: true }] })
      store.update({ sources: [] }); expect(store.get().sources).toEqual([])
      const old = store.get()
      expect(() => store.update({ deviceName: '' })).toThrow()
      expect(store.get()).toEqual(old)
      expect(cb).toHaveBeenCalledTimes(4)
      expect(cb.mock.lastCall?.[0].sources).toEqual([])
      store.update({ sources: [] }); expect(cb).toHaveBeenCalledTimes(4)
      unsub(); const calls = cb.mock.calls.length
      store.update({ deviceName: 'New' }); expect(cb).toHaveBeenCalledTimes(calls)
      await store.flush()
    } finally { await temp.dispose() }
  })
  it('debounces writes, fsyncs before rename, and waits for in-flight changes on flush', async () => {
    vi.useFakeTimers()
    const temp = await temporary()
    const file = join(temp.dir, 'settings.json')
    const order: string[] = []
    const realOpen = fs.open
    const io = { ...fs, open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      order.push('open'); const handle = await realOpen(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { order.push('sync'); await sync() }
      return handle
    }), rename: vi.fn(async (...args: Parameters<typeof fs.rename>) => { order.push('rename'); await fs.rename(...args) }) }
    try {
      const store = await SettingsStore.open(file, { fs: io })
      store.update({ deviceName: 'A' }); await vi.advanceTimersByTimeAsync(200)
      store.update({ deviceName: 'B' }); await vi.advanceTimersByTimeAsync(299)
      expect(io.open).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      store.update({ deviceName: 'C' })
      await store.flush()
      expect(JSON.parse(await fs.readFile(file, 'utf8')).deviceName).toBe('C')
      expect(order.slice(-3)).toEqual(['open', 'sync', 'rename'])
      const count = io.open.mock.calls.length
      store.update({ deviceName: 'C' }); await store.flush()
      expect(io.open).toHaveBeenCalledTimes(count)
      expect(await fs.readdir(temp.dir)).toEqual(['settings.json'])
    } finally { await temp.dispose() }
  })
  it('keeps the previous file if an atomic rename fails and retries a failed flush', async () => {
    const temp = await temporary()
    try {
      const file = join(temp.dir, 'settings.json')
      await atomicWrite(file, 'old')
      await expect(atomicWrite(file, 'new', undefined, { ...fs, rename: async () => { throw new Error('disk full') } })).rejects.toThrow()
      expect(await fs.readFile(file, 'utf8')).toBe('old')
      const rename = vi.fn(fs.rename).mockRejectedValueOnce(new Error('busy'))
      await fs.rm(file)
      const store = await SettingsStore.open(file, { fs: { ...fs, rename } })
      store.update({ deviceName: 'Saved' })
      await expect(store.flush()).rejects.toThrow('busy')
      await store.flush()
      expect(JSON.parse(await fs.readFile(file, 'utf8')).deviceName).toBe('Saved')
    } finally { await temp.dispose() }
  })
})

it('persists isolated secrets, deletes and clears, using mode 0600', async () => {
  const temp = await temporary()
  try {
    const file = join(temp.dir, 'secrets.json')
    const open = vi.fn(fs.open)
    const store = await SecretStore.open(file, { ...fs, open })
    await store.set('demo', { token: 'secret', device: 'tv' })
    store.get('demo')!.token = 'changed'
    expect((await SecretStore.open(file)).get('demo')?.token).toBe('secret')
    expect(open.mock.calls[0]?.[2]).toBe(0o600)
    await store.set('__proto__', { token: 'safe map' })
    expect(store.get('__proto__')?.token).toBe('safe map')
    await store.delete('demo'); expect(store.get('demo')).toBeUndefined()
    await store.clear(); expect(await fs.readFile(file, 'utf8')).toBe('{}\n')
    await store.erase(); await expect(fs.stat(file)).rejects.toThrow()
  } finally { await temp.dispose() }
})

describe('redaction', () => {
  const keys = ['X-Emby-Token', 'X-Plex-Token', 'X-MediaBrowser-Token', 'api_key', 'ApiKey', 'apiKey', 'api-key', 'token', 'access_token',
    'Authorization', 'password', 'passwd', 'psk', 'pw', 'AccessToken', 'accessToken', 'authToken', 'authentication_token',
    'Secret', 'TokenType', 'prefixPASSWORDsuffix', 'device_psk_value']
  it.each(keys)('masks %s in queries, headers and JSON', (key) => {
    for (const text of [`https://tv.test/?${key}=private-value&ok=yes`, `${key}: private-value`,
      `{"${key}": "private-value"}`, `${key}=private-value`]) {
      expect(redact(text)).not.toContain('private-value'); expect(redact(text)).toContain('[REDACTED]')
    }
  })
  it('masks MediaBrowser tokens, escaped JSON strings and encoded URL keys', () => {
    expect(redact('Authorization: MediaBrowser Client="TV", Token="private"')).not.toContain('private')
    expect(redact(JSON.stringify({ password: 'a"secret' }))).not.toContain('secret')
    const url = redactUrl('https://user:secret@server.test/img?X%2DPlex%2DToken=private&width=40')
    expect(url).not.toContain('private'); expect(url).not.toContain('secret'); expect(url).toContain('width=40')
  })
  it('masks secret names inside arbitrary JSON and encoded query keys', () => {
    for (const key of ['prefix.token.suffix', 'contains token here', 'api_key[device]', 'custom!secret']) {
      expect(redact(JSON.stringify({ [key]: 'private-value', width: '40' }))).not.toContain('private-value')
      const url = redactUrl(`https://test/image?${encodeURIComponent(key)}=private-value&width=40`)
      expect(url).not.toContain('private-value'); expect(url).toContain('width=40')
    }
    expect(redact('{"access\\u0054oken":"private-value"}')).not.toContain('private-value')
    expect(redact('{"authToken\\x":"private-value"}')).not.toContain('private-value')
  })
})

it('redacts secret fields and nested text in objects and error causes while preserving harmless values', async () => {
  const temp = await temporary()
  try {
    const logger = new Logger(temp.dir)
    logger.warn('Reply', { status: 200, body: '{"AccessToken":"x1","name":"Kitchen"}' })
    logger.warn('Reply', { body: 'authToken=x2' })
    logger.error(new Error('Reply failed', { cause: { status: 401, body: '{"Secret":"x3"}' } }))
    logger.info({ accessToken: 'x4', name: 'Kitchen' })
    logger.info({ accessToken: { value: 'x5' } })
    logger.error(new Error('Outer failure', { cause: new Error('Inner failure', { cause: { body: 'authToken=x6' } }) }))
    const circular: { self?: unknown } = {}; circular.self = circular
    logger.debug(circular)
    await logger.close()
    const text = await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')
    expect(text).not.toMatch(/x1|x2|x3|x4|x5|x6/)
    expect(text).toContain('Kitchen')
    expect(text).toContain('"name":"Kitchen"')
    expect(text).toContain('\\"name\\":\\"Kitchen\\"')
    expect(text).toContain('[unprintable value]')
  } finally { await temp.dispose() }
})

it('logs an error that names itself (or a loop of errors) as its cause without crashing', async () => {
  const temp = await temporary()
  try {
    const logger = new Logger(temp.dir)
    const self = new Error('Self failure'); self.cause = self
    const a = new Error('First failure'), b = new Error('Second failure', { cause: a }); a.cause = b
    expect(() => logger.error(self)).not.toThrow()
    expect(() => logger.error(a)).not.toThrow()
    await logger.close()
    const lines = (await fs.readFile(join(temp.dir, 'mediaos.log'), 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain('[further causes not shown]')
    expect(lines[1]).toContain('Second failure')
  } finally { await temp.dispose() }
})

it('redacts every log level and child, rotates three files and closes its queue', async () => {
  const temp = await temporary()
  try {
    const logger = new Logger(temp.dir, { maxBytes: 250, now: () => 0 })
    for (let i = 0; i < 12; i++) logger.child('test').info(`line ${i} token: secret`)
    logger.debug({ password: 'hidden' }); logger.warn('psk=hidden'); logger.error(new Error('api_key=hidden'))
    await logger.close()
    const names = await fs.readdir(temp.dir)
    expect(names.sort()).toEqual(['mediaos.log', 'mediaos.log.1', 'mediaos.log.2', 'mediaos.log.3'])
    for (const file of names) {
      const text = await fs.readFile(join(temp.dir, file), 'utf8')
      expect(text).not.toMatch(/secret|hidden/); expect(text).toContain('[REDACTED]')
    }
  } finally { await temp.dispose() }
})
