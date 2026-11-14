import * as crypto from 'node:crypto'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../src/shared/settings-schema'
import { EVENT_SCHEMAS, type EventPayloads } from '../../src/shared/ipc-contract'
import { PhoneRemote } from '../../src/main/remote/phone-remote'
import { PhoneStore } from '../../src/main/remote/phone-store'
import { RemoteServer, type RemoteHandler, type RemoteLease } from '../../src/main/remote/RemoteServer'
import { APP_PHONE_KEYS } from '../../src/main/remote/key-injector'
import { PHONE_TEXT_LIMIT } from '../../src/main/remote/remote-page'
import { composeCore } from '../../src/main/core/compose'
import { runtime } from '../../src/main/core/runtime'
import { deferred, temporary, until } from './helpers'

vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>()
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) }
})

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); vi.useRealTimers() })
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function lease(host = '192.168.1.2'): Extract<RemoteLease, { ok: true }> {
  return { ok: true, host, port: 8080, release: vi.fn() }
}
function rig() {
  const routes = new Map<string, RemoteHandler>(), limits = new Map<string, unknown>()
  let settings = defaultSettings(), host = '192.168.1.2'
  const listeners = new Set<() => void>(), values: Record<string, Record<string, string>> = {}
  const secrets = { get: (id: string) => values[id], set: vi.fn(async (id: string, value: Record<string, string>) => {
    values[id] = structuredClone(value)
  }) }
  const store = new PhoneStore(secrets), acquire = vi.fn(async (): Promise<RemoteLease> => lease(host))
  const action = vi.fn(async (): Promise<number | void> => undefined), text = vi.fn(async () => undefined)
  const emit = vi.fn(), bindHost = vi.fn(async () => host)
  const remote = new PhoneRemote({ server: {
    mount(path, handler, opts) { routes.set(path, handler); limits.set(path, opts?.limits) }, acquire,
  }, settings: { get: () => structuredClone(settings), onChange: (cb) => {
    const listener = () => cb(settings); listeners.add(listener); return () => { listeners.delete(listener) }
  } }, store, bindHost, action, text, emit, clock: runtime })
  cleanup.push(() => remote.dispose())
  return { remote, routes, limits, store, secrets, action, text, emit, acquire, bindHost,
    set(on: boolean, port = 8080) {
      settings = { ...settings, remote: { phoneRemote: on, port } }; for (const cb of listeners) cb()
    }, host(value: string) { host = value },
    post: (path: string, body: unknown, token?: string, opts: SendOptions = {}) =>
      send(routes, `/remote/${path}`, body, token, opts),
  }
}
interface SendOptions {
  method?: string
  headers?: IncomingHttpHeaders
  raw?: string
  chunks?: string[]
  source?: string
}
async function send(routes: Map<string, RemoteHandler>, path: string, body: unknown, token?: string, opts: SendOptions = {}) {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: opts.source ?? '192.168.1.5' })
  const req = new IncomingMessage(socket), headers = new Map<string, string>()
  req.method = opts.method ?? 'POST'
  req.headers = { 'content-type': 'application/json', 'x-mediaos-remote': '1',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers }
  let raw = ''
  const res = { statusCode: 200, setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value),
    end: (value: string) => { raw = value } }
  const result = routes.get(path)!(req, res as unknown as ServerResponse, {
    url: new URL(path, 'http://192.168.1.2:8080'), nonce: '0123456789abcdef01234567',
  })
  queueMicrotask(() => {
    for (const chunk of opts.chunks ?? [opts.raw ?? JSON.stringify(body)]) req.push(Buffer.from(chunk))
    req.push(null)
  })
  await result
  let data: Record<string, unknown> = {}
  try { data = JSON.parse(raw) as Record<string, unknown> } catch { /* HTML response. */ }
  req.destroy(); socket.destroy()
  return { status: res.statusCode, data, raw, headers }
}
async function pair(r: ReturnType<typeof rig>, previous?: string) {
  const start = await r.remote.pairStart()
  if (!start.ok) throw new Error('Test pairing did not start')
  const result = await r.post('pair', { code: start.code, ...(previous ? { previous } : {}) }, undefined,
    { headers: { 'user-agent': 'private iPhone details' } })
  expect(result.status).toBe(200)
  return { token: result.data.token as string, start }
}

