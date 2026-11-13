import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { RealSignInService } from '../../src/main/signin/RealSignInService'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { SecretStore } from '../../src/main/settings/SecretStore'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../../src/main/sources/limits'
import { runtime } from '../../src/main/core/runtime'
import type { DiscoveredServer } from '../../src/shared/ipc-contract'
import { deferred, jellyfinReplay, temporary, until, type JellyfinRequest } from './helpers'

const cleanup: (() => Promise<void>)[] = []
async function setup(override?: (request: JellyfinRequest) => unknown | Promise<unknown>, discover?: () => Promise<DiscoveredServer[]>) {
  const temp = await temporary()
  const settings = await SettingsStore.open(join(temp.dir, 'settings.json'))
  const secrets = await SecretStore.open(join(temp.dir, 'secrets.json'))
  const hub = new MediaHub()
  const lines: unknown[][] = []
  const log = (...args: unknown[]): void => { lines.push(args) }
  const logger = { debug: log, info: log, warn: log, error: log }
  const state = { authenticated: false, token: 'private-access-token', authStatus: 200 }
  const fake = jellyfinReplay(async (request) => {
    const custom = await override?.(request)
    if (custom !== undefined) return custom
    const path = request.url.pathname
    if (path === '/QuickConnect/Initiate') return { Secret: 'private-quick-secret', Code: '123456' }
    if (path === '/QuickConnect/Connect') return { Authenticated: state.authenticated }
    if (path === '/Users/AuthenticateByName' || path === '/Users/AuthenticateWithQuickConnect') {
      return state.authStatus !== 200 ? new Response('private-access-token', { status: state.authStatus }) :
        { AccessToken: state.token, User: { Id: 'user-maya', Name: 'Maya' }, ServerId: 'server-harbour' }
    }
  })
  let sequence = 0
  const service = new RealSignInService({ hub, settings, secrets, logger, clock: runtime, fetch: fake.fetch,
    appVersion: '2.3.4', id: () => `id-${++sequence}`,
    discover: discover ?? (async () => [{ id: 's', name: 'Attic', url: 'http://attic:8096' }]) })
  cleanup.push(async () => { service.dispose(); hub.dispose(); await settings.flush(); await temp.dispose() })
  return { service, hub, settings, secrets, fake, state, lines }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe('real Jellyfin sign-in', () => {
  it.each([false, true])('rolls back only the failed source while another is removed (replacement: %s)', async (replacement) => {
    const { service, secrets, settings, state, hub } = await setup()
    if (replacement) await service.password('harbour', 'Maya', '')
    const original = settings.get().sources[0]
    const previousSecret = original ? secrets.get(original.id) : undefined
    settings.update({ sources: [...settings.get().sources,
      { id: 'server-b', name: 'Other server', kind: 'fixture', enabled: true },
      { id: 'server-c', name: 'Third server', kind: 'fixture', enabled: true }] })
    const gate = deferred<void>()
    let flushing = false
    vi.spyOn(settings, 'flush').mockImplementationOnce(async () => { flushing = true; await gate.promise })
    const write = vi.spyOn(secrets, 'set')
    state.token = 'replacement-token'
    const rejected = expect(service.password('harbour:9000', 'Maya', '')).rejects.toMatchObject({ code: 'server' })
    await until(() => flushing)
    settings.update({ sources: settings.get().sources.filter((s) => s.id !== 'server-b')
      .map((s) => s.id === 'server-c' ? { ...s, name: 'Renamed server' }
        : s.id === original?.id ? { ...s, name: 'Lounge', enabled: false } : s) })
    gate.reject(Error('disk full'))
    await rejected
    // The re-signed server keeps its old address but also the rename and switch-off made during the save.
    expect(settings.get().sources).toEqual([
      ...(original ? [{ ...original, name: 'Lounge', enabled: false }] : []),
      { id: 'server-c', name: 'Renamed server', kind: 'fixture', enabled: true },
    ])
    expect(secrets.get(write.mock.calls[0]![0])).toEqual(previousSecret)
    expect(hub.list().map((s) => s.id)).toEqual(original ? [original.id] : [])
    const persisted = JSON.parse(await readFile(settings.file, 'utf8')) as { sources: unknown[] }
    expect(persisted.sources).toEqual(settings.get().sources)
  })
  it('rolls back source settings and secrets when flushing sign-in settings fails', async () => {
    const { service, secrets, settings, state, hub } = await setup()
    const original = await service.password('harbour', 'Maya', '')
    const previousSources = settings.get().sources, previousSecret = secrets.get(original.id), previousSource = hub.get(original.id)
    state.token = 'replacement'
    vi.spyOn(settings, 'flush').mockRejectedValueOnce(Error('disk full'))
    await expect(service.password('harbour:9000', 'Maya', '')).rejects.toMatchObject({ code: 'server',
      message: "Couldn't save the sign-in. Try again." })
    expect(settings.get().sources).toEqual(previousSources)
    expect(secrets.get(original.id)).toEqual(previousSecret)
    expect(hub.get(original.id)).toBe(previousSource)
    settings.update({ sources: [] }); hub.remove(original.id); await secrets.delete(original.id)
    const write = vi.spyOn(secrets, 'set')
    vi.spyOn(settings, 'flush').mockRejectedValueOnce(Error('disk full'))
    await expect(service.password('harbour', 'Maya', '')).rejects.toMatchObject({ code: 'server' })
    expect(settings.get().sources).toEqual([]); expect(hub.list()).toEqual([])
    expect(write).toHaveBeenCalledOnce()
    expect(secrets.get(write.mock.calls[0]![0])).toBeUndefined()
  })
  it('rolls back a sign-in cancelled while its settings flush is in flight', async () => {
    const { service, settings, secrets, hub } = await setup()
    const gate = deferred<void>()
    const flush = settings.flush.bind(settings)
    let flushing = false
    vi.spyOn(settings, 'flush').mockImplementationOnce(async () => { flushing = true; await gate.promise; await flush() })
    const write = vi.spyOn(secrets, 'set')
    const rejected = expect(service.password('harbour', 'Maya', '')).rejects.toMatchObject({ code: 'auth' })
    await until(() => flushing)
    service.cancelAll(); gate.resolve()
    await rejected
    expect(settings.get().sources).toEqual([]); expect(hub.list()).toEqual([])
    expect(secrets.get(write.mock.calls[0]![0])).toBeUndefined()
    const persisted = JSON.parse(await readFile(settings.file, 'utf8')) as { sources: unknown[] }
    expect(persisted.sources).toEqual([])
  })
  it('fits long server and user names to the saved settings limits', async () => {
    const { service, settings } = await setup(({ url }) => url.pathname === '/System/Info/Public' ?
      { ServerName: 's'.repeat(301), Version: '10.9.0', Id: 'server' } : url.pathname === '/Users/AuthenticateByName' ?
        { AccessToken: 'token', User: { Id: 'user', Name: 'u'.repeat(301) } } : undefined)
    const source = await service.password('harbour', 'Maya', '')
    expect(source.name).toBe('s'.repeat(80))
    expect(settings.get().sources[0]?.userName).toBe('u'.repeat(200))
  })
  it('explains disabled Quick Connect after Initiate auth errors and names the probed host on network failures', async () => {
    let status = 401
    const { service } = await setup(({ url }) => url.pathname === '/QuickConnect/Initiate' ? new Response(null, { status }) : undefined)
    for (status of [401, 403]) await expect(service.quickConnect('harbour')).rejects.toMatchObject({ code: 'unsupported',
      message: 'Quick Connect is switched off on this server. Use your password, or switch it on in the Jellyfin dashboard.' })
    const offline = await setup(() => { throw Error('network failure') })
    await expect(offline.service.probe('http://user:password@harbour:8096/web?token=secret')).rejects.toMatchObject({
      code: 'offline', message: "Can't reach harbour. Check the server is switched on.",
    })
  })
  it('wraps discovery and normalises bare hosts, ports, paths, credentials, queries and web suffixes', async () => {
    const { service } = await setup(() => undefined)
    expect(await service.discover()).toEqual([{ id: 's', name: 'Attic', url: 'http://attic:8096' }])
    const probes = await setup(({ url }) => {
      if (url.pathname.endsWith('/System/Info/Public')) return { ServerName: 'Harbour', Version: '10.10.0', Id: 'server' }
      if (url.pathname.endsWith('/QuickConnect/Enabled')) return true
    })
    for (const [input, url] of [
      ['harbour', 'http://harbour:8096'], ['harbour:9000', 'http://harbour:9000'], ['harbour:80', 'http://harbour'],
      ['http://maya:password@harbour:8096/web/?token=private#hash', 'http://harbour:8096'],
      ['https://harbour/jellyfin/web', 'https://harbour/jellyfin'],
      ['http://harbour:8096/jellyfin/', 'http://harbour:8096/jellyfin'],
    ]) expect(await probes.service.probe(input!)).toEqual({ serverName: 'Harbour', version: '10.10.0', quickConnect: true, url })
    for (const bad of ['', 'http://', 'file:///server', 'http://bad host', 'host:99999']) {
      await expect(service.probe(bad)).rejects.toMatchObject({ code: 'unsupported',
        message: 'That server address is not valid. Check it and try again.' })
    }
  })
  it('rejects old versions and non-Jellyfin addresses and treats Quick Connect errors as disabled', async () => {
    let response: unknown = { ServerName: 'Old server', Version: '10.8.13', Id: 'old' }
    const { service } = await setup(({ url }) => url.pathname === '/System/Info/Public' ? response :
      url.pathname === '/QuickConnect/Enabled' ? new Response(null, { status: 500 }) : undefined)
    await expect(service.probe('harbour')).rejects.toMatchObject({ code: 'unsupported',
      message: 'This Jellyfin server is too old. Update it to version 10.9 or newer.' })
    response = { ServerName: 'New server', Version: '10.9.0', Id: 'new' }
    expect((await service.probe('harbour')).quickConnect).toBe(false)
    for (response of [{}, { ServerName: 'No version', Id: 'server' }, 'HTML', null]) {
      await expect(service.probe('harbour')).rejects.toMatchObject({ code: 'unsupported',
        message: "That address isn't a Jellyfin server." })
    }
  })
  it('polls Quick Connect at most once every four seconds, saves approval and returns the same completed source', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
    const { service, fake, state, settings, secrets, hub, lines } = await setup()
    const start = await service.quickConnect('harbour')
    expect(start).toMatchObject({ code: '123456', where: 'Jellyfin > Quick Connect', expiresAt: '2026-11-12T12:10:00.000Z' })
    expect(JSON.stringify(start)).not.toContain('private-quick-secret')
    expect(await service.poll(start.flowId)).toEqual({ state: 'waiting' })
    await vi.advanceTimersByTimeAsync(3999)
    state.authenticated = true
    expect(await service.poll(start.flowId)).toEqual({ state: 'waiting' })
    expect(fake.calls.filter((r) => r.url.pathname === '/QuickConnect/Connect')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const done = await service.poll(start.flowId)
    expect(done).toMatchObject({ state: 'done', source: { kind: 'jellyfin', name: 'Harbour Jellyfin', userName: 'Maya', status: 'ok' } })
    expect(await service.poll(start.flowId)).toEqual(done)
    expect(fake.calls.filter((r) => r.url.pathname === '/QuickConnect/Connect')).toHaveLength(2)
    const source = settings.get().sources[0]!
    expect(hub.get(source.id)?.info().status).toBe('ok')
    expect(secrets.get(source.id)).toEqual({ token: 'private-access-token', deviceId: 'id-2' })
    const authenticate = fake.calls.find((r) => r.url.pathname === '/Users/AuthenticateWithQuickConnect')!
    expect(authenticate.body).toEqual({ Secret: 'private-quick-secret' })
    expect(authenticate.headers.get('Authorization')).toContain('DeviceId="id-2"')
    expect(authenticate.headers.get('Authorization')).not.toContain('Token=')
    expect(JSON.stringify([settings.get(), done, lines])).not.toMatch(/private-access-token|private-quick-secret/)
  })
  it('handles Quick Connect disabled, local expiry and expired server codes', async () => {
    const disabled = await setup(({ url }) => url.pathname === '/QuickConnect/Enabled' ? false : undefined)
    await expect(disabled.service.quickConnect('harbour')).rejects.toMatchObject({ code: 'unsupported',
      message: 'Quick Connect is switched off on this server. Use a user name and password instead.' })
    vi.useFakeTimers()
    const expired = await setup()
    const start = await expired.service.quickConnect('harbour')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(await expired.service.poll(start.flowId)).toEqual({ state: 'expired' })
    expect(await expired.service.poll('unknown')).toEqual({ state: 'expired' })
    for (const status of [401, 404]) {
      const serverExpired = await setup(({ url }) => url.pathname === '/QuickConnect/Connect' ?
        new Response(null, { status }) : undefined)
      const flow = await serverExpired.service.quickConnect('harbour')
      expect(await serverExpired.service.poll(flow.flowId)).toEqual({ state: 'expired' })
    }
  })
  it('returns a plain poll error for server failures', async () => {
    const { service } = await setup(({ url }) => url.pathname === '/QuickConnect/Connect' ?
      new Response('private-quick-secret', { status: 500 }) : undefined)
    const flow = await service.quickConnect('harbour')
    expect(await service.poll(flow.flowId)).toEqual({ state: 'error',
      message: 'Something went wrong on Harbour Jellyfin. Try again in a moment.' })
  })
  it('signs in with a password and replaces a wrong-password response with the specified message', async () => {
    const { service, state, settings, secrets, fake, lines } = await setup()
    state.authStatus = 401
    await expect(service.password('harbour', 'Maya', 'private-password')).rejects.toMatchObject({ code: 'auth',
      message: "That user name or password didn't work." })
    expect(settings.get().sources).toHaveLength(0)
    state.authStatus = 200
    const result = await service.password('harbour', 'Maya', 'private-password')
    expect(result).toMatchObject({ status: 'ok', userName: 'Maya', url: 'http://harbour:8096' })
    const request = fake.calls.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.body).toEqual({ Username: 'Maya', Pw: 'private-password' })
    expect(request.headers.get('Authorization')).toContain('Version="2.3.4"')
    expect(secrets.get(result.id)?.token).toBe('private-access-token')
    expect(JSON.stringify([settings.get(), result, lines])).not.toMatch(/private-access-token|private-password/)
  })
  it('re-signs the same server and user in place, even at the source limit', async () => {
    const { service, settings, secrets, state, hub } = await setup()
    const original = await service.password('harbour', 'Maya', '')
    const oldSource = hub.get(original.id)
    const oldDisposed = vi.spyOn(oldSource!, 'dispose')
    settings.update({ sources: [...settings.get().sources, ...Array.from({ length: MAX_SOURCES - 1 }, (_, i) => ({
      id: `filler-${i}`, name: 'Other library', kind: 'fixture' as const, enabled: true,
    }))] })
    state.token = 'replacement-token'
    const result = await service.password('http://harbour:8096/web', 'Maya', '')
    expect(result.id).toBe(original.id)
    expect(settings.get().sources).toHaveLength(MAX_SOURCES)
    expect(settings.get().sources.filter((s) => s.kind === 'jellyfin')).toHaveLength(1)
    expect(secrets.get(result.id)?.token).toBe('replacement-token')
    expect(hub.get(result.id)).not.toBe(oldSource)
    expect(oldDisposed).toHaveBeenCalledOnce()
  })
  it('checks the source limit before writing a secret or adding anything', async () => {
    const { service, settings, secrets, hub } = await setup()
    settings.update({ sources: Array.from({ length: MAX_SOURCES }, (_, i) => ({
      id: `filler-${i}`, name: 'Other library', kind: 'fixture', enabled: true,
    })) })
    const save = vi.spyOn(secrets, 'set')
    await expect(service.password('harbour', 'Maya', '')).rejects.toMatchObject({ code: 'unsupported', message: SOURCE_LIMIT_MESSAGE })
    expect(save).not.toHaveBeenCalled()
    expect(settings.get().sources).toHaveLength(MAX_SOURCES)
    expect(hub.list()).toHaveLength(0)
  })
  it('awaits the secret write and settings persistence before adding to the hub or returning success', async () => {
    const { service, secrets, settings, hub } = await setup()
    const gate = deferred<void>()
    const saved = deferred<void>()
    const events: string[] = []
    const write = secrets.set.bind(secrets)
    vi.spyOn(secrets, 'set').mockImplementation(async (id, values) => {
      events.push('secret:start'); await gate.promise; await write(id, values); events.push('secret:done')
    })
    const update = settings.update.bind(settings)
    vi.spyOn(settings, 'update').mockImplementation((patch) => { events.push('settings'); return update(patch) })
    const flush = settings.flush.bind(settings)
    vi.spyOn(settings, 'flush').mockImplementation(async () => {
      events.push('flush:start'); await saved.promise; await flush(); events.push('flush:done')
    })
    const add = hub.add.bind(hub)
    vi.spyOn(hub, 'add').mockImplementation((source) => { events.push('hub'); add(source) })
    let done = false
    const result = service.password('harbour', 'Maya', '').then((source) => { done = true; return source })
    await until(() => events.length > 0)
    expect(settings.get().sources).toHaveLength(0)
    expect(hub.list()).toHaveLength(0)
    gate.resolve()
    await until(() => events.includes('flush:start'))
    expect(hub.list()).toHaveLength(0); expect(done).toBe(false)
    saved.resolve()
    const source = await result
    expect(events).toEqual(['secret:start', 'secret:done', 'settings', 'flush:start', 'flush:done', 'hub'])
    const persisted = JSON.parse(await readFile(settings.file, 'utf8')) as { sources: { id: string }[] }
    expect(persisted.sources[0]?.id).toBe(source.id)
    expect(secrets.get(source.id)?.token).toBe('private-access-token')
  })
  it('adds nothing when saving the secret fails, and strips secret-bearing native errors', async () => {
    const { service, secrets, settings, hub, lines } = await setup()
    vi.spyOn(secrets, 'set').mockRejectedValue(Error('disk write private-access-token failed'))
    await expect(service.password('harbour', 'Maya', '')).rejects.toMatchObject({ code: 'server',
      message: "Couldn't save the sign-in. Try again." })
    expect(settings.get().sources).toHaveLength(0)
    expect(hub.list()).toHaveLength(0)
    expect(JSON.stringify(lines)).not.toContain('private-access-token')
  })
  it('does not resurrect an existing source removed while its replacement secret was being saved', async () => {
    const { service, secrets, settings, hub } = await setup()
    const first = await service.password('harbour', 'Maya', '')
    const gate = deferred<void>()
    const write = secrets.set.bind(secrets)
    let saving = false
    vi.spyOn(secrets, 'set').mockImplementation(async (id, values) => {
      saving = true; await write(id, values); await gate.promise
    })
    const replacement = service.password('harbour', 'Maya', '')
    const rejected = expect(replacement).rejects.toMatchObject({ code: 'auth' })
    await until(() => saving)
    settings.update({ sources: [] }); hub.remove(first.id)
    await secrets.delete(first.id)
    gate.resolve()
    await rejected
    expect(settings.get().sources).toHaveLength(0)
    expect(hub.list()).toHaveLength(0)
    expect(secrets.get(first.id)).toBeUndefined()
  })
  it('deduplicates concurrent polls and prevents cancelled in-flight approvals from adding a source', async () => {
    const gate = deferred<unknown>()
    const { service, fake, settings } = await setup(({ url }) => url.pathname === '/QuickConnect/Connect' ? gate.promise : undefined)
    const flow = await service.quickConnect('harbour')
    const pending = service.poll(flow.flowId)
    expect(await service.poll(flow.flowId)).toEqual({ state: 'waiting' })
    await service.cancel(flow.flowId)
    gate.resolve({ Authenticated: true })
    expect(await pending).toEqual({ state: 'expired' })
    expect(settings.get().sources).toHaveLength(0)
    expect(fake.calls.filter((r) => r.url.pathname === '/QuickConnect/Connect')).toHaveLength(1)
    const other = await service.quickConnect('harbour')
    service.cancelAll()
    expect(await service.poll(other.flowId)).toEqual({ state: 'expired' })
  })
  it('serialises simultaneous sign-ins for the same identity', async () => {
    const { service, settings } = await setup()
    const results = await Promise.all([service.password('harbour', 'Maya', ''), service.password('harbour', 'Maya', '')])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(settings.get().sources).toHaveLength(1)
  })
  it('settles an unfinished discovery when disposed', async () => {
    const pending = deferred<DiscoveredServer[]>()
    const { service } = await setup(undefined, () => pending.promise)
    const result = service.discover()
    service.dispose()
    expect(await result).toEqual([])
    expect(await service.discover()).toEqual([])
    pending.resolve([])
  })
})
