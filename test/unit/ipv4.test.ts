import { describe, expect, it } from 'vitest'
import { checkIpConfig, formatIpv4, maskToPrefix, parseIpv4, prefixToMask, sameSubnet } from '@shared/ipv4'
import { DNS_PRESETS, dnsPreset } from '@shared/dns-presets'
import { validateCall } from '@shared/ipc-contract'
import type { IpConfig } from '@shared/system-types'

const fixed = (over: Partial<Extract<IpConfig, { method: 'manual' }>> = {}): IpConfig => ({
  method: 'manual', address: '192.168.1.50', prefix: 24, gateway: '192.168.1.1', dns: { mode: 'router' }, ...over,
})

describe('parseIpv4 / formatIpv4', () => {
  it('round-trips ordinary addresses', () => {
    for (const ip of ['0.0.0.0', '192.168.1.50', '10.0.0.1', '255.255.255.255']) expect(formatIpv4(parseIpv4(ip)!)).toBe(ip)
  })
  it('refuses junk, leading zeros, out-of-range octets and wrong part counts', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', '1.2.3.4 ', 'a.b.c.d', '1..2.3', '1.2.3.1000']) {
      expect(parseIpv4(bad), bad).toBeUndefined()
    }
  })
})

describe('masks', () => {
  it('converts both ways for every prefix', () => {
    for (let p = 0; p <= 32; p++) expect(maskToPrefix(prefixToMask(p))).toBe(p)
    expect(prefixToMask(24)).toBe('255.255.255.0')
    expect(prefixToMask(30)).toBe('255.255.255.252')
  })
  it('refuses masks with gaps', () => {
    expect(maskToPrefix('255.0.255.0')).toBeUndefined()
    expect(maskToPrefix('255.255.255.1')).toBeUndefined()
    expect(maskToPrefix('nonsense')).toBeUndefined()
  })
  it('sameSubnet', () => {
    expect(sameSubnet('192.168.1.50', '192.168.1.1', 24)).toBe(true)
    expect(sameSubnet('192.168.2.50', '192.168.1.1', 24)).toBe(false)
    expect(sameSubnet('192.168.2.50', '192.168.1.1', 16)).toBe(true)
    expect(sameSubnet('x', '192.168.1.1', 24)).toBe(false)
  })
})