describe('phone remote pairing', () => {
  it('serves the page with the nonce and mounts only key and text with relaxed limits', async () => {
    const r = rig(), page = await send(r.routes, '/remote', {}, undefined, { method: 'GET' })
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.raw).toContain('nonce="0123456789abcdef01234567"')
    expect(r.limits.get('/remote/key')).toEqual({ perSource: 600, total: 1200 })
    expect(r.limits.get('/remote/text')).toEqual({ perSource: 600, total: 1200 })
    expect(r.limits.get('/remote/pair')).toBeUndefined(); expect(r.limits.get('/remote/forget')).toBeUndefined()
  })
  it('pairs once, emits safe metadata and hands the listener to the keeper', async () => {
    const r = rig(), { token, start } = await pair(r)
    expect(start.code).toMatch(/^\d{8}$/)
    expect(start.url).toBe(`http://192.168.1.2:8080/remote?code=${start.code}`)
    expect(Date.parse(start.expiresAt) - Date.now()).toBeLessThanOrEqual(300000)
    expect(r.store.find(token)?.name).toBe('iPhone')
    expect(r.emit).toHaveBeenCalledWith('remotePaired', { id: r.store.list()[0]!.id, name: 'iPhone' })
    expect(r.emit).toHaveBeenCalledWith('remotePairEnded', { reason: 'paired' })
    expect((await r.post('pair', { code: start.code })).data).toEqual({ error: 'expired' })
    expect(JSON.stringify(r.emit.mock.calls)).not.toContain(token)
    await flush(); expect(r.acquire).toHaveBeenCalledTimes(2)
  })
  it('expires at five minutes and reports the end to the TV', async () => {
    vi.useFakeTimers()
    const r = rig(), start = await r.remote.pairStart()
    if (!start.ok) throw new Error('No pairing session')
    await vi.advanceTimersByTimeAsync(299999)
    expect(r.emit).not.toHaveBeenCalledWith('remotePairEnded', expect.anything())
    await vi.advanceTimersByTimeAsync(1)
    expect((await r.post('pair', { code: start.code })).data).toEqual({ error: 'expired' })
    expect(r.emit).toHaveBeenCalledWith('remotePairEnded', { reason: 'expired' })
    expect((await r.acquire.mock.results[0]!.value).ok).toBe(true)
  })
  it('ends after five wrong codes and refuses the right code afterwards', async () => {
    const r = rig(), start = await r.remote.pairStart()
    if (!start.ok) throw new Error('No pairing session')
    const wrong = start.code === '00000000' ? '11111111' : '00000000'
    for (let i = 0; i < 5; i++) expect((await r.post('pair', { code: wrong })).data).toEqual({ error: 'wrong-code' })
    expect(r.emit).toHaveBeenCalledWith('remotePairEnded', { reason: 'too-many-tries' })
    expect((await r.post('pair', { code: start.code })).data).toEqual({ error: 'expired' })
    expect(r.store.count()).toBe(0)
  })
  it('removes the previous token before re-pairing and ignores unknown previous tokens', async () => {
    const r = rig(), first = await pair(r), second = await pair(r, first.token)
    expect(r.store.count()).toBe(1); expect(r.store.find(first.token)).toBeUndefined()
    expect(r.store.find(second.token)).toBeDefined()
    await pair(r, 'unknown'); expect(r.store.count()).toBe(2)
  })
  it('claims before the first await so concurrent right codes yield exactly one token', async () => {
    const r = rig(), gate = deferred<void>(), start = await r.remote.pairStart()
    if (!start.ok) throw new Error('No pairing session')
    r.secrets.set.mockImplementationOnce(async () => gate.promise)
    const first = r.post('pair', { code: start.code })
    await flush()
    const second = await r.post('pair', { code: start.code })
    expect(second.data).toEqual({ error: 'expired' }); expect(second.data).not.toHaveProperty('token')
    gate.resolve(); expect((await first).data.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.store.count()).toBe(1)
  })
  it('lets pairCancel win during acquire and releases the late lease without an ended event', async () => {
    const r = rig(), acquired = deferred<RemoteLease>(), late = lease()
    r.acquire.mockReturnValueOnce(acquired.promise)
    const opening = r.remote.pairStart()
    await r.remote.pairCancel(); acquired.resolve(late)
    expect(await opening).toEqual({ ok: false, error: 'unavailable' }); expect(late.release).toHaveBeenCalledOnce()
    expect(r.emit).not.toHaveBeenCalledWith('remotePairEnded', expect.anything())
  })
  it('does not grant a token if pairing is cancelled during the store write', async () => {
    const r = rig(), start = await r.remote.pairStart(), saved = deferred<void>()
    if (!start.ok) throw new Error('No pairing session')
    r.secrets.set.mockImplementationOnce(async () => saved.promise)
    const pairing = r.post('pair', { code: start.code })
    await until(() => r.secrets.set.mock.calls.length === 1)
    await r.remote.pairCancel(); saved.resolve()
    expect((await pairing).data).toEqual({ error: 'expired' })
    expect(r.store.count()).toBe(0)
    expect(r.emit).not.toHaveBeenCalledWith('remotePaired', expect.anything())
  })
  it('compares the pairing code in constant time', async () => {
    const r = rig(), start = await r.remote.pairStart()
    if (!start.ok) throw new Error('No pairing session')
    const compare = vi.mocked(crypto.timingSafeEqual)
    compare.mockClear()
    const wrong = start.code === '00000000' ? '11111111' : '00000000'
    await r.post('pair', { code: wrong })
    expect(compare).toHaveBeenCalledWith(Buffer.from(wrong), Buffer.from(start.code))
  })
  it('puts back an evicted phone when a full-store pairing is cancelled during the write', async () => {
    const r = rig()
    for (let i = 0; i < 8; i++) await r.store.add(i ? 'Phone' : 'iPad')
    const before = r.store.list().map((p) => p.id).sort()
    const start = await r.remote.pairStart(), saved = deferred<void>()
    if (!start.ok) throw new Error('No pairing session')
    r.secrets.set.mockImplementationOnce(async () => saved.promise)
    const pairing = r.post('pair', { code: start.code })
    await until(() => r.secrets.set.mock.calls.length === 9)
    await r.remote.pairCancel(); saved.resolve()
    expect((await pairing).data).toEqual({ error: 'expired' })
    expect(r.store.list().map((p) => p.id).sort()).toEqual(before)
    expect(r.store.list().some((p) => p.name === 'iPad')).toBe(true)
  })
  it('keeps the previous phone working when a re-pair is cancelled during the write', async () => {
    const r = rig(), first = await pair(r), start = await r.remote.pairStart(), saved = deferred<void>()
    if (!start.ok) throw new Error('No pairing session')
    const writes = r.secrets.set.mock.calls.length
    r.secrets.set.mockImplementationOnce(async () => saved.promise)
    const pairing = r.post('pair', { code: start.code, previous: first.token })
    await until(() => r.secrets.set.mock.calls.length === writes + 1)
    await r.remote.pairCancel(); saved.resolve()
    expect((await pairing).data).toEqual({ error: 'expired' })
    expect(r.store.count()).toBe(1)
    expect((await r.post('key', { action: 'up' }, first.token)).status).toBe(200)
  })
  it('holds the pairing lease until the keeper has its own, so the listener does not close in between', async () => {
    const r = rig(), session = lease(), keeper = deferred<RemoteLease>()
    r.acquire.mockResolvedValueOnce(session).mockReturnValueOnce(keeper.promise)
    await pair(r)
    await flush()
    expect(r.acquire).toHaveBeenCalledTimes(2); expect(session.release).not.toHaveBeenCalled()
    keeper.resolve(lease()); await flush()
    expect(session.release).toHaveBeenCalledOnce()
  })
  it('includes the evicted phone name in the pairing event when the store is full', async () => {
    const r = rig()
    await r.store.add('iPad')
    for (let i = 0; i < 7; i++) await r.store.add('Phone')
    const { token } = await pair(r)
    expect(r.store.count()).toBe(8)
    expect(r.emit).toHaveBeenCalledWith('remotePaired', { id: r.store.find(token)!.id, name: 'iPhone', replaced: 'iPad' })
  })
  it('reports off and network failures, and stops a live session when switched off', async () => {
    const r = rig()
    r.set(false); expect(await r.remote.pairStart()).toEqual({ ok: false, error: 'off' })
    r.set(true); r.acquire.mockResolvedValueOnce({ ok: false, reason: 'no-network' })
    expect(await r.remote.pairStart()).toEqual({ ok: false, error: 'no-network' })
    r.acquire.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await r.remote.pairStart()).toEqual({ ok: false, error: 'unavailable' })
    await r.remote.pairStart(); r.set(false)
    expect(r.emit).toHaveBeenCalledWith('remotePairEnded', { reason: 'off' })
  })
})

