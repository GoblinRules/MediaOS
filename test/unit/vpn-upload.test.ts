import { randomBytes } from 'node:crypto'
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteServer } from '../../src/main/remote/RemoteServer'
import { VpnUpload, type UploadOpenResult } from '../../src/main/remote/upload'
import { runtime } from '../../src/main/core/runtime'
import { redact } from '../../src/main/log/redact'
import { readZipConfs } from '../../src/main/vpn/zip-reader'
import { crc32 } from 'node:zlib'
import { parseWireGuard } from '../../src/main/vpn/wg-config'
import { readLaunchOptions } from '../../src/main/launch-options'

const active: { server: RemoteServer; upload: VpnUpload }[] = []
afterEach(() => { for (const f of active) { f.upload.close(); f.server.dispose() }; active.length = 0 })
const headers = { 'X-MediaOS-Upload': '1', 'Content-Type': 'application/octet-stream' }
function conf(): Buffer {
  const key = (): string => randomBytes(32).toString('base64')
  return Buffer.from(`[Interface]\nPrivateKey = ${key()}\nAddress = 10.64.0.2/32\n\n` +
    `[Peer]\nPublicKey = ${key()}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`)
}
function zip(data: Buffer): Buffer {
  const name = Buffer.from('uk.conf'), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}
function send(url: string, opts: { method?: string; headers?: OutgoingHttpHeaders; data?: Buffer; chunked?: boolean } = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'POST', headers: opts.headers ?? headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (data: Buffer) => chunks.push(data)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    if (opts.chunked && opts.data) {
      req.write(opts.data.subarray(0, 32768)); req.end(opts.data.subarray(32768))
    } else req.end(opts.data)
  })
}
function opened(value: UploadOpenResult): asserts value is Extract<UploadOpenResult, { ok: true }> { expect(value.ok).toBe(true) }
async function setup() {
  let now = Date.now()
  const logs: unknown[][] = []
  const logger = { debug: (...args: unknown[]) => logs.push(args), info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }
  const server = new RemoteServer({ bindHost: async () => '127.0.0.1', port: () => 0, now: () => now, logger })
  // A second lease lets tests ask about a consumed/expired code after the upload's lease has closed.
  const observer = await server.acquire(); expect(observer.ok).toBe(true)
  const receiveFile = vi.fn(async (_name: string, _data: Buffer, _code: string): Promise<boolean> => true)
  const uploadTooLarge = vi.fn((_code: string) => {})
  const upload = new VpnUpload(server, { receiveFile, uploadTooLarge }, { logger, clock: { ...runtime, now: () => now } })
  active.push({ server, upload })
  const result = await upload.open(); opened(result)
  return { server, upload, receiveFile, uploadTooLarge, result, logs, advance: (ms: number) => { now += ms } }
}

