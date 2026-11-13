import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLinuxFolders } from '../../src/main/system/linux/LinuxFolders'
import type { CommandRunner } from '../../src/main/system/linux/CommandRunner'
import { folderText } from '../../src/main/folders/texts'
import { CALLS } from '@shared/ipc-contract'

const id = 'smb-0123abcd', path = `/media/mediaos/${id}`
const share = { id, name: 'Films', server: 'nas', share: 'Films', user: '', domain: '', guest: true,
  path, mounted: true, error: null, errorAt: null }
const drive = { id: 'usb-1234', name: 'USB drive', path: '/media/mediaos/usb-sdb1', fs: 'exfat', sizeBytes: 100 }
const runner: CommandRunner = { run: vi.fn(), spawnLines: () => ({ kill() {} }) }
function make() {
  const sockets: Array<EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = []
  const connect = vi.fn((_path: string) => {
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() })
    sockets.push(socket); queueMicrotask(() => socket.emit('connect'))
    return socket as unknown as Socket
  })
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
  let watchChanged = () => {}
  const watch = vi.fn((_path: string, cb: () => void) => { watchChanged = cb; return watcher })
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = createLinuxFolders({ runner, connect, watch, logger })
  const respond = (value: unknown) => sockets.at(-1)!.emit('data', Buffer.from(JSON.stringify(value) + '\n'))
  return { service, sockets, connect, watcher, watch, logger, respond, watchChanged: () => watchChanged() }
}
afterEach(() => vi.useRealTimers())
describe('folder helper client', () => {
  it('sends each exact operation, strips paths and emits changes', async () => {
    const c = make(), changed = vi.fn(); c.service.on('changed', changed)
    try {
      const list = c.service.list(); await Promise.resolve()
      expect(c.sockets[0]!.write).toHaveBeenCalledWith('{"op":"list"}\n')
      c.respond({ ok: true, shares: [share], drives: [drive] })
      expect(await list).toEqual({ shares: [{ id, name: 'Films', server: 'nas', share: 'Films', user: '', domain: '',
        guest: true, available: true }], drives: [{ id: 'usb-1234', name: 'USB drive', fs: 'exfat', sizeBytes: 100 }] })
      const add = c.service.add({ server: '//NAS', share: 'Films', guest: false, user: 'WORK\\bob', password: 'secret',
        ip: '192.168.1.5', name: 'Cinema' })
      await Promise.resolve()
      expect(JSON.parse(c.sockets.at(-1)!.write.mock.calls[0]![0])).toEqual({ op: 'add', name: 'Cinema', server: 'nas',
        share: 'Films', guest: false, user: 'bob', password: 'secret', domain: 'WORK', ip: '192.168.1.5' })
      c.respond({ ok: true, id, path }); expect(await add).toEqual({ ok: true, id })
      const retry = c.service.retry(id); await Promise.resolve()
      expect(c.sockets.at(-1)!.write).toHaveBeenCalledWith(JSON.stringify({ op: 'mount', id }) + '\n')
      c.respond({ ok: true, path }); expect(await retry).toEqual({ ok: true })
      const remove = c.service.remove(id); await Promise.resolve()
      expect(c.sockets.at(-1)!.write).toHaveBeenCalledWith(JSON.stringify({ op: 'remove', id }) + '\n')
      c.respond({ ok: true }); expect(await remove).toEqual({ ok: true })
      expect(changed).toHaveBeenCalledTimes(3)
      expect(c.sockets.every((s) => s.destroy.mock.calls.length === 1)).toBe(true)
    } finally { c.service.dispose() }
  })
  it('drops hostile paths and invalid entries independently', async () => {
    const c = make()
    try {
      const promise = c.service.roots()
      c.respond({ ok: true, shares: [share, ...['/etc', '/media/mediaos/../x', '/media/mediaos/smb-ffffffff']
        .map((path) => ({ ...share, path })), { ...share, mounted: 'yes' }], drives: [drive, { ...drive, path: '/etc' }] })
      expect(await promise).toEqual([{ id, name: 'Films', kind: 'share', path, available: true, server: 'nas' },
        { id: 'usb-1234', name: 'USB drive', kind: 'usb', path: drive.path, available: true }])
      expect(c.logger.warn).toHaveBeenCalledTimes(5)
      const add = c.service.add({ server: 'nas', share: 'Films', guest: true })
      c.respond({ ok: true, id, path: '/etc' })
      expect(await add).toEqual({ ok: false, error: folderText('failed') })
    } finally { c.service.dispose() }
  })
  it.each(['invalid', 'too-many', 'exists', 'not-found', 'unreachable', 'auth', 'no-share', 'busy', 'failed', 'odd'])(
    'maps %s and logs helper detail', async (word) => {
      const c = make()
      try {
        const promise = c.service.add({ server: 'nas', share: 'Films', guest: true })
        c.respond({ ok: false, error: word, detail: 'mount refused' })
        expect(await promise).toEqual({ ok: false, error: folderText(word, 'nas', 'Films') })
        expect(c.logger.warn).toHaveBeenCalledWith('Network folder helper failed', 'mount refused')
      } finally { c.service.dispose() }
    })
  it('maps last mount errors and a share not mounted yet', async () => {
    const c = make()
    try {
      const promise = c.service.list()
      c.respond({ ok: true, shares: [{ ...share, mounted: false, error: 'auth' },
        { ...share, id: 'smb-ffffffff', path: '/media/mediaos/smb-ffffffff', mounted: false }], drives: [] })
      expect((await promise).shares.map((s) => s.problem)).toEqual([folderText('auth', 'nas'), 'Not connected yet.'])
    } finally { c.service.dispose() }
  })
  it.each(['password', 'server', 'share'])('refuses invalid %s before connecting', async (field) => {
    const c = make()
    try {
      const value = { password: 'bad\npassword', server: '::1', share: 'a,b' }[field]!
      const req = { server: 'nas', share: 'Films', guest: false, user: 'bob', [field]: value }
      expect(await c.service.add(req)).toEqual({ ok: false, error: folderText('invalid') })
      expect(c.connect).not.toHaveBeenCalled()
      expect(CALLS['folders.add'].safeParse([req]).success).toBe(false)
    } finally { c.service.dispose() }
  })
  it.each(['name', 'server', 'share', 'user', 'password', 'domain', 'ip'])(
    'refuses trailing control characters in %s before sending', async (field) => {
      const c = make()
      try {
        const req = { name: 'Films', server: 'nas', share: 'Films', user: 'bob', password: 'secret', domain: 'WORK',
          ip: '192.168.1.20', guest: false }
        const bad = { ...req, [field]: req[field as keyof typeof req] + '\n' }
        expect(await c.service.add(bad)).toEqual({ ok: false, error: folderText('invalid') })
        expect(c.connect).not.toHaveBeenCalled()
        expect(CALLS['folders.add'].safeParse([bad]).success).toBe(false)
      } finally { c.service.dispose() }
    })
  it('refuses trailing controls in share ids and drive paths', async () => {
    const c = make()
    try {
      expect(CALLS['folders.remove'].safeParse([id + '\n']).success).toBe(false)
      expect(CALLS['folders.retry'].safeParse([id + '\n']).success).toBe(false)
      expect(await c.service.remove(id + '\n')).toEqual({ ok: false, error: folderText('invalid') })
      expect(c.connect).not.toHaveBeenCalled()
      const pending = c.service.roots()
      c.respond({ ok: true, shares: [{ ...share, id: id + '\n' }], drives: [{ ...drive, path: drive.path + '\n' }] })
      expect(await pending).toEqual([])
    } finally { c.service.dispose() }
  })
  it('splits an explicitly blank domain without masking invalid original fields', () => {
    const req = { server: 'nas', share: 'Films', user: 'WORK\\bob', password: 'secret', guest: false }
    for (const domain of [undefined, '', ' ']) {
      const result = CALLS['folders.add'].parse([{ ...req, domain }])[0]
      expect(result).toMatchObject({ user: 'bob', domain: 'WORK' })
    }
    expect(CALLS['folders.add'].safeParse([{ ...req, domain: '\n' }]).success).toBe(false)
  })
  it.each(['ENOENT', 'ECONNREFUSED', 'EACCES'])('handles missing/refused socket: %s', async (code) => {
    const c = make()
    try {
      const p = c.service.list(); const rejected = expect(p).rejects.toThrow(folderText('unavailable'))
      c.sockets.at(-1)!.emit('error', Object.assign(new Error('socket'), { code })); await rejected
    } finally { c.service.dispose() }
  })
  it.each([['list', 10000], ['add', 45000], ['retry', 40000], ['remove', 20000]] as const)(
    'bounds %s time', async (op, ms) => {
      vi.useFakeTimers()
      const c = make()
      try {
        const p = op === 'list' ? c.service.list().catch((e: Error) => e.message) : op === 'add' ?
          c.service.add({ server: 'nas', share: 'Films', guest: true }) : c.service[op](id)
        await vi.advanceTimersByTimeAsync(ms - 1); expect(c.sockets[0]!.destroy).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await p).toEqual(op === 'list' ? folderText('unavailable') : { ok: false, error: folderText('unavailable') })
      } finally { c.service.dispose() }
    })
  it('caps replies, rejects malformed envelopes and cancels pending work on dispose', async () => {
    const c = make()
    const big = expect(c.service.list()).rejects.toThrow(folderText('unavailable'))
    c.sockets.at(-1)!.emit('data', Buffer.alloc(1_048_577)); await big
    const invalid = expect(c.service.list()).rejects.toThrow(folderText('failed'))
    c.respond({ ok: true, shares: 'bad', drives: [] }); await invalid
    const pending = expect(c.service.list()).rejects.toThrow(folderText('unavailable'))
    c.service.dispose(); await pending
    expect(c.watcher.close).toHaveBeenCalledOnce()
  })
  it('debounces inotify changes and retries a missing mount root', async () => {
    vi.useFakeTimers()
    const c = make(), changed = vi.fn(); c.service.on('changed', changed)
    c.watchChanged(); await vi.advanceTimersByTimeAsync(500); c.watchChanged()
    await vi.advanceTimersByTimeAsync(999); expect(changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledOnce()
    c.watcher.emit('error', new Error('gone')); await vi.advanceTimersByTimeAsync(60_000)
    expect(c.watch).toHaveBeenCalledTimes(2)
    c.service.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
})