describe('phone bearer routes and request validation', () => {
  it.each(['key', 'text', 'forget'])('requires bearer auth on %s and reports off as 403', async (path) => {
    const r = rig()
    expect(await r.post(path, {})).toMatchObject({ status: 401, data: { error: 'unpaired' } })
    expect(await r.post(path, {}, 'unknown')).toMatchObject({ status: 401, data: { error: 'unpaired' } })
    r.set(false)
    expect(await r.post(path, {})).toMatchObject({ status: 403, data: { error: 'off' } })
  })
  it.each(['pair', 'key', 'text', 'forget'])('requires the header and JSON media type on %s', async (path) => {
    const r = rig()
    for (const headers of [{ 'x-mediaos-remote': undefined }, { 'x-mediaos-remote': '0' }, { 'content-type': 'text/plain' },
      { 'content-type': 'application/jsonp' }, { 'content-type': 'application/json application/xml' }]) {
      expect(await r.post(path, {}, undefined, { headers })).toMatchObject({ status: 400, data: { error: 'bad-request' } })
    }
    const response = await r.post(path, {}, undefined, { headers: { 'content-type': 'application/json; charset=utf-8' } })
    expect(response.status).not.toBe(400)
  })
  it.each(['null', '[]', '"string"', '1', '{', ''])('rejects non-object or invalid JSON: %s', async (raw) => {
    expect(await rig().post('key', {}, undefined, { raw })).toMatchObject({ status: 400, data: { error: 'bad-request' } })
  })
  it('refuses oversized declared bodies before reading, and limits streaming bodies to 1024 bytes', async () => {
    const r = rig()
    expect(await r.post('key', {}, undefined, { headers: { 'content-length': '1025' } })).toMatchObject({
      status: 413, data: { error: 'bad-request' },
    })
    expect(await r.post('key', {}, undefined, { chunks: [' '.repeat(600), ' '.repeat(425)] })).toMatchObject({
      status: 413, data: { error: 'bad-request' },
    })
    expect((await r.post('key', {}, undefined, { raw: `{${' '.repeat(1022)}}` })).status).toBe(401)
  })
  it.each(['/remote', '/remote/pair', '/remote/key', '/remote/text', '/remote/forget'])(
    'refuses OPTIONS without any CORS headers: %s', async (path) => {
      const r = rig(), result = await send(r.routes, path, {}, undefined, { method: 'OPTIONS' })
      expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe(path === '/remote' ? 'GET' : 'POST')
      expect([...result.headers.keys()].some((key) => key.startsWith('access-control'))).toBe(false)
    })
  it('locks all bearer routes after five failures, including good tokens, and clears after a minute', async () => {
    vi.useFakeTimers()
    const r = rig(), { token } = await pair(r)
    for (let i = 0; i < 10; i++) expect((await r.post('key', { action: 'up' }, token)).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await r.post('key', {}, 'bad')).status).toBe(401)
    for (const path of ['key', 'text', 'forget']) {
      expect(await r.post(path, {}, token)).toMatchObject({ status: 429, data: { error: 'rate' } })
    }
    expect((await r.post('key', { action: 'up' }, token, { source: '192.168.1.6' })).status).toBe(200)
    await vi.advanceTimersByTimeAsync(60000)
    expect((await r.post('key', { action: 'up' }, token)).status).toBe(200)
  })
  it('touches every authorised request and removes forgotten and TV-revoked phones', async () => {
    const r = rig(), { token } = await pair(r), touch = vi.spyOn(r.store, 'touch'), id = r.store.find(token)!.id
    await r.post('key', { action: 'wrong' }, token)
    expect(touch).toHaveBeenCalledWith(id)
    expect(await r.post('forget', {}, token)).toMatchObject({ status: 200, data: { ok: true } })
    expect(r.store.count()).toBe(0); expect(r.emit).toHaveBeenCalledWith('remotePhones', {})
    expect((await r.post('key', { action: 'up' }, token)).status).toBe(401)
    const next = await pair(r)
    expect(await r.remote.removePhone(r.store.find(next.token)!.id)).toEqual({ ok: true })
    expect(r.remote.phones()).toEqual([])
  })
  it('validates text, strips controls and format characters, and ignores empty cleaned text', async () => {
    const r = rig(), { token } = await pair(r)
    for (const body of [{}, { text: '' }, { text: 'x'.repeat(PHONE_TEXT_LIMIT + 1) }, { text: 'a', backspace: true },
      { backspace: false }, { text: 'a', other: true }]) {
      expect((await r.post('text', body, token)).status).toBe(400)
    }
    await r.post('text', { text: 'a\u0000\n\u0085\u202eb\u200dc' }, token)
    expect(r.text).toHaveBeenLastCalledWith({ text: 'abc' })
    await r.post('text', { text: '\n\u009f\u200d' }, token)
    expect(r.text).toHaveBeenCalledOnce()
    await r.post('text', { backspace: true }, token); expect(r.text).toHaveBeenLastCalledWith({ backspace: true })
  })
  it('runs actions and text in one queue with at most eight waiting, dropping overflow', async () => {
    const r = rig(), { token } = await pair(r), gate = deferred<void>()
    r.action.mockImplementationOnce(async () => gate.promise)
    const first = r.post('key', { action: 'up' }, token)
    await until(() => r.action.mock.calls.length === 1)
    const touch = vi.spyOn(r.store, 'touch')
    const waiting = Array.from({ length: 8 }, () => r.post('key', { action: 'down' }, token))
    await until(() => touch.mock.calls.length === 8); await flush()
    expect(await r.post('text', { text: 'drop' }, token)).toMatchObject({ status: 200, data: { ok: true } })
    expect(r.action).toHaveBeenCalledOnce(); expect(r.text).not.toHaveBeenCalled()
    gate.resolve(); await first; await Promise.all(waiting)
    expect(r.action).toHaveBeenCalledTimes(9)
    await r.post('text', { text: 'keep' }, token); expect(r.text).toHaveBeenCalledWith({ text: 'keep' })
  })
})

