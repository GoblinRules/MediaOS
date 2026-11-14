import { describe, expect, it } from 'vitest'
import { Socks5Parser, reply } from '../../src/main/vpn/proxy/socks5'
import { refusedIPv4, refusedDomain } from '../../src/main/vpn/proxy/target-policy'
import { clientUid } from '../../src/main/vpn/proxy/proc-net-tcp'
import { groupServers, suggestLabel } from '../../src/main/vpn/server-groups'
import { childMessage, parentMessage } from '../../src/main/vpn/proxy/messages'

const greeting = Buffer.from([5, 1, 0])
const domain = (host: string, port = 443): Buffer => Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]),
  Buffer.from(host), Buffer.from([port >> 8, port & 255])])
const parser = () => { const p = new Socks5Parser(); expect(p.feed(greeting).type).toBe('greeting'); return p }
describe('SOCKS5 incremental parser', () => {
  it('handles every packet split and extra payload', () => {
    const request = domain('example.com'), extra = Buffer.from('payload')
    for (let split = 0; split < request.length; split++) {
      const p = parser()
      expect(p.feed(request.subarray(0, split))).toEqual({ type: 'more' })
      expect(p.feed(Buffer.concat([request.subarray(split), extra]))).toEqual({ type: 'request',
        request: { kind: 'domain', host: 'example.com', port: 443 }, extra })
    }
    const p = new Socks5Parser()
    for (const byte of [5, 2, 1]) expect(p.feed(Buffer.from([byte]))).toEqual({ type: 'more' })
    expect(p.feed(Buffer.from([0]))).toEqual({ type: 'greeting', data: Buffer.from([5, 0]) })
  })
  it('preserves pipelined requests and treats IPv4 domains as literals', () => {
    const p = new Socks5Parser()
    expect(p.feed(Buffer.concat([greeting, domain('8.8.8.8')]))).toEqual({ type: 'greeting', data: Buffer.from([5, 0]) })
    expect(p.feed(Buffer.alloc(0))).toMatchObject({ type: 'request', request: { kind: 'ipv4', host: '8.8.8.8' } })
    expect(parser().feed(Buffer.from([5, 1, 0, 1, 8, 8, 4, 4, 0, 80]))).toMatchObject({ type: 'request',
      request: { kind: 'ipv4', host: '8.8.4.4', port: 80 } })
  })
  it.each([0, 4, 22, 71])('closes silently on first byte %i', (byte) =>
    expect(new Socks5Parser().feed(Buffer.from([byte]))).toEqual({ type: 'close' }))
  it('refuses greetings without no-auth, including empty methods', () => {
    for (const bytes of [[5, 1, 2], [5, 0]]) expect(new Socks5Parser().feed(Buffer.from(bytes)))
      .toEqual({ type: 'reply', data: Buffer.from([5, 255]) })
  })
  it.each([
    [[5, 2, 0, 1], 7], [[5, 3, 0, 1], 7], [[5, 1, 0, 4], 2], [[5, 1, 0, 99], 8],
    [[5, 1, 0, 3, 0], 4], [[5, 1, 0, 3, 254], 4], [[5, 1, 1, 1], 1],
  ])('refuses invalid request %#', (bytes, code) => expect(parser().feed(Buffer.from(bytes as number[])))
    .toEqual({ type: 'reply', data: reply(code as number) }))
  it.each(['a b.com', 'a/b', 'é.com', '\u0000', 'localhost', 'x.LocalHost', '2130706433', '0x7f.1'])(
    'refuses domain %s', (host) => expect(parser().feed(domain(host)).type).toBe('reply'))
  it('refuses port zero and excessive malformed handshake data', () => {
    expect(parser().feed(domain('example.com', 0))).toEqual({ type: 'reply', data: reply(2) })
    expect(parser().feed(Buffer.alloc(601, 5))).toEqual({ type: 'close' })
    // A valid handshake can carry arbitrarily sized application data without counting it as handshake bytes.
    expect(parser().feed(Buffer.concat([domain('example.com'), Buffer.alloc(1000)]))).toMatchObject({ type: 'request' })
  })
  it('never reveals the bound address in replies', () => {
    for (let code = 0; code <= 8; code++) expect([...reply(code)]).toEqual([5, code, 0, 1, 0, 0, 0, 0, 0, 0])
  })
})

