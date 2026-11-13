import { afterEach, describe, expect, it, vi } from 'vitest'
import { raceConnections, reachText } from '../../src/main/sources/plex/connections'
import type { PlexConnection } from '../../src/main/sources/plex/PlexTv'
import { deferred, jellyfinFetch, plexIdentity, until } from './helpers'

const connection = (uri: string, local = false, relay = false): PlexConnection => ({ uri, local, relay, IPv6: false })
const identity = (id = 'server'): unknown => ({ MediaContainer: { machineIdentifier: id } })
afterEach(() => vi.useRealTimers())
describe('Plex connection race', () => {
  it('waits for a better local HTTPS candidate after a remote answers first, then aborts losers', async () => {
    const local = deferred<unknown>(), relay = deferred<unknown>()
    const fake = jellyfinFetch(({ url }) => url.hostname === 'local.plex.direct' ? local.promise :
      url.hostname === 'relay.plex.direct' ? relay.promise : identity())
    let settled = false
    const pending = raceConnections({ clientIdentifier: 'server', connections: [
      connection('http://remote.plex.direct:32400'), connection('https://local.plex.direct:32400', true),
      connection('https://relay.plex.direct:32400', false, true),
    ] }, { ...plexIdentity, fetch: fake.fetch }).then((r) => { settled = true; return r })
    await until(() => fake.calls.length === 3)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    local.resolve(identity())
    expect(await pending).toEqual({ url: 'https://local.plex.direct:32400', tier: 'local' })
    expect(fake.calls[2]?.signal?.aborted).toBe(true)
    expect(fake.calls.every((c) => !c.headers.has('X-Plex-Token') && c.url.pathname === '/identity')).toBe(true)
    relay.resolve(identity())
  })
  it('ignores the wrong machine id and prefers local HTTP over remote and relay', async () => {
    const fake = jellyfinFetch(({ url }) => identity(url.protocol === 'https:' && url.hostname === 'local.plex.direct' ? 'wrong' : 'server'))
    expect(await raceConnections({ clientIdentifier: 'server', connections: [
      connection('https://local.plex.direct', true), connection('http://192.168.1.20:32400', true),
      connection('https://remote.plex.direct'), connection('https://relay.plex.direct', false, true),
    ] }, { ...plexIdentity, fetch: fake.fetch })).toEqual({ url: 'http://192.168.1.20:32400', tier: 'local' })
  })
  it.each(['192.168.1.20', 'fd00::20'])('falls back to the literal local address %s when plex.direct fails', async (address) => {
    const fake = jellyfinFetch(({ url }) => {
      if (url.hostname.endsWith('.plex.direct')) throw Error('DNS rebinding')
      return identity()
    })
    const result = await raceConnections({ clientIdentifier: 'server', connections: [{
      ...connection('https://home.plex.direct:32400', true), address, port: 32400,
    }] }, { ...plexIdentity, fetch: fake.fetch })
    expect(result).toEqual({ url: `http://${address.includes(':') ? `[${address}]` : address}:32400`, tier: 'local' })
    expect(fake.calls.every((r) => !r.headers.has('X-Plex-Token'))).toBe(true)
  })
  it('returns undefined after four seconds when nothing answers, and supports cancellation', async () => {
    vi.useFakeTimers()
    const fake = jellyfinFetch(() => new Promise(() => {}))
    const server = { clientIdentifier: 'server', connections: [connection('http://192.168.1.20:32400', true)] }
    const pending = raceConnections(server, { ...plexIdentity, fetch: fake.fetch })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toBeUndefined()
    const controller = new AbortController()
    const cancelled = raceConnections(server, { ...plexIdentity, fetch: fake.fetch, signal: controller.signal })
    controller.abort(); expect(await cancelled).toBeUndefined()
    expect(fake.calls.every((r) => r.signal?.aborted)).toBe(true)
    expect([reachText(), reachText({ url: '', tier: 'remote' }), reachText({ url: '', tier: 'relay' })]).toEqual([
      'Not reachable right now', 'Over the internet', 'Through Plex Relay (slow)',
    ])
  })
})