describe('queued input after a phone is revoked', () => {
  async function blocked() {
    const r = rig(), { token } = await pair(r), gate = deferred<void>()
    r.action.mockImplementationOnce(async () => gate.promise)
    const first = r.post('key', { action: 'up' }, token)
    await until(() => r.action.mock.calls.length === 1)
    const touch = vi.spyOn(r.store, 'touch')
    const queued = [r.post('key', { action: 'select' }, token), r.post('text', { text: 'secret' }, token)]
    await until(() => touch.mock.calls.length === 2); await flush()
    return { r, token, gate, first, queued, id: r.store.find(token)!.id }
  }
  it('drops queued keys and text when the TV removes the phone', async () => {
    const { r, gate, first, queued, id } = await blocked()
    expect(await r.remote.removePhone(id)).toEqual({ ok: true })
    gate.resolve(); await first; await Promise.all(queued)
    expect(r.action).toHaveBeenCalledOnce(); expect(r.text).not.toHaveBeenCalled()
  })
  it('drops queued input while the removal is still being written', async () => {
    const { r, token, gate, first, queued, id } = await blocked(), saved = deferred<void>()
    r.secrets.set.mockImplementationOnce(async () => saved.promise)
    const removing = r.remote.removePhone(id)
    gate.resolve(); await first; await Promise.all(queued)
    expect(r.text).not.toHaveBeenCalled()
    // The token still matches until the write lands; a press arriving now must not reach the TV.
    expect((await r.post('text', { text: 'late' }, token)).status).toBe(200)
    expect(r.text).not.toHaveBeenCalled()
    saved.resolve(); expect(await removing).toEqual({ ok: true })
  })
  it('drops queued input when the phone forgets itself', async () => {
    const { r, token, gate, first, queued } = await blocked()
    expect((await r.post('forget', {}, token)).status).toBe(200)
    gate.resolve(); await first; await Promise.all(queued)
    expect(r.action).toHaveBeenCalledOnce(); expect(r.text).not.toHaveBeenCalled()
  })
  it('drops queued input when the switch goes off, even if it is turned back on before the queue drains', async () => {
    const { r, gate, first, queued } = await blocked()
    r.set(false); r.set(true)
    gate.resolve(); await first; await Promise.all(queued)
    expect(r.action).toHaveBeenCalledOnce(); expect(r.text).not.toHaveBeenCalled()
  })
})

