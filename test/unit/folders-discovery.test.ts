import { EventEmitter } from 'node:events'
import type { Socket } from 'node:dgram'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDns, smbQuery } from '../../src/main/folders/dns-packet'
import { createFolderDiscovery, privateIpv4, type DiscoveryDgram } from '../../src/main/folders/discovery'

const dnsName = (s: string) => Buffer.concat([...s.split('.').map((part) => Buffer.concat([
  Buffer.from([Buffer.byteLength(part)]), Buffer.from(part)])), Buffer.from([0])])
function dnsReply() {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(3, 6)
  const parts: Buffer[] = [header]
  const size = () => parts.reduce((n, p) => n + p.length, 0)
  const pointer = (at: number) => Buffer.from([0xc0 | (at >> 8), at & 255])
  const record = (name: Buffer, type: number, data: Buffer) => {
    const fields = Buffer.alloc(10); fields.writeUInt16BE(type, 0); fields.writeUInt16BE(1, 2)
    fields.writeUInt32BE(120, 4); fields.writeUInt16BE(data.length, 8)
    const offset = size() + name.length + fields.length
    parts.push(name, fields, data); return offset
  }
  const instance = record(dnsName('_smb._tcp.local'), 12, Buffer.concat([Buffer.from([3]), Buffer.from('NAS'), pointer(12)]))
  const target = record(pointer(instance), 33, Buffer.concat([Buffer.from([0, 0, 0, 0, 1, 189]), dnsName('nas.local')])) + 6
  record(pointer(target), 1, Buffer.from([192, 168, 1, 20]))
  return Buffer.concat(parts)
}
afterEach(() => vi.useRealTimers())
describe('bounded DNS packets', () => {
  it('encodes the PTR query with the unicast response bit', () => {
    expect(smbQuery().toString('hex')).toBe('000000000001000000000000045f736d62045f746370056c6f63616c00000c8001')
  })
  it('links real-shaped compressed PTR, SRV and A records', () => {
    expect(parseDns(dnsReply())).toEqual([
      { name: '_smb._tcp.local', type: 'PTR', target: 'NAS._smb._tcp.local', labels: ['NAS', '_smb', '_tcp', 'local'] },
      { name: 'NAS._smb._tcp.local', type: 'SRV', target: 'nas.local' },
      { name: 'nas.local', type: 'A', ip: '192.168.1.20' },
    ])
  })
  it('ignores every truncated prefix, pointer loops and oversized datagrams', () => {
    const packet = dnsReply()
    for (let n = 0; n < packet.length; n++) expect(parseDns(packet.subarray(0, n))).toEqual([])
    const loop = Buffer.alloc(24); loop.writeUInt16BE(1, 6); loop[12] = 0xc0; loop[13] = 12
    expect(parseDns(loop)).toEqual([])
    expect(parseDns(Buffer.alloc(65536))).toEqual([])
    const bad = Buffer.from(packet); bad[12] = 64
    expect(parseDns(bad)).toEqual([])
    const longName = Buffer.alloc(12); longName.writeUInt16BE(1, 4)
    expect(parseDns(Buffer.concat([longName, dnsName(Array(4).fill('x'.repeat(63)).join('.')), Buffer.alloc(4)]))).toEqual([])
    const chain = Buffer.alloc(12 + 22 * 2 + 5); chain.writeUInt16BE(1, 4)
    for (let n = 0; n < 22; n++) { chain[12 + n * 2] = 0xc0; chain[13 + n * 2] = 14 + n * 2 }
    expect(parseDns(chain)).toEqual([])
  })
})