describe('target policy', () => {
  it.each(['0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255', '100.64.0.0', '100.127.255.255',
    '127.0.0.0', '127.255.255.255', '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.168.0.0', '192.168.255.255', '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255', '::1', 'bad'])(
    'refuses %s', (ip) => expect(refusedIPv4(ip, null)).toBe(true))
  it.each(['1.0.0.0', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255',
    '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255',
    '192.169.0.0', '223.255.255.255'])('allows %s', (ip) => expect(refusedIPv4(ip, null)).toBe(false))
  it('refuses the tunnel itself and numeric hostname variants without DNS', () => {
    expect(refusedIPv4('8.8.8.8', '8.8.8.8')).toBe(true)
    for (const host of ['LOCALHOST', 'a.localhost.', '2130706433', '0x7f.1', '127.1', '0177.0.0.1']) {
      expect(refusedDomain(host)).toBe(true)
    }
    expect(refusedDomain('video123.example')).toBe(false)
  })
})

describe('Linux socket owner', () => {
  const line = (ip: string, uid = 1000) =>
    `  12: ${ip}:AFC8 ${ip}:9234 01 00000000:00000000 00:00000000 00000000 ${uid} 0 23456 1 0 100 0 0 10 0\n`
  const header = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
  it('reads IPv4 and IPv4-mapped tcp6 space-padded layouts', () => {
    expect(clientUid(header + line('0100007F'), '', 45000, 37428)).toBe(1000)
    expect(clientUid('', header + line('0000000000000000FFFF00000100007F', 1010), 45000, 37428)).toBe(1010)
  })
  it('matches the client direction, both ports and loopback addresses only', () => {
    expect(clientUid(line('0100007F'), '', 37428, 45000)).toBeNull()
    expect(clientUid(line('0200007F'), '', 45000, 37428)).toBeNull()
    expect(clientUid('', '', 45000, 37428)).toBeNull()
  })
})

describe('server list and messages', () => {
  it('groups country examples, orders names naturally and keeps original ids', () => {
    expect(groupServers(['GB#12', 'gb-lon-wg-001', 'us_nyc', 'UK#2', 'random', 'GB#3'])).toEqual([
      { country: 'GB', entries: [{ id: 'e3', name: 'UK#2' }, { id: 'e5', name: 'GB#3' },
        { id: 'e0', name: 'GB#12' }, { id: 'e1', name: 'gb-lon-wg-001' }].sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { numeric: true })) },
      { country: 'US', entries: [{ id: 'e2', name: 'us_nyc' }] },
      { country: '', entries: [{ id: 'e4', name: 'random' }] },
    ])
    expect(groupServers(['GB#12', 'GB#2'])[0]!.entries.map((e) => e.id)).toEqual(['e1', 'e0'])
    expect(groupServers(['FR2', 'uk_3', 'US4', 'gbr-name', 'London'])[0]!.country).toBe('FR')
    expect(groupServers(['gbr-name', 'London'])).toMatchObject([{ country: '' }])
    for (const group of groupServers(Array.from({ length: 1000 }, (_, i) => `gb${i}`))) {
      for (const entry of group.entries) expect(entry.id).toMatch(/^e\d{1,4}$/)
    }
    expect(() => groupServers(Array.from({ length: 10_001 }, () => 'gb1'))).toThrow(RangeError)
  })
  it('makes a safe, short label', () => {
    expect(suggestLabel('\u0000 \n UK\t ')).toBe('UK')
    expect(suggestLabel(' \n\u007f')).toBe('VPN')
    expect(suggestLabel('x'.repeat(30))).toHaveLength(24)
  })
  it('validates messages in both directions', () => {
    expect(parentMessage.safeParse({ type: 'start', port: 0, uid: null }).success).toBe(true)
    for (const message of [{ type: 'start', port: -1, uid: null }, { type: 'tunnel', tunIp: 'host', dns: null },
      { type: 'stop', surprise: true }, { type: 'start', port: 1, uid: -1 }]) {
      expect(parentMessage.safeParse(message).success).toBe(false)
    }
    expect(childMessage.safeParse({ type: 'listening', port: 65535 }).success).toBe(true)
    expect(childMessage.safeParse({ type: 'listening', port: 0 }).success).toBe(false)
    expect(childMessage.safeParse({ type: 'error', code: 'EADDRINUSE' }).success).toBe(true)
    expect(childMessage.safeParse({ type: 'error', code: 'message with host' }).success).toBe(false)
  })
})
