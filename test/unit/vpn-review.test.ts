import { describe, expect, it, vi } from 'vitest'
import { validTunnelAddress } from '../../src/main/vpn/proxy/target-policy'
import { VpnProxy } from '../../src/main/vpn/proxy/VpnProxy'
import { TunnelResolver } from '../../src/main/vpn/proxy/resolver'
import { parentMessage } from '../../src/main/vpn/proxy/messages'
import { clientUid, readClientUid } from '../../src/main/vpn/proxy/proc-net-tcp'
import { parseWireGuard } from '../../src/main/vpn/wg-config'
import { readZipConfs } from '../../src/main/vpn/zip-reader'
import { suggestLabel } from '../../src/main/vpn/server-groups'
import { Socks5Parser } from '../../src/main/vpn/proxy/socks5'
import { configText, privateKey } from '../fixtures/vpn/keys'
import { zip } from '../fixtures/vpn/zip'
import { runtime } from '../../src/main/core/runtime'

const parse = (text: string) => parseWireGuard(Buffer.from(text))
const bad = { ok: false, error: 'not-wireguard' }
const controls = '\u0000\u001f\u007f\u0085\u009f\u200e\u200f\u202a\u202b\u202c\u202d\u202e' +
  '\u2066\u2067\u2068\u2069'

describe('review: tunnel addresses at every boundary', () => {
  it.each(['0.0.0.0', '0.1.2.3', '127.0.0.1', '224.0.0.1', '255.255.255.255', 'host', '01.2.3.4', '::1'])(
    'refuses %s for the tunnel and DNS', (ip) => {
      const proxy = new VpnProxy({ uid: null, resolve: async () => [], peerUid: async () => 'skip' })
      const resolver = new TunnelResolver()
      expect(validTunnelAddress(ip)).toBe(false)
      for (const tunnel of [{ tunIp: ip, dns: null }, { tunIp: '10.2.0.2', dns: ip }]) {
        expect(() => proxy.setTunnel(tunnel)).toThrow()
        expect(() => resolver.setTunnel(tunnel)).toThrow()
        expect(parentMessage.safeParse({ type: 'tunnel', ...tunnel }).success).toBe(false)
      }
      expect(parse(configText().replace('10.14.0.2/16', `${ip}/32`))).toEqual(bad)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('01.')) {
        const result = parse(configText().replace('10.64.0.1', ip))
        expect(result).toMatchObject({ ok: true, removed: ['DNS (invalid)'], config: { dns: [] } })
      }
    })
  it.each(['10.2.0.2', '100.64.1.2'])('allows provider address %s at every boundary', (ip) => {
    const proxy = new VpnProxy({ uid: null, resolve: async () => [], peerUid: async () => 'skip' })
    const factory = vi.fn(() => ({ setLocalAddress: vi.fn(), setServers: vi.fn(), cancel: vi.fn(),
      resolve4: async () => [] }))
    const resolver = new TunnelResolver(runtime, factory), tunnel = { tunIp: ip, dns: ip }
    expect(validTunnelAddress(ip)).toBe(true)
    expect(() => proxy.setTunnel(tunnel)).not.toThrow()
    expect(() => resolver.setTunnel(tunnel)).not.toThrow()
    expect(factory.mock.results[0]!.value.setLocalAddress).toHaveBeenCalledWith(ip)
    expect(factory.mock.results[0]!.value.setServers).toHaveBeenCalledWith([ip])
    expect(parentMessage.safeParse({ type: 'tunnel', ...tunnel }).success).toBe(true)
    expect(parse(configText().replace('10.14.0.2', ip).replace('10.64.0.1', ip)))
      .toMatchObject({ ok: true, config: { address: ip, dns: [ip] } })
  })
  it('rejects invalid extra interface addresses too', () => {
    expect(parse(configText().replace('[Peer]', 'Address = 0.0.0.0/32\n[Peer]'))).toEqual(bad)
  })
})