class FakeSocket extends EventEmitter {
  close = vi.fn()
  send = vi.fn((_data: Buffer, _port: number, _host: string, cb: (error?: Error) => void) => cb())
  bind = vi.fn((_port: number, cb: () => void) => cb())
}
const pub = 'http://schemas.microsoft.com/windows/pub/2005/07'
function wsd(ip: string, type = 'pub:Computer') {
  return Buffer.from(`<Envelope xmlns:pub="${pub}"><ProbeMatch><EndpointReference><Address>urn:uuid:device</Address></EndpointReference><Types>wsdp:Device ${type}</Types><XAddrs>http://${ip}:5357/device</XAddrs></ProbeMatch></Envelope>`)
}
function make(fetch: typeof globalThis.fetch = async () => new Response('<pub:Computer>OFFICE-PC/Workgroup:WG</pub:Computer>')) {
  const sockets: FakeSocket[] = []
  const createSocket = vi.fn(() => { const s = new FakeSocket(); sockets.push(s); return s as unknown as Socket })
  const discover = createFolderDiscovery({ dgram: { createSocket } as DiscoveryDgram, fetch })
  return { sockets, discover }
}
describe('computer discovery', () => {
  it('runs both probes, merges by IP with mDNS names preferred and closes on the deadline', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('<pub:Computer>OFFICE-PC/Domain:HOME</pub:Computer>'))
    const c = make(fetch), pending = c.discover.discover()
    expect(c.sockets).toHaveLength(2)
    expect(c.sockets[0]!.send.mock.calls[0]?.slice(1, 3)).toEqual([5353, '224.0.0.251'])
    const probe = c.sockets[1]!.send.mock.calls[0]![0].toString('utf8')
    expect(probe).toContain('<d:Types>wsdp:Device</d:Types>')
    expect(probe).toMatch(/urn:uuid:[a-f0-9-]{36}/)
    c.sockets[1]!.emit('message', wsd('192.168.1.20'))
    c.sockets[1]!.emit('message', wsd('192.168.1.31'))
    await vi.advanceTimersByTimeAsync(0)
    c.sockets[0]!.emit('message', dnsReply())
    await vi.advanceTimersByTimeAsync(3499)
    let finished = false; void pending.then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual([{ name: 'NAS', host: 'nas.local', ip: '192.168.1.20' },
      { name: 'OFFICE-PC', host: 'OFFICE-PC', ip: '192.168.1.31' }])
    expect(c.sockets.every((s) => s.close.mock.calls.length === 1)).toBe(true)
    const request = fetch.mock.calls[0]![1]!
    expect(request.headers).toEqual({ 'Content-Type': 'application/soap+xml' })
    expect(request.body).toContain('http://schemas.xmlsoap.org/ws/2004/09/transfer/Get')
    expect(request.body).toContain('<a:To>urn:uuid:device</a:To>')
    expect(request.redirect).toBe('error')
    c.discover.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('drops public/host-name XAddrs and printers, and caps metadata at ten addresses', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('<FriendlyName>NAS</FriendlyName>'))
    const c = make(fetch), pending = c.discover.discover()
    for (const ip of ['8.8.8.8', '127.0.0.1', 'nas.local', '[::1]']) c.sockets[1]!.emit('message', wsd(ip))
    c.sockets[1]!.emit('message', wsd('192.168.1.1', 'pub:Printer'))
    expect(fetch).not.toHaveBeenCalled()
    for (let n = 1; n <= 20; n++) c.sockets[1]!.emit('message', wsd(`10.0.0.${n}`))
    await vi.advanceTimersByTimeAsync(3500)
    expect(fetch).toHaveBeenCalledTimes(10)
    expect(await pending).toHaveLength(10)
    c.discover.dispose()
    expect(['10.1.2.3', '172.16.0.1', '172.31.0.1', '192.168.1.1', '169.254.1.1'].every(privateIpv4)).toBe(true)
    expect(['172.32.0.1', '172.15.0.1', '192.169.1.1'].some(privateIpv4)).toBe(false)
  })
  it('aborts slow metadata at two seconds and finishes discovery on dispose', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetch: typeof globalThis.fetch = async (_url, opts) => {
      signals.push(opts!.signal!)
      return new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const c = make(fetch), pending = c.discover.discover()
    c.sockets[1]!.emit('message', wsd('192.168.1.31'))
    await vi.advanceTimersByTimeAsync(2000); expect(signals[0]!.aborted).toBe(true)
    c.sockets[1]!.emit('message', wsd('192.168.1.32'))
    c.discover.dispose()
    expect(signals[1]!.aborted).toBe(true)
    expect(await pending).toHaveLength(2)
    expect(await c.discover.discover()).toEqual([])
    expect(c.sockets.every((s) => s.close.mock.calls.length === 1)).toBe(true)
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('caps metadata response bodies and handles malformed datagrams without throwing', async () => {
    vi.useFakeTimers()
    const c = make(async () => new Response('x'.repeat(65537))), pending = c.discover.discover()
    c.sockets[1]!.emit('message', wsd('192.168.1.31'))
    c.sockets[0]!.emit('message', Buffer.from('garbage'))
    c.sockets[1]!.emit('message', Buffer.from('garbage'))
    await vi.advanceTimersByTimeAsync(3500)
    expect(await pending).toEqual([{ name: '192.168.1.31', host: '192.168.1.31', ip: '192.168.1.31' }])
    c.discover.dispose()
  })
})