describe('VPN phone upload', () => {
  it('issues an eight-digit code for five minutes, with a live page and fresh nonce', async () => {
    const f = await setup()
    expect(f.result.code).toMatch(/^\d{8}$/)
    expect(f.result.url).toMatch(new RegExp(`/vpn-upload\\?code=${f.result.code}$`))
    const page = await send(f.result.url, { method: 'GET' })
    expect(page.status).toBe(200); expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('id="form"')
    expect(Date.parse(f.result.expiresAt) - Date.now()).toBeGreaterThan(299000)
    const nonce = /<style nonce="([^"]+)"/.exec(page.body)![1]!
    expect(page.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce}'`)
    expect((await send(f.result.url.replace(f.result.code, 'wrong'), { method: 'GET' })).body).toContain('This code has expired')
    expect((await send(f.result.url, { method: 'GET' })).body).toContain('id="form"')
    f.advance(300000)
    expect((await send(f.result.url, { method: 'GET' })).body).toContain('This code has expired')
  })
  it.each(['wrong', 'expired', 'used'] as const)('refuses a %s code', async (reason) => {
    const f = await setup()
    if (reason === 'expired') f.advance(300000)
    if (reason === 'used') expect((await send(f.result.url, { data: conf() })).status).toBe(200)
    const url = reason === 'wrong' ? f.result.url.replace(f.result.code, 'wrong') : f.result.url
    const reply = await send(url, { data: conf() })
    expect(reply.status).toBe(403); expect(reply.body).toBe('{"error":"expired"}')
    expect(f.receiveFile).toHaveBeenCalledTimes(reason === 'used' ? 1 : 0)
  })
  it.each([
    { 'Content-Type': 'application/octet-stream' },
    { 'X-MediaOS-Upload': '2', 'Content-Type': 'application/octet-stream' },
    { 'X-MediaOS-Upload': '1', 'Content-Type': 'application/json' },
    { 'X-MediaOS-Upload': '1' },
  ])('checks headers before the code and does not claim it: %j', async (badHeaders) => {
    const f = await setup()
    const reply = await send(f.result.url.replace(f.result.code, 'wrong'), { headers: badHeaders, data: conf() })
    expect(reply.status).toBe(400); expect(reply.body).toBe('{"error":"bad-request"}')
    expect((await send(f.result.url, { data: conf() })).status).toBe(200)
  })
  it.each([false, true])('allows another try after an empty body (plain=%s)', async (plain) => {
    const f = await setup()
    const reply = await send(f.result.url, { data: Buffer.from(plain ? ' \r\n\t ' : ''), headers: {
      ...headers, 'Content-Type': plain ? 'text/plain;charset=utf-8' : 'application/octet-stream',
    } })
    expect(reply.status).toBe(400); expect(reply.body).toBe('{"error":"empty"}')
    expect((await send(f.result.url, { data: conf() })).status).toBe(200)
    expect(f.receiveFile).toHaveBeenCalledOnce()
  })
  it.each([false, true])('uses up an oversized body and notifies the TV (chunked=%s)', async (chunked) => {
    const f = await setup(), data = Buffer.alloc(65537, 120)
    const reply = await send(f.result.url, { data, chunked, headers: chunked ? headers : { ...headers, 'Content-Length': data.length } })
    expect(reply.status).toBe(413); expect(reply.body).toBe('{"error":"too-large"}')
    expect(f.uploadTooLarge).toHaveBeenCalledExactlyOnceWith(f.result.code)
    expect(f.receiveFile).not.toHaveBeenCalled()
    expect((await send(f.result.url, { data: conf() })).status).toBe(403)
  })
  it('accepts exactly 65536 bytes', async () => {
    const f = await setup(), data = Buffer.alloc(65536, 120)
    expect((await send(f.result.url, { data })).status).toBe(200)
    expect(f.receiveFile).toHaveBeenCalledExactlyOnceWith('', data, f.result.code)
  })
  it.each(['conf', 'zip', 'paste'] as const)('delivers a good %s body, name and code', async (kind) => {
    const f = await setup(), original = conf()
    const data = kind === 'zip' ? zip(original) : kind === 'paste' ?
      Buffer.from('\uFEFF\r\n\r\n' + original.toString('utf8').replace(/\n/g, '\r\n') + '\r\n') : original
    const filename = kind === 'zip' ? 'uk.zip' : 'uk.conf'
    const reply = await send(f.result.url + '&name=' + encodeURIComponent(filename), { data, headers: {
      ...headers, 'Content-Type': kind === 'paste' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    } })
    expect(reply.status).toBe(200); expect(reply.body).toBe('{"ok":true}')
    expect(f.receiveFile).toHaveBeenCalledExactlyOnceWith(kind === 'paste' ? '' : filename, data, f.result.code)
    if (kind === 'zip') expect(readZipConfs(data).ok).toBe(true)
    else expect(parseWireGuard(data).ok).toBe(true)
  })
  it('strips paths, control and format characters and caps file names at 100 code points', async () => {
    const f = await setup(), data = conf()
    const name = '../folder\\sub/\u0000\u202e\u200b\uFEFF' + '\u{1f600}'.repeat(105) + '.conf'
    expect((await send(f.result.url + '&name=' + encodeURIComponent(name), { data })).status).toBe(200)
    expect(f.receiveFile).toHaveBeenCalledExactlyOnceWith('\u{1f600}'.repeat(100), data, f.result.code)
  })
  it('tells the phone the code expired when the TV import ended before the file arrived', async () => {
    const f = await setup(); f.receiveFile.mockResolvedValueOnce(false)
    const reply = await send(f.result.url, { data: conf() })
    expect(reply.status).toBe(403); expect(reply.body).toBe('{"error":"expired"}')
    expect(f.receiveFile).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.logs)).not.toContain('upload received')
  })
  it('claims before reading so racing POSTs accept exactly one', async () => {
    const f = await setup(), data = conf()
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const first = new Promise<number>((resolve, reject) => {
      const req = request(f.result.url, { method: 'POST', headers, agent: false }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode!))
      })
      req.on('error', reject); req.write(data.subarray(0, 1)); ready()
      void started.then(async () => {
        // The server must have processed the first byte before we send the second POST.
        await new Promise<void>((done) => setTimeout(done, 20))
        const second = await send(f.result.url, { data })
        expect(second.status).toBe(403); req.end(data.subarray(1))
      }).catch(reject)
    })
    expect(await first).toBe(200); expect(f.receiveFile).toHaveBeenCalledOnce()
  })
  it('unclaims when a phone disconnects before its body is complete', async () => {
    const f = await setup()
    await new Promise<void>((resolve, reject) => {
      const req = request(f.result.url, { method: 'POST', headers: { ...headers, 'Content-Length': 1000 }, agent: false })
      req.on('error', () => resolve())
      req.on('socket', (socket) => socket.on('connect', () => {
        req.write('partial'); setTimeout(() => req.destroy(), 20)
      }))
      req.on('response', () => reject(new Error('Unexpected response')))
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect((await send(f.result.url, { data: conf() })).status).toBe(200)
    expect(f.receiveFile).toHaveBeenCalledOnce()
  })
  it.each(['OPTIONS', 'HEAD', 'PUT'])('returns 405 for %s with no CORS headers', async (method) => {
    const f = await setup(), reply = await send(f.result.url, { method })
    expect(reply.status).toBe(405); expect(reply.headers.allow).toBe('GET, POST')
    expect(Object.keys(reply.headers).some((key) => key.startsWith('access-control-'))).toBe(false)
  })
  it('replaces the old code on a second open and closing twice is harmless', async () => {
    const f = await setup(), second = await f.upload.open(); opened(second)
    expect(second.code).not.toBe(f.result.code)
    expect((await send(f.result.url, { data: conf() })).status).toBe(403)
    expect((await send(second.url, { data: conf() })).status).toBe(200)
    f.upload.close(); f.upload.close()
  })
  it('does not leak a code, query string, body, or filename into logs', async () => {
    const f = await setup(), data = conf(), name = 'sensitive-name.conf'
    await send(f.result.url.replace(f.result.code, 'wrong') + '&name=' + name, { data })
    await send(f.result.url + '&name=' + name, { data })
    const logs = JSON.stringify(f.logs)
    for (const secret of [f.result.code, '?', 'code=', name, data.toString('utf8'), f.result.url]) expect(logs).not.toContain(secret)
    expect(logs).toContain('upload received'); expect(logs).toContain('upload refused: expired code')
  })
  it('maps listener failures to the public errors', async () => {
    const server = new RemoteServer({ bindHost: async () => null, port: () => 0 })
    const upload = new VpnUpload(server, { receiveFile: async () => true, uploadTooLarge: () => {} })
    active.push({ server, upload })
    expect(await upload.open()).toEqual({ ok: false, error: 'no-network' })
    server.dispose()
    expect(await upload.open()).toEqual({ ok: false, error: 'upload-unavailable' })
  })
  it('closes its only lease while the accepted upload response is still in progress', async () => {
    const server = new RemoteServer({ bindHost: async () => '127.0.0.1', port: () => 0 })
    let finish!: () => void, started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const upload = new VpnUpload(server, {
      receiveFile: () => new Promise<boolean>((resolve) => { finish = () => resolve(true); started() }), uploadTooLarge: () => {},
    })
    active.push({ server, upload })
    const result = await upload.open(); opened(result)
    const response = send(result.url, { data: conf() }); await ready
    await expect(send(result.url, { method: 'GET' })).rejects.toThrow()
    finish(); expect((await response).status).toBe(200)
    upload.close(); upload.close()
  })
  it('automatically revokes and releases its lease after five minutes', async () => {
    const server = new RemoteServer({ bindHost: async () => '127.0.0.1', port: () => 0 })
    const upload = new VpnUpload(server, { receiveFile: async () => true, uploadTooLarge: () => {} })
    active.push({ server, upload })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const result = await upload.open(); opened(result)
      await vi.advanceTimersByTimeAsync(300000)
      await expect(send(result.url, { method: 'GET' })).rejects.toThrow()
    } finally { vi.useRealTimers() }
  })
  it('releases an acquired lease when closed while open is pending', async () => {
    const server = new RemoteServer({ bindHost: async () => '127.0.0.1', port: () => 0 })
    const upload = new VpnUpload(server, { receiveFile: async () => true, uploadTooLarge: () => {} })
    active.push({ server, upload })
    const opening = upload.open(); upload.close()
    expect(await opening).toEqual({ ok: false, error: 'upload-unavailable' })
  })
})

describe('upload launch and redaction backstops', () => {
  it('redacts numeric codes in URLs and bare assignments', () => {
    expect(redact('code=12345678 &code=00000001 CODE=9')).toBe('code=[REDACTED] &code=[REDACTED] CODE=[REDACTED]')
    expect(redact('http://192.168.1.2:8080/vpn-upload?code=12345678&name=foo.conf'))
      .toBe('http://192.168.1.2:8080/vpn-upload?code=[REDACTED]&name=foo.conf')
  })
  it('reads --lan or MEDIAOS_LAN=1, defaults to loopback', () => {
    expect(readLaunchOptions({}, []).lan).toBe(false)
    expect(readLaunchOptions({}, ['--lan']).lan).toBe(true)
    expect(readLaunchOptions({ MEDIAOS_LAN: '1' }, []).lan).toBe(true)
    expect(readLaunchOptions({ MEDIAOS_LAN: 'true' }, []).lan).toBe(false)
  })
})
