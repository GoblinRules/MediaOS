import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TunnelResolver, type ResolverLike } from '../../src/main/vpn/proxy/resolver'
import { runtime } from '../../src/main/core/runtime'
import { redact } from '../../src/main/log/redact'
import { Logger } from '../../src/main/log/Logger'
import { configText, privateKey, presharedKey, key } from '../fixtures/vpn/keys'
import { temporary } from './helpers'

afterEach(() => vi.useRealTimers())
function setup(ttl = 60) {
  const instances: ResolverLike[] = []
  const factory = vi.fn(() => {
    const resolver = { setLocalAddress: vi.fn(), setServers: vi.fn(), cancel: vi.fn(),
      resolve4: vi.fn(async () => [{ address: '8.8.8.8', ttl }]) }
    instances.push(resolver); return resolver
  })
  const resolver = new TunnelResolver(runtime, factory)
  resolver.setTunnel({ tunIp: '10.14.0.2', dns: null })
  return { resolver, factory, instances }
}
describe('tunnel DNS', () => {
  it('binds before asking for A records and uses fallback DNS', async () => {
    const { resolver, instances } = setup()
    expect(instances[0]!.setLocalAddress).toHaveBeenCalledWith('10.14.0.2')
    expect(instances[0]!.setServers).toHaveBeenCalledWith(['9.9.9.9'])
    expect(await resolver.resolve('EXAMPLE.com')).toEqual(['8.8.8.8'])
    expect(instances[0]!.resolve4).toHaveBeenCalledWith('example.com', { ttl: true })
    resolver.setTunnel({ tunIp: '10.14.0.2', dns: '1.1.1.1' })
    expect(instances[0]!.cancel).toHaveBeenCalled()
    expect(instances[1]!.setServers).toHaveBeenCalledWith(['1.1.1.1'])
  })
  it.each([[1, 30], [60, 60], [1000, 300]])('clamps TTL %i to %i seconds', async (ttl, seconds) => {
    vi.useFakeTimers()
    const { resolver, instances } = setup(ttl)
    await resolver.resolve('Example.com'); await resolver.resolve('example.COM')
    expect(instances[0]!.resolve4).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(seconds * 1000 - 1); await resolver.resolve('example.com')
    expect(instances[0]!.resolve4).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1); await resolver.resolve('example.com')
    expect(instances[0]!.resolve4).toHaveBeenCalledTimes(2)
  })
  it('clears the cache on address or DNS change and refuses with no tunnel', async () => {
    const { resolver, factory } = setup()
    await resolver.resolve('example.com')
    resolver.setTunnel({ tunIp: '10.14.0.2', dns: null })
    expect(factory).toHaveBeenCalledTimes(1)
    resolver.setTunnel({ tunIp: '10.14.0.3', dns: null })
    await resolver.resolve('example.com')
    expect(factory).toHaveBeenCalledTimes(2)
    resolver.setTunnel({ tunIp: null, dns: null })
    await expect(resolver.resolve('example.com')).rejects.toThrow()
  })
  it('caps the cache at 1000 entries, evicting the oldest', async () => {
    const { resolver, instances } = setup()
    for (let i = 0; i < 1001; i++) await resolver.resolve(`h${i}.example`)
    await resolver.resolve('h1.example')
    expect(instances[0]!.resolve4).toHaveBeenCalledTimes(1001)
    await resolver.resolve('h0.example')
    expect(instances[0]!.resolve4).toHaveBeenCalledTimes(1002)
  })
  it('does not cache an old tunnel answer after a change', async () => {
    const { resolver, instances } = setup()
    let answer!: (value: { address: string; ttl: number }[]) => void
    vi.mocked(instances[0]!.resolve4).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const pending = resolver.resolve('example.com')
    resolver.setTunnel({ tunIp: '10.14.0.3', dns: null })
    answer([{ address: '8.8.8.8', ttl: 60 }])
    await expect(pending).rejects.toThrow('Tunnel changed')
    await resolver.resolve('example.com')
    expect(instances[1]!.resolve4).toHaveBeenCalledTimes(1)
  })
})

describe('VPN secret redaction and source boundaries', () => {
  it('redacts WireGuard, nmcli, mixed case and generic base64 assignments', async () => {
    const generated = key()
    const text = configText() + `PresharedKey = ${presharedKey}\nwireguard.private-key: ${privateKey}\n` +
      `wireguard.preshared-key: ${presharedKey}\npRiVaTeKeY: ${privateKey}\nother = ${generated}\nother: ${generated}`
    for (const secret of [privateKey, presharedKey, generated]) expect(redact(text)).not.toContain(secret)
    const temp = await temporary()
    try {
      const logger = new Logger(temp.dir)
      logger.info(text); logger.warn({ privateKey: privateKey, nested: text })
      await logger.close()
      const output = await readFile(join(temp.dir, 'mediaos.log'), 'utf8')
      for (const secret of [privateKey, presharedKey, generated]) expect(output).not.toContain(secret)
    } finally { await temp.dispose() }
  })
  it('has no Electron imports, system DNS calls, or production policy override', async () => {
    const folder = 'src/main/vpn/proxy'
    for (const file of await readdir(folder)) {
      if (!file.endsWith('.ts')) continue
      const text = await readFile(join(folder, file), 'utf8')
      expect(text).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*['"]electron['"]/)
      expect(text).not.toMatch(/\blookup\s*\(/)
      if (file === 'entry.ts') expect(text).not.toMatch(/\bpolicy\s*:/)
    }
  })
})
