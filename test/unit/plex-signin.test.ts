import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { RealSignInService } from '../../src/main/signin/RealSignInService'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../../src/main/sources/limits'
import { deferred, plexReplay, temporary, until } from './helpers'

const cleanup: (() => Promise<void>)[] = []
async function setup(override?: Parameters<typeof plexReplay>[0]) {
  const temp = await temporary()
  const settings = await SettingsStore.open(join(temp.dir, 'settings.json'))
  const secrets = await SecretStore.open(join(temp.dir, 'secrets.json'))
  const hub = new MediaHub(), fake = plexReplay(override), lines: unknown[][] = []
  const log = (...args: unknown[]): void => { lines.push(args) }
  let sequence = 0
  const service = new RealSignInService({ settings, secrets, hub, fetch: fake.fetch, appVersion: '2.3.4',
    id: () => `id-${++sequence}`, logger: { debug: log, info: log, warn: log, error: log } })
  cleanup.push(async () => { service.dispose(); hub.dispose(); await settings.flush(); await temp.dispose() })
  return { service, settings, secrets, hub, fake, lines }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
describe('Plex sign-in', () => {
  it('returns a short PIN without QR, polls at four second intervals, and caches owned-first choices with reach text', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'))
    let authenticated = false
    const { service, fake, lines } = await setup(({ url }) => url.pathname === '/api/v2/pins/71' ?
      { authToken: authenticated ? 'private-account' : null } : undefined)
    const start = await service.plexPin()
    expect(start).toEqual({ flowId: 'id-2', code: 'ABCD', where: 'plex.tv/link', expiresAt: '2026-11-13T12:10:00.000Z' })
    expect(await service.poll(start.flowId)).toEqual({ state: 'waiting' })
    authenticated = true
    await vi.advanceTimersByTimeAsync(3999)
    expect(await service.poll(start.flowId)).toEqual({ state: 'waiting' })
    expect(fake.calls.filter((c) => c.url.pathname === '/api/v2/pins/71')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const choices = await service.poll(start.flowId)
    expect(choices).toEqual({ state: 'chooseServers', servers: [
      { id: 'server-a', name: 'Home Plex', owned: true, reach: 'On this network' },
      { id: 'server-b', name: 'Aunt June', owned: false, reach: 'Over the internet' },
    ] })
    const count = fake.calls.length
    expect(await service.poll(start.flowId)).toEqual(choices)
    expect(fake.calls).toHaveLength(count)
    expect(fake.calls.every((c) => c.headers.get('X-Plex-Client-Identifier') === 'id-1')).toBe(true)
    expect(fake.calls.filter((c) => c.url.pathname === '/identity').every((c) => !c.headers.has('X-Plex-Token'))).toBe(true)
    expect(JSON.stringify([start, choices, lines])).not.toMatch(/private-|ABCD.*ABCD/)
    expect(JSON.stringify(lines)).not.toContain('ABCD')
  })
  it('expires PINs on 404 or their own deadline, caps expiry at thirty minutes, and returns plain poll errors', async () => {
    vi.useFakeTimers()
    const expired = await setup(({ url }) => url.pathname === '/api/v2/pins/71' ? new Response(null, { status: 404 }) : undefined)
    expect(await expired.service.poll((await expired.service.plexPin()).flowId)).toEqual({ state: 'expired' })
    const capped = await setup(({ url, method }) => method === 'POST' && url.pathname === '/api/v2/pins' ?
      { id: 71, code: 'ABCD', expiresAt: new Date(Date.now() + 3600_000).toISOString() } : undefined)
    const start = await capped.service.plexPin()
    expect(Date.parse(start.expiresAt) - Date.now()).toBe(1800_000)
    await vi.advanceTimersByTimeAsync(1800_000)
    expect(await capped.service.poll(start.flowId)).toEqual({ state: 'expired' })
    await expect(capped.service.plexAddServers(start.flowId, [])).rejects.toMatchObject({ code: 'auth',
      message: 'That sign-in has expired. Sign in again.' })
    const failed = await setup(({ url }) => url.pathname === '/api/v2/pins/71' ? new Response(null, { status: 503 }) : undefined)
    expect(await failed.service.poll((await failed.service.plexPin()).flowId)).toEqual({ state: 'error',
      message: 'Something went wrong on Plex. Try again in a moment.' })
  })
  it('accepts an empty server list, falls back to the account token and user title, and probes servers in parallel', async () => {
    const empty = await setup(({ url }) => url.hostname === 'clients.plex.tv' ? [] : undefined)
    expect(await empty.service.poll((await empty.service.plexPin()).flowId)).toEqual({ state: 'chooseServers', servers: [] })
    const gates = [deferred<unknown>(), deferred<unknown>()]
    const pending = await setup(({ url }) => {
      if (url.pathname === '/identity') return gates[url.hostname === 'home-a.plex.direct' ? 0 : 1]!.promise
      if (url.pathname === '/api/v2/user') return { id: '42', title: 'Maya' }
      if (url.hostname === 'clients.plex.tv') return [
        { clientIdentifier: 'server-a', name: 'Home', owned: true, provides: 'server',
          connections: [{ uri: 'https://home-a.plex.direct:32400', local: true }] },
        { clientIdentifier: 'server-b', name: 'Away', provides: 'server',
          connections: [{ uri: 'https://remote-b.plex.direct:32400', relay: true }] },
      ]
    })
    const flow = await pending.service.plexPin(), result = pending.service.poll(flow.flowId)
    await until(() => pending.fake.calls.filter((c) => c.url.pathname === '/identity').length === 2)
    gates[0]!.resolve({ MediaContainer: { machineIdentifier: 'server-a' } })
    gates[1]!.resolve({ MediaContainer: { machineIdentifier: 'server-b' } })
    expect(await result).toMatchObject({ state: 'chooseServers', servers: [
      { id: 'server-a', reach: 'On this network' }, { id: 'server-b', reach: 'Through Plex Relay (slow)' },
    ] })
    const [source] = await pending.service.plexAddServers(flow.flowId, ['server-a'])
    expect(pending.secrets.get(source!.id)?.token).toBe('private-account')
    expect(source?.userName).toBe('Maya')
  })
  it('saves two servers one at a time with secret first, deduplicates requested ids and repeated calls, and keeps secrets private', async () => {
    const { service, settings, secrets, hub, lines } = await setup()
    const flow = await service.plexPin(), choices = await service.poll(flow.flowId)
    const events: string[] = []
    const set = secrets.set.bind(secrets), update = settings.update.bind(settings), add = hub.add.bind(hub)
    vi.spyOn(secrets, 'set').mockImplementation(async (id, secret) => { events.push('secret'); await set(id, secret) })
    vi.spyOn(settings, 'update').mockImplementation((patch) => { events.push('settings'); return update(patch) })
    vi.spyOn(hub, 'add').mockImplementation((source) => { events.push('hub'); add(source) })
    const sources = await service.plexAddServers(flow.flowId, ['server-b', 'server-a', 'server-b'])
    expect(sources.map((s) => s.name)).toEqual(['Aunt June', 'Home Plex'])
    expect(events).toEqual(['secret', 'settings', 'hub', 'secret', 'settings', 'hub'])
    expect(settings.get().sources).toHaveLength(2)
    for (const source of sources) {
      expect(secrets.get(source.id)).toEqual({ token: source.name === 'Home Plex' ? 'private-server-a' : 'private-server-b',
        accountToken: 'private-account', clientId: 'id-1' })
      expect(hub.get(source.id)?.info().status).toBe('ok')
      expect(await hub.get(source.id)!.libraries()).toHaveLength(2)
    }
    expect(await service.plexAddServers(flow.flowId, ['server-b', 'server-a'])).toEqual(sources)
    expect(events).toHaveLength(6)
    expect(JSON.stringify([settings.get(), choices, sources, lines])).not.toMatch(/private-|accessToken|accountToken/)
  })
  it('validates all ids and the entire selection limit before saving, and counts only new identities', async () => {
    const { service, settings, secrets } = await setup()
    const flow = await service.plexPin()
    await expect(service.plexAddServers(flow.flowId, ['server-a'])).rejects.toMatchObject({ code: 'auth' })
    await service.poll(flow.flowId)
    const write = vi.spyOn(secrets, 'set')
    await expect(service.plexAddServers(flow.flowId, ['server-a', 'unknown'])).rejects.toMatchObject({ code: 'notFound',
      message: 'Choose a server from the list.' })
    const fillers = Array.from({ length: MAX_SOURCES - 1 }, (_, i) => ({
      id: `filler-${i}`, kind: 'fixture' as const, name: 'Other', enabled: true,
    }))
    settings.update({ sources: fillers })
    await expect(service.plexAddServers(flow.flowId, ['server-a', 'server-b'])).rejects.toMatchObject({ code: 'unsupported',
      message: SOURCE_LIMIT_MESSAGE })
    expect(write).not.toHaveBeenCalled()
    const [original] = await service.plexAddServers(flow.flowId, ['server-a'])
    const again = await service.plexPin(); await service.poll(again.flowId)
    const [replacement] = await service.plexAddServers(again.flowId, ['server-a'])
    expect(replacement?.id).toBe(original?.id)
    expect(settings.get().sources).toHaveLength(MAX_SOURCES)
    expect(settings.get().sources.filter((s) => s.kind === 'plex')).toHaveLength(1)
  })
  it('keeps successful earlier servers after a later secret failure, then retries only the failed server', async () => {
    const { service, secrets, settings, hub } = await setup()
    const flow = await service.plexPin(); await service.poll(flow.flowId)
    const set = secrets.set.bind(secrets)
    vi.spyOn(secrets, 'set').mockImplementationOnce(set).mockRejectedValueOnce(Error('private-token disk full'))
    await expect(service.plexAddServers(flow.flowId, ['server-a', 'server-b'])).rejects.toMatchObject({ code: 'server',
      message: "Couldn't save the sign-in. Try again." })
    expect(settings.get().sources).toHaveLength(1); expect(hub.list()).toHaveLength(1)
    const [first, second] = await service.plexAddServers(flow.flowId, ['server-a', 'server-b'])
    expect(first?.id).toBe(settings.get().sources[0]?.id)
    expect(second?.id).not.toBe(first?.id)
    expect(settings.get().sources).toHaveLength(2)
  })
  it('rolls back settings/secret flush failures and cancelled saves without changing the hub', async () => {
    const { service, secrets, settings, hub } = await setup()
    const flow = await service.plexPin(); await service.poll(flow.flowId)
    const write = vi.spyOn(secrets, 'set')
    vi.spyOn(settings, 'flush').mockRejectedValueOnce(Error('disk full'))
    await expect(service.plexAddServers(flow.flowId, ['server-a'])).rejects.toMatchObject({ code: 'server' })
    expect(settings.get().sources).toEqual([]); expect(hub.list()).toEqual([])
    expect(secrets.get(write.mock.calls[0]![0])).toBeUndefined()
    const gate = deferred<void>(), set = secrets.set.bind(secrets)
    let writing = false
    write.mockImplementationOnce(async (id, secret) => { await set(id, secret); writing = true; await gate.promise })
    const result = expect(service.plexAddServers(flow.flowId, ['server-a'])).rejects.toMatchObject({ code: 'auth' })
    await until(() => writing)
    await service.cancel(flow.flowId); gate.resolve(); await result
    expect(settings.get().sources).toEqual([]); expect(hub.list()).toEqual([])
    expect(secrets.get(write.mock.calls.at(-1)![0])).toBeUndefined()
  })
  it('deduplicates concurrent polls/adds and aborts pending account calls on cancel, cancelAll and dispose', async () => {
    const normal = await setup()
    const flow = await normal.service.plexPin(); await normal.service.poll(flow.flowId)
    const [a, b] = await Promise.all([normal.service.plexAddServers(flow.flowId, ['server-a']),
      normal.service.plexAddServers(flow.flowId, ['server-a'])])
    expect(a).toEqual(b); expect(normal.settings.get().sources).toHaveLength(1)
    for (const stop of ['cancel', 'cancelAll', 'dispose'] as const) {
      const gated = await setup(({ url }) => url.pathname === '/api/v2/pins/71' ? new Promise(() => {}) : undefined)
      const start = await gated.service.plexPin(), poll = gated.service.poll(start.flowId)
      expect(await gated.service.poll(start.flowId)).toEqual({ state: 'waiting' })
      if (stop === 'cancel') await gated.service.cancel(start.flowId)
      else gated.service[stop]()
      expect(await poll).toEqual({ state: 'expired' })
      expect(gated.fake.calls.find((c) => c.url.pathname === '/api/v2/pins/71')?.signal?.aborted).toBe(true)
      expect(gated.settings.get().sources).toEqual([])
    }
  })
})