describe('checkIpConfig', () => {
  it('accepts sensible configs', () => {
    expect(checkIpConfig({ method: 'auto', dns: { mode: 'auto' } })).toBeUndefined()
    expect(checkIpConfig({ method: 'auto', dns: { mode: 'preset', preset: 'quad9' } })).toBeUndefined()
    expect(checkIpConfig(fixed())).toBeUndefined()
    expect(checkIpConfig(fixed({ dns: { mode: 'custom', servers: ['1.1.1.1', '192.168.1.2'] } }))).toBeUndefined()
    expect(checkIpConfig(fixed({ address: '10.0.3.7', prefix: 8, gateway: '10.0.0.1' }))).toBeUndefined()
  })
  it('enforces the DNS pairing rules', () => {
    expect(checkIpConfig(fixed({ dns: { mode: 'auto' } }))?.field).toBe('dns')
    expect(checkIpConfig({ method: 'auto', dns: { mode: 'router' } })?.field).toBe('dns')
  })
  it('refuses bad custom DNS', () => {
    expect(checkIpConfig(fixed({ dns: { mode: 'custom', servers: [] } }))?.field).toBe('dns')
    expect(checkIpConfig(fixed({ dns: { mode: 'custom', servers: ['1.1.1.1', '8.8.8.8', '9.9.9.9'] } }))?.field).toBe('dns')
    expect(checkIpConfig(fixed({ dns: { mode: 'custom', servers: ['127.0.0.1'] } }))?.field).toBe('dns')
    expect(checkIpConfig(fixed({ dns: { mode: 'custom', servers: ['1.1.1'] } }))?.field).toBe('dns')
  })
  it('refuses unusable addresses', () => {
    for (const address of ['0.1.2.3', '127.0.0.5', '169.254.1.5', '224.0.0.1', '255.255.255.255', 'x']) {
      expect(checkIpConfig(fixed({ address }))?.field, address).toBe('address')
    }
  })
  it('refuses the network and broadcast numbers', () => {
    expect(checkIpConfig(fixed({ address: '192.168.1.0' }))?.message).toMatch(/reserved by the network/)
    expect(checkIpConfig(fixed({ address: '192.168.1.255' }))?.message).toMatch(/reserved by the network/)
    expect(checkIpConfig(fixed({ address: '192.168.1.3', prefix: 30, gateway: '192.168.1.1' }))?.field).toBe('address')
    expect(checkIpConfig(fixed({ address: '192.168.1.2', prefix: 30, gateway: '192.168.1.1' }))).toBeUndefined()
  })
  it('refuses odd masks', () => {
    expect(checkIpConfig(fixed({ prefix: 7 }))?.field).toBe('mask')
    expect(checkIpConfig(fixed({ prefix: 31 }))?.field).toBe('mask')
    expect(checkIpConfig(fixed({ prefix: 24.5 }))?.field).toBe('mask')
  })
  it('refuses a router that is the box, off the subnet, or not a host', () => {
    expect(checkIpConfig(fixed({ gateway: '192.168.1.50' }))?.message).toMatch(/router's own address/)
    expect(checkIpConfig(fixed({ gateway: '192.168.2.1' }))?.field).toBe('gateway')
    expect(checkIpConfig(fixed({ gateway: '192.168.1.255' }))?.field).toBe('gateway')
    expect(checkIpConfig(fixed({ gateway: '127.0.0.1' }))?.field).toBe('gateway')
  })
  it('says what is wrong with typed addresses, in the words of the design', () => {
    const msg = (o: Partial<Extract<IpConfig, { method: 'manual' }>>) => checkIpConfig(fixed(o))?.message
    expect(msg({ address: '' })).toBe('Type an address for the box.')
    expect(msg({ address: '192.168.1' })).toMatch(/^That isn't a complete address/)
    expect(msg({ address: '192.168.1.050' })).toMatch(/^Leave out zeros/)
    expect(msg({ address: '192.168.1.0500' })).toMatch(/^That isn't a complete address/)
    expect(msg({ address: '127.0.0.5' })).toMatch(/can't be used on a home network/)
    expect(msg({ gateway: '' })).toMatch(/^Type your router's address/)
    expect(msg({ gateway: '192.168.2.1' })).toMatch(/^The router's address doesn't match/)
    expect(msg({ dns: { mode: 'custom', servers: [] } })).toMatch(/^Type at least one DNS server/)
  })
  it('messages are plain sentences', () => {
    const problem = checkIpConfig(fixed({ gateway: '192.168.2.1' }))!
    expect(problem.message).toMatch(/^[A-Z].*\.$/)
  })
})

describe('DNS presets', () => {
  it('has the three services with two IPv4 servers each, all valid', () => {
    expect(DNS_PRESETS.map((p) => p.id)).toEqual(['cloudflare', 'google', 'quad9'])
    for (const p of DNS_PRESETS) for (const ip of p.ipv4) expect(parseIpv4(ip), ip).toBeDefined()
    expect(dnsPreset('quad9').ipv4[1]).toBe('149.112.112.112')
  })
})

describe('network calls in the IPC contract', () => {
  it('accepts a valid fixed config and refuses extra fields, bad addresses and bad ids', () => {
    expect(validateCall('network.applyIp', ['wired', fixed()])).not.toHaveProperty('error')
    expect(validateCall('network.applyIp', ['wired', { ...fixed(), extra: 1 }])).toHaveProperty('error')
    expect(validateCall('network.applyIp', ['wired', fixed({ address: '192.168.1.256' })])).toHaveProperty('error')
    expect(validateCall('network.applyIp', ['wired', fixed({ address: '01.2.3.4' })])).toHaveProperty('error')
    expect(validateCall('network.applyIp', ['wired; rm -rf /', fixed()])).toHaveProperty('error')
    expect(validateCall('network.applyIp', ['--help', { method: 'auto', dns: { mode: 'auto' } }])).not.toHaveProperty('error')
    expect(validateCall('network.applyIp', ['wired', { method: 'auto', dns: { mode: 'custom', servers: [] } }])).toHaveProperty('error')
  })
  it('takes a Wi-Fi password of up to 63 characters, or a 64-digit hex key', () => {
    expect(validateCall('network.connect', ['Home', 'x'.repeat(63)])).not.toHaveProperty('error')
    expect(validateCall('network.connect', ['Home', 'aB3'.repeat(21) + 'f'])).not.toHaveProperty('error')
    expect(validateCall('network.connect', ['Home', 'x'.repeat(64)])).toHaveProperty('error')
    expect(validateCall('network.connect', ['Home', 'a'.repeat(65)])).toHaveProperty('error')
  })
  it('resetAll needs the confirmation word', () => {
    expect(validateCall('network.resetAll', ['AUTOMATIC'])).not.toHaveProperty('error')
    expect(validateCall('network.resetAll', [])).toHaveProperty('error')
  })
})
