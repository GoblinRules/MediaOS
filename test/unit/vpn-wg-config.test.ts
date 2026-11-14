import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { parseWireGuard, buildImportFile } from '../../src/main/vpn/wg-config'
import { Secret } from '../../src/main/vpn/secret'
import { configText, privateKey, publicKey, presharedKey } from '../fixtures/vpn/keys'

const parse = (text = configText()) => parseWireGuard(Buffer.from(text))
const good = (text = configText()) => {
  const result = parse(text)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result
}
describe('WireGuard import', () => {
  it('keeps only validated values, hiding private and preshared keys', () => {
    const result = good(configText() + `PresharedKey = ${presharedKey}\n`)
    expect(result.config).toMatchObject({ address: '10.14.0.2', dns: ['10.64.0.1'], mtu: null,
      peer: { endpointHost: 'gb.example.com', endpointPort: 51820, keepalive: 25, publicKey } })
    expect(result.config.privateKey.reveal()).toBe(privateKey)
    expect(result.config.peer.presharedKey?.reveal()).toBe(presharedKey)
    for (const text of [JSON.stringify(result), inspect(result), String(result.config.privateKey)]) {
      expect(text).not.toContain(privateKey); expect(text).not.toContain(presharedKey)
    }
    expect(new Secret(privateKey).toJSON()).toBe('[REDACTED]')
  })
  it.each(['Mullvad', 'Proton', 'IVPN', 'Surfshark', 'AirVPN', 'Windscribe'])('accepts %s style files', (provider) => {
    const additions: Record<string, string> = {
      Mullvad: 'Address = fd00::2/128\nDNS = 10.64.0.1', Proton: 'DNS = 10.2.0.1\nMTU = 1420',
      IVPN: 'DNS = 172.16.0.1', Surfshark: 'DNS = 162.252.172.57, 149.154.159.92',
      AirVPN: 'Address = fd7d:76ee:e68f:a993::2/128\nMTU = 1320', Windscribe: 'DNS = 10.255.255.1',
    }
    good(configText().replace('[Peer]', `${additions[provider]}\n[Peer]`) + 'PersistentKeepalive = 25\n')
  })
  it('accepts BOM, CRLF, comments, tabs and case-insensitive names', () => {
    const text = '\uFEFF# provider\n' + configText().replace('PrivateKey =', 'privatekey\t=')
      .replace('[Interface]', '[INTERFACE]').replace('51820', '51820 # comment PostUp = bad')
    expect(good(text.replace(/\n/g, '\r\n')).removed).toEqual([])
  })
  it('joins repeated lists and gives notices once in original order', () => {
    const text = configText().replace('[Peer]', 'PostUp = bad\npostup = worse\n[Peer]')
    expect(parse(text)).toEqual({ ok: false, error: 'not-wireguard' })
    const result = good(configText().replace('[Peer]',
      'PostUp = bad\nAddress = fd00::1/64, 10.0.0.3/8, fd00::2\nDNS = home, 1.1.1.1\nDNS = home, 8.8.8.8\n' +
      'MTU = 9000\nTable = auto\nPreUp = bad\n[Peer]') + 'PersistentKeepalive = 999\nFoo = bar\n')
    expect(result.removed).toEqual(['PostUp', 'Address (IPv6)', 'Address (extra)', 'DNS (search domain)',
      'MTU', 'Table', 'PreUp', 'PersistentKeepalive', 'Foo'])
    expect(result.config.dns).toEqual(['10.64.0.1', '1.1.1.1', '8.8.8.8'])
    expect(result.config.address).toBe('10.14.0.2')
    good(configText() + 'AllowedIPs = ::/0\n')
  })
  it.each(['PreUp', 'PostUp', 'PreDown', 'PostDown', 'Table', 'FwMark', 'SaveConfig', 'ListenPort', 'Unknown'])(
    'drops %s', (name) => expect(good(configText().replace('[Peer]', `${name} = ignored\n[Peer]`)).removed).toEqual([name]))
  it.each([1280, 1500, 1420])('keeps MTU %i', (mtu) =>
    expect(good(configText().replace('[Peer]', `MTU = ${mtu}\n[Peer]`)).config.mtu).toBe(mtu))
  it.each(['1279', '1501', '1.5', '-1', 'auto'])('drops bad MTU %s', (mtu) =>
    expect(good(configText().replace('[Peer]', `MTU = ${mtu}\n[Peer]`)).removed).toEqual(['MTU']))
  it.each([0, 120])('keeps keepalive %i', (value) =>
    expect(good(configText() + `PersistentKeepalive = ${value}`).config.peer.keepalive).toBe(value))
  it.each(['-1', '121', '2.5', 'yes'])('defaults bad keepalive %s', (value) => {
    const result = good(configText() + `PersistentKeepalive = ${value}`)
    expect(result.removed).toEqual(['PersistentKeepalive']); expect(result.config.peer.keepalive).toBe(25)
  })
  it.each([
    ['no-private-key', () => configText().replace(/^PrivateKey.*\n/m, '')],
    ['several-peers', () => configText() + '[Peer]\n'],
    ['not-full-tunnel', () => configText().replace('0.0.0.0/0', '10.0.0.0/8')],
    ['not-full-tunnel', () => configText().replace(/^AllowedIPs.*\n/m, '')],
    ['not-wireguard', () => configText().replace('[Interface]', '[unknown]')],
    ['not-wireguard', () => configText().replace('[Interface]', '# no interface')],
    ['not-wireguard', () => configText().split('[Peer]')[0]!],
    ['not-wireguard', () => configText().replace('Address = 10.14.0.2/16', 'Address = fd00::1/64')],
    ['not-wireguard', () => configText().replace('10.14.0.2/16', '10.14.0.2/33')],
    ['not-wireguard', () => configText().replace('10.14.0.2/16', '10.14.0.2/24/1')],
    ['not-wireguard', () => configText() + 'not a setting'],
    ['not-wireguard', () => configText() + `PublicKey = ${publicKey}\n`],
    ['not-wireguard', () => configText().replace(privateKey, 'bad')],
    ['not-wireguard', () => configText().replace(publicKey, 'bad')],
    ['not-wireguard', () => configText() + 'PresharedKey = bad'],
    ['not-wireguard', () => configText() + '#'.repeat(1025)],
    ['not-wireguard', () => configText() + '\n'.repeat(201)],
    ['not-wireguard', () => configText() + '\u0000'],
    ['not-wireguard', () => configText() + '\u001b'],
    ['not-wireguard', () => configText() + '\r'],
    ['not-wireguard', () => configText().replace('0.0.0.0/0', 'invalid/0')],
  ] as const)('rejects %s (%#)', (error, make) => expect(parse(make())).toEqual({ ok: false, error }))
  it.each(['[::1]:12', 'host name:12', 'host:12:13', 'host:0', 'host:65536', 'a..b:12', ':12', 'host:\nPostUp=bad'])(
    'rejects Endpoint %s', (endpoint) =>
      expect(parse(configText().replace('gb.example.com:51820', endpoint))).toEqual({ ok: false, error: 'not-wireguard' }))
  it('rejects invalid UTF-8 and input above 16 KB', () => {
    expect(parseWireGuard(Buffer.from([0xc3, 0x28]))).toEqual({ ok: false, error: 'not-wireguard' })
    expect(parseWireGuard(Buffer.alloc(16385))).toEqual({ ok: false, error: 'too-large' })
  })
  it('accepts exactly 200 lines and refuses empty or malformed list values', () => {
    const text = configText(), lines = text.split('\n').length - 1
    good(text + '#\n'.repeat(200 - lines))
    expect(parse(text + '#\n'.repeat(201 - lines))).toEqual({ ok: false, error: 'not-wireguard' })
    for (const value of ['0.0.0.0/0,', ',0.0.0.0/0', '0.0.0.0/0, ::/129']) {
      expect(parse(text.replace('0.0.0.0/0', value))).toEqual({ ok: false, error: 'not-wireguard' })
    }
    expect(parse(text.replace('10.14.0.2/16', ''))).toEqual({ ok: false, error: 'not-wireguard' })
  })
  it('rebuilds a defanged import using only allowlisted keys', () => {
    const result = good(configText().replace('[Peer]', 'MTU = 1400\nPostUp = evil\n[Peer]') +
      `PresharedKey = ${presharedKey}\n`)
    const output = buildImportFile(result.config)
    expect(output).toBe(`[Interface]\nPrivateKey = ${privateKey}\nAddress = 10.14.0.2/32\nMTU = 1400\n` +
      `Table = off\n\n[Peer]\nPublicKey = ${publicKey}\nPresharedKey = ${presharedKey}\n` +
      'AllowedIPs = 0.0.0.0/1, 128.0.0.0/1\nEndpoint = gb.example.com:51820\nPersistentKeepalive = 25\n')
    expect(output).not.toMatch(/DNS|PostUp|\r|0\.0\.0\.0\/0/)
  })
})
