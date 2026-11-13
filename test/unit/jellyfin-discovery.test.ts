import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverJellyfin, type DiscoverySocket } from '../../src/main/sources/jellyfin/discovery'
import { runtime } from '../../src/main/core/runtime'

class Socket extends EventEmitter implements DiscoverySocket {
  closed = false
  broadcast = false
  sent: unknown[] = []
  bind(_port: number, ready: () => void): void { ready() }
  setBroadcast(flag: boolean): void { this.broadcast = flag }
  send(message: string, port: number, address: string, cb: (error: Error | null) => void): void {
    this.sent.push([message, port, address]); cb(null)
  }
  close(): void { this.closed = true }
}
afterEach(() => vi.useRealTimers())
describe('Jellyfin discovery', () => {
  it('keeps the first address and bounds datagrams, server count, names and addresses', async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const result = discoverJellyfin({ socketFactory: () => socket, clock: runtime })
    const reply = (Id: string, Name: string, Address = 'http://harbour:8096'): void => {
      socket.emit('message', Buffer.from(JSON.stringify({ Id, Name, Address }), 'utf8'))
    }
    reply('first', 'n'.repeat(81))
    reply('first', 'Imposter', 'http://elsewhere:8096')
    reply('packet', 'x'.repeat(4096))
    reply('address', 'Bad address', `http://harbour/${'x'.repeat(2048)}`)
    for (let i = 0; i < 33; i++) reply(`s-${i}`, `Server ${i}`)
    await vi.advanceTimersByTimeAsync(2500)
    const servers = await result
    expect(servers).toHaveLength(32)
    expect(servers.find((s) => s.id === 'first')).toEqual({ id: 'first', name: 'n'.repeat(80), url: 'http://harbour:8096' })
    expect(servers.some((s) => ['packet', 'address', 's-31', 's-32'].includes(s.id))).toBe(false)
  })
  it('broadcasts, ignores junk and non-http replies, de-duplicates ids and sorts names before closing', async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const result = discoverJellyfin({ socketFactory: () => socket, clock: runtime })
    const reply = (raw: unknown): void => { socket.emit('message', Buffer.from(JSON.stringify(raw), 'utf8')) }
    reply({ Id: 'z', Name: 'Zebra', Address: 'http://zebra:8096' })
    reply({ Id: 'a', Name: 'Attic', Address: 'https://attic/jellyfin/' })
    reply({ Id: 'z', Name: 'Zebra', Address: 'http://zebra:8096/' })
    reply({ Id: 'bad', Name: 'Bad', Address: 'file:///tmp/file' })
    reply(null)
    socket.emit('message', Buffer.from('not JSON', 'utf8'))
    expect(socket.broadcast).toBe(true)
    expect(socket.sent).toEqual([['Who is JellyfinServer?', 7359, '255.255.255.255']])
    await vi.advanceTimersByTimeAsync(2500)
    expect(await result).toEqual([{ id: 'a', name: 'Attic', url: 'https://attic/jellyfin' },
      { id: 'z', name: 'Zebra', url: 'http://zebra:8096' }])
    expect(socket.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('returns collected results on socket errors, including an error before any reply', async () => {
    for (const collected of [false, true]) {
      const socket = new Socket()
      const result = discoverJellyfin({ socketFactory: () => socket })
      if (collected) socket.emit('message', Buffer.from(JSON.stringify({ Id: 'a', Name: 'Attic', Address: 'http://attic:8096' })))
      socket.emit('error', Error('Network is down'))
      expect(await result).toEqual(collected ? [{ id: 'a', name: 'Attic', url: 'http://attic:8096' }] : [])
      expect(socket.closed).toBe(true)
    }
  })
  it('closes the socket and clears the discovery timeout when cancelled', async () => {
    vi.useFakeTimers()
    const socket = new Socket()
    const controller = new AbortController()
    const result = discoverJellyfin({ socketFactory: () => socket, clock: runtime, signal: controller.signal })
    controller.abort()
    expect(await result).toEqual([])
    expect(socket.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