describe('review: safe import display text and parser guards', () => {
  it('caps removed setting names at 40 characters and the list at 20 names', () => {
    const names = Array.from({ length: 25 }, (_, n) => `Unknown${n}${'x'.repeat(50)}`)
    const result = parse(configText().replace('[Peer]', names.map((name) => `${name} = ignored\n`).join('') + '[Peer]'))
    expect(result).toMatchObject({ ok: true, removed: names.slice(0, 20).map((name) => name.slice(0, 40)) })
  })
  it('cleans zip names, caps them at 64 code points and skips names cleaned to empty', () => {
    const prefix = 'x'.repeat(63) + '😀'
    expect(readZipConfs(zip([{ name: `${controls}.conf` }, { name: `folder/${controls}${prefix}tail.conf` }])))
      .toMatchObject({ ok: true, entries: [{ name: prefix }] })
    expect(readZipConfs(zip([{ name: `${controls}.conf` }]))).toEqual(bad)
  })
  it('cleans labels and preserves an emoji at code point 24', () => {
    const label = 'x'.repeat(23) + '😀'
    expect(suggestLabel(` ${controls}${label}extra `)).toBe(label)
    expect(suggestLabel(controls)).toBe('VPN')
    expect(suggestLabel(`${controls} UK ${controls}`)).toBe('UK')
  })
  it('refuses non-canonical base64 keys with non-zero spare bits', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const nonCanonical = privateKey.slice(0, -2) + alphabet[alphabet.indexOf(privateKey.at(-2)!) + 1]! + '='
    expect(Buffer.from(nonCanonical, 'base64')).toEqual(Buffer.from(privateKey, 'base64'))
    expect(parse(configText().replace(privateKey, nonCanonical))).toEqual(bad)
  })
  it('refuses two Interface sections', () => {
    expect(parse(configText().replace('[Peer]', '[Interface]\n[Peer]'))).toEqual(bad)
  })
  it.each([6, 8])('refuses a local zip header with mismatched field at %i', (offset) => {
    const input = zip([{ name: 'gb.conf' }])
    input.writeUInt16LE(offset === 6 ? 0x800 : 8, offset)
    expect(readZipConfs(input)).toEqual(bad)
  })
  it.each(['request', 'reply', 'greeting failure', 'silent failure'])(
    'never resumes parsing after %s', (result) => {
      const parser = new Socks5Parser()
      if (result === 'greeting failure') expect(parser.feed(Buffer.from([5, 1, 2])).type).toBe('reply')
      else if (result === 'silent failure') expect(parser.feed(Buffer.from([4])).type).toBe('close')
      else {
        expect(parser.feed(Buffer.from([5, 1, 0])).type).toBe('greeting')
        expect(parser.feed(Buffer.from([5, result === 'request' ? 1 : 2, 0, 1, 8, 8, 8, 8, 0, 80])).type).toBe(result)
      }
      expect(parser.feed(Buffer.from([5, 1, 0]))).toEqual({ type: 'close' })
      expect(parser.feed(Buffer.alloc(0))).toEqual({ type: 'close' })
    })
})

describe('review: Linux peer ownership', () => {
  const line = (uid: number, state = '01', mapped = false): string => {
    const ip = mapped ? '0000000000000000FFFF00000100007F' : '0100007F'
    return `  12: ${ip}:AFC8 ${ip}:9234 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 23456 1\n`
  }
  it('ignores TIME_WAIT rows and accepts duplicate established rows with one uid', () => {
    expect(clientUid(line(2000, '06') + line(1000), line(1000, '01', true), 45000, 37428)).toBe(1000)
    expect(clientUid(line(2000, '06'), '', 45000, 37428)).toBeNull()
  })
  it('refuses ambiguous established owners within or across tables', () => {
    expect(clientUid(line(1000) + line(2000), '', 45000, 37428)).toBeNull()
    expect(clientUid(line(1000), line(2000, '01', true), 45000, 37428)).toBeNull()
  })
  it('works without tcp6, reads mapped tcp6 and fails closed if tcp cannot be read', async () => {
    const read = vi.fn(async (path: string, encoding: 'utf8') => {
      expect(encoding).toBe('utf8')
      if (path.endsWith('tcp6')) throw new Error('ENOENT')
      return line(1000)
    })
    expect(await readClientUid(45000, 37428, read)).toBe(1000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(await readClientUid(45000, 37428, async (path) => path.endsWith('tcp6') ? line(1000, '01', true) : '')).toBe(1000)
    expect(await readClientUid(45000, 37428, async () => { throw new Error('EACCES') })).toBeNull()
  })
})