describe('phone listener keeper', () => {
  it('holds only for paired phones with the switch on; switching off keeps saved phones', async () => {
    const r = rig()
    await flush(); expect(r.acquire).not.toHaveBeenCalled()
    const { token } = await pair(r)
    await flush(); expect(r.acquire).toHaveBeenCalledTimes(2)
    const held = await r.acquire.mock.results[1]!.value
    if (!held.ok) throw new Error('No keeper lease')
    r.set(false); expect(held.release).toHaveBeenCalledOnce(); expect(r.store.find(token)).toBeDefined()
    r.set(true); await flush(); expect(r.acquire).toHaveBeenCalledTimes(3)
    await r.remote.removePhone(r.store.find(token)!.id); await flush()
    const last = await r.acquire.mock.results[2]!.value
    if (!last.ok) throw new Error('No keeper lease')
    expect(last.release).toHaveBeenCalledOnce()
  })
  it('retries failed acquisition after 30 seconds and re-acquires on host or port changes', async () => {
    vi.useFakeTimers()
    const r = rig(), added = await r.store.add('Phone')
    r.acquire.mockResolvedValueOnce({ ok: false, reason: 'no-network' })
    r.set(true); await flush(); expect(r.acquire).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29999); expect(r.acquire).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(r.acquire).toHaveBeenCalledTimes(2)
    const old = await r.acquire.mock.results[1]!.value
    r.host('192.168.1.10'); await vi.advanceTimersByTimeAsync(30000)
    if (!old.ok) throw new Error('No keeper lease')
    expect(old.release).toHaveBeenCalledOnce(); expect(r.acquire).toHaveBeenCalledTimes(3)
    r.set(true, 8081); await flush(); expect(r.acquire).toHaveBeenCalledTimes(4)
    await r.remote.removePhone(added.id); r.remote.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases late keeper acquisitions after disposal and cancels all timers', async () => {
    vi.useFakeTimers()
    const r = rig(), pending = deferred<RemoteLease>(), late = lease()
    await r.store.add('Phone'); await flush()
    r.acquire.mockReturnValueOnce(pending.promise); r.set(true); await flush()
    r.remote.dispose(); pending.resolve(late); await flush()
    expect(late.release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps retrying a port change while another lease holds the old listener', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.store.add('Phone'); r.set(true); await flush()
    r.set(true, 9090); await flush()
    expect(r.acquire).toHaveBeenCalledTimes(2)
    // The fake listener still returns port 8080, as a VPN lease may do until its upload ends.
    await vi.advanceTimersByTimeAsync(30000)
    expect(r.acquire).toHaveBeenCalledTimes(3)
    const old = await r.acquire.mock.results[1]!.value
    if (!old.ok) throw new Error('No keeper lease')
    expect(old.release).toHaveBeenCalledOnce()
  })
})

describe('composed phone routing and IPC', () => {
  it('uses volume everywhere, maps app keys, routes Home and Recovery, and sends text to the foreground', async () => {
    const routes = new Map<string, RemoteHandler>()
    vi.spyOn(RemoteServer.prototype, 'mount').mockImplementation((path, handler) => { routes.set(path, handler) })
    vi.spyOn(RemoteServer.prototype, 'acquire').mockImplementation(async () => lease())
    const temp = await temporary(), injector = { key: vi.fn(async () => undefined), text: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined), dispose: vi.fn() }
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: temp.dir, appIcons: 'off',
      forceMockPlayer: true, mockDelayMs: 0, fixtureLatencyMs: 0, keyInjector: injector, restartShell() {} })
    const core = composed.core
    try {
      const start = await core.dispatch('remote.pairStart', [])
      if (!start.ok) throw new Error('No pairing session')
      const paired = await send(routes, '/remote/pair', { code: start.code }), token = paired.data.token as string
      const key = (action: string) => send(routes, '/remote/key', { action }, token)
      const text = (body: unknown) => send(routes, '/remote/text', body, token)
      const actions: EventPayloads['action'][] = [], texts: EventPayloads['remoteText'][] = []
      core.on('action', (value) => actions.push(value)); core.on('remoteText', (value) => texts.push(value))
      const wake = vi.spyOn(core, 'wakeScreen'), close = vi.spyOn(core.apps, 'close'), recovery = vi.fn()
      core.on('recovery', recovery)
      for (const foreground of [{ kind: 'shell' }, { kind: 'app', appId: 'youtube' }, { kind: 'player' }] as const) {
        core.setForeground(foreground); await core.system.audio.setVolume(98)
        expect((await key('volumeUp')).data).toEqual({ ok: true, volume: 100 })
        await core.system.audio.setVolume(2); expect((await key('volumeDown')).data).toEqual({ ok: true, volume: 0 })
      }
      expect(wake).not.toHaveBeenCalled(); expect(actions).toEqual([]); expect(injector.key).not.toHaveBeenCalled()
      core.setForeground({ kind: 'app', appId: 'youtube' })
      for (const [action, mapped] of Object.entries(APP_PHONE_KEYS)) {
        await key(action); expect(injector.key).toHaveBeenLastCalledWith(mapped)
      }
      expect(wake).toHaveBeenCalledTimes(10)
      await text({ text: 'private\n\u202etext' }); expect(injector.text).toHaveBeenCalledWith('privatetext')
      await text({ backspace: true }); expect(injector.key).toHaveBeenLastCalledWith('BackSpace')
      await key('home'); expect(close).toHaveBeenCalled(); expect(core.getForeground()).toEqual({ kind: 'shell' })
      expect(injector.key).not.toHaveBeenCalledWith('F1'); expect(injector.key).not.toHaveBeenCalledWith('XF86HomePage')
      await key('up'); expect(actions).toEqual([{ action: 'up' }])
      await text({ text: 'hello' }); await text({ backspace: true })
      expect(texts).toEqual([{ text: 'hello' }, { backspace: true }])
      core.setForeground({ kind: 'player' }); await text({ text: 'ignored' })
      expect(texts).toHaveLength(2); expect(injector.text).toHaveBeenCalledOnce()
      const state = core.player.state(), command = vi.spyOn(core.player, 'command').mockResolvedValue(undefined)
      vi.spyOn(core.player, 'state').mockReturnValue({ ...state, backend: 'mpv' })
      await key('select'); expect(command).toHaveBeenLastCalledWith({ kind: 'togglePause' })
      await key('left')
      expect(command).toHaveBeenLastCalledWith({ kind: 'seekRelative', seconds: -core.settings.get().playback.skipBackSec })
      await key('right')
      expect(command).toHaveBeenLastCalledWith({ kind: 'seekRelative', seconds: core.settings.get().playback.skipForwardSec })
      core.setForeground({ kind: 'app', appId: 'youtube' }); await key('recovery')
      expect(recovery).toHaveBeenCalledOnce(); expect(core.getForeground()).toEqual({ kind: 'shell' })
      const phones = await core.dispatch('remote.phones', [])
      expect(phones).toHaveLength(1)
      expect(await core.dispatch('remote.removePhone', [phones[0]!.id])).toEqual({ ok: true })
      expect(await core.dispatch('remote.phones', [])).toEqual([])
      expect(await core.dispatch('remote.pairCancel', [])).toEqual({ ok: true })
      for (const payload of texts) expect(EVENT_SCHEMAS.remoteText.safeParse(payload).success).toBe(true)
      expect(EVENT_SCHEMAS.remoteText.safeParse({ text: 'a', backspace: true }).success).toBe(false)
      expect(EVENT_SCHEMAS.remotePairEnded.safeParse({ reason: 'off' }).success).toBe(true)
    } finally { await composed.dispose(); await temp.dispose() }
  })
})
