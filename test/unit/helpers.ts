import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function temporary(): Promise<{ dir: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mediaos-test-'))
  return { dir, dispose: async () => {
    const rel = relative(resolve(tmpdir()), resolve(dir))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Unsafe test folder')
    await rm(dir, { recursive: true, force: true })
  } }
}
// Real file work can need many more turns when the whole suite runs at once, so give up on time as well as turns.
// The turn cap still ends the wait when a test has frozen Date with fake timers.
export async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  for (let i = 0; ; i++) {
    if (predicate()) return
    if (i >= 1000 && (Date.now() - started > timeoutMs || i >= 200_000)) throw new Error('Condition was not reached')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// Linux command fixtures are text captured with LC_ALL=C; this runner never starts a process.
import { readFileSync } from 'node:fs'
import type { CommandRunner, CommandResult } from '../../src/main/system/linux/CommandRunner'
import { properties } from '../../src/main/system/linux/nmcli-parse'

export const fixture = (name: string): string => readFileSync(resolve('test/fixtures/linux', name), 'utf8')
export const NM_UUID = '142be7a3-d9fb-485d-bf09-8f7742f9f08e'
export const NM_CHECKPOINT = '/org/freedesktop/NetworkManager/Checkpoint/1'
export interface RecordedCommand { file: string; args: string[]; timeoutMs: number }
export class FakeNmRunner implements CommandRunner {
  calls: RecordedCommand[] = []
  monitors: { line: (line: string) => void; exit: () => void; killed: boolean }[] = []
  list = fixture('connection-list-plain.txt')
  devices = fixture('device-status.txt')
  routes = fixture('route-default-1.json')
  live = fixture('device-show-dhcp.txt')
  settings = properties(fixture('connection-auto.txt'))
  neighbour = fixture('neigh-192.168.80.151.json')
  wifi = fixture('wifi-list-nodevice.txt')
  unsaved = false
  alive = true
  checkpointBefore?: { settings: Record<string, string>; live: string; unsaved: boolean }
  override?: (call: RecordedCommand) => CommandResult | undefined | Promise<CommandResult | undefined>
  async run(file: string, args: readonly string[], opts: { timeoutMs: number }): Promise<CommandResult> {
    const call = { file, args: [...args], timeoutMs: opts.timeoutMs }
    this.calls.push(call)
    const override = await this.override?.(call)
    if (override) return override
    const reply = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
    if (file === 'ping') return { code: 1, stdout: '', stderr: '' }
    if (file === 'ip') return reply(args.includes('route') ? this.routes : this.neighbour)
    if (file === 'busctl') {
      if (args.includes('GetDeviceByIpIface')) return reply(fixture('busctl-device-path.json'))
      if (args.includes('CheckpointCreate')) {
        this.checkpointBefore = { settings: { ...this.settings }, live: this.live, unsaved: this.unsaved }
        this.alive = true; return reply(fixture('busctl-create.json'))
      }
      if (args.includes('GetConnectionByUuid')) return reply(fixture('busctl-settings-path.json'))
      if (args.includes('Unsaved')) return reply(fixture(`busctl-unsaved-${this.unsaved}.json`))
      if (args.includes('Checkpoints')) return reply(fixture(`busctl-checkpoints-${this.alive ? 'one' : 'empty'}.json`))
      if (args.includes('Save')) { this.unsaved = false; return reply() }
      if (args.includes('CheckpointDestroy')) { this.alive = false; return reply() }
      if (args.includes('CheckpointRollback')) {
        if (this.checkpointBefore) {
          this.settings = { ...this.checkpointBefore.settings }
          this.live = this.checkpointBefore.live; this.unsaved = this.checkpointBefore.unsaved
        }
        this.alive = false; return reply(fixture('busctl-rollback.json'))
      }
    }
    if (file === 'nmcli') {
      if (args.includes('-f')) {
        const fields = args[args.indexOf('-f') + 1] ?? ''
        if (fields.startsWith('NAME,')) return reply(this.list)
        if (fields.startsWith('DEVICE,')) return reply(this.devices)
        if (fields.startsWith('GENERAL.')) return reply(this.live)
        if (fields.startsWith('IN-USE,')) return reply(this.wifi)
        return reply(Object.entries(this.settings).map(([k, v]) => `${k}:${v}`).join('\n'))
      }
      if (args.includes('modify')) {
        for (let i = args.indexOf('uuid') + 2; i < args.length; i += 2) this.settings[args[i]!] = args[i + 1]!
        this.unsaved = args.includes('--temporary')
      }
      if (args.includes('add')) this.list += `MediaOS wired:${NM_UUID}:802-3-ethernet::no\n`
      if (args.includes('up') || args.includes('reapply')) {
        this.live = this.settings['ipv4.method'] === 'manual' ? fixture('device-show-manual.txt') : fixture('device-show-dhcp.txt')
        if (this.settings['ipv4.method'] === 'manual') {
          this.live = this.live.replace('192.168.80.150/24', this.settings['ipv4.addresses']!)
        }
      }
      return reply()
    }
    throw new Error(`Unexpected fake command: ${file}`)
  }
  spawnLines(_file: string, _args: readonly string[], line: (line: string) => void, exit: () => void = () => {}) {
    const monitor = { line, exit, killed: false }
    this.monitors.push(monitor)
    return { kill() { monitor.killed = true } }
  }
}


import { EventEmitter } from 'node:events'
import type { CheckOptions } from '../../src/main/system/linux/net-checks'
export function fakeNetworkChecks() {
  const sockets: { host: string; port: number; socket: EventEmitter & { destroy(): void } }[] = []
  const servers: string[][] = []
  const cancelled: boolean[] = []
  const opts: CheckOptions = {
    socket: (host, port) => {
      const socket = Object.assign(new EventEmitter(), { destroy() {} })
      sockets.push({ host, port, socket })
      queueMicrotask(() => socket.emit('connect'))
      return socket
    },
    resolver: () => ({
      setServers: (list) => { servers.push(list) },
      resolve4: (_host, cb) => { queueMicrotask(() => cb(null, ['151.101.2.132'])) },
      cancel: () => { cancelled.push(true) },
    }),
  }
  return { opts, sockets, servers, cancelled }
}

// Jellyfin replay transport: record the wire request, then route it entirely in memory.
import type { ItemDto } from '../../src/main/sources/jellyfin/dto'
export interface JellyfinCatalogue {
  movie: ItemDto; show: ItemDto; season: ItemDto; episode: ItemDto; next: ItemDto; video: ItemDto; libraries: ItemDto[]
}
export const jellyfinFixture = <T>(name: string): T => JSON.parse(
  readFileSync(resolve('test/fixtures/jellyfin', `${name}.json`), 'utf8')) as T
export interface JellyfinRequest {
  url: URL; method: string; headers: Headers; body: Record<string, unknown>; signal?: AbortSignal | null
}
export function jellyfinFetch(route: (request: JellyfinRequest) => unknown | Promise<unknown>) {
  const calls: JellyfinRequest[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request: JellyfinRequest = { url: new URL(String(input)), method: init?.method ?? 'GET',
      headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      signal: init?.signal }
    calls.push(request)
    const body = await route(request)
    return body instanceof Response ? body : body === undefined ? new Response(null, { status: 204 }) : Response.json(body)
  }
  return { fetch: fetcher, calls }
}
export function jellyfinReplay(override?: (request: JellyfinRequest) => unknown | Promise<unknown>) {
  const cat = jellyfinFixture<JellyfinCatalogue>('catalogue')
  return jellyfinFetch(async (request) => {
    const custom = await override?.(request)
    if (custom !== undefined) return custom
    const { pathname: path, searchParams: q } = request.url
    if (request.method !== 'GET') {
      if (request.method === 'POST' && /^\/Items\/[^/]+\/PlaybackInfo$/.test(path)) return jellyfinFixture('playback-info')
      if ((['POST', 'DELETE'].includes(request.method) && /^\/User(?:Played|Favorite)Items\/[^/]+$/.test(path)) ||
        (request.method === 'POST' && ['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped'].includes(path)) ||
        (request.method === 'DELETE' && path === '/Videos/ActiveEncodings')) return new Response(null, { status: 204 })
      throw new Error(`Unexpected replay request: ${request.method} ${path}`)
    }
    if (path === '/System/Info/Public') return { ServerName: 'Harbour Jellyfin', Version: '10.9.11', Id: 'server-harbour' }
    if (path === '/QuickConnect/Enabled') return true
    if (path === '/UserViews') return { Items: cat.libraries }
    if (path === '/UserItems/Resume') return { Items: [cat.movie, cat.episode] }
    if (path === '/Shows/NextUp') return { Items: [cat.episode] }
    if (path === '/Items/Latest') return [cat.movie, cat.show]
    if (path === '/Shows/show-tides/Seasons') return { Items: [cat.season] }
    if (path === '/Shows/show-tides/Episodes') return { Items: [cat.episode, cat.next] }
    if (path === '/Items') return { Items: q.get('ParentId') === 'shows' ? [cat.show] : [cat.movie], TotalRecordCount: 42 }
    if (path.startsWith('/Items/')) {
      const item = [cat.movie, cat.show, cat.season, cat.episode, cat.next, cat.video].find((i) => path === `/Items/${i.Id}`)
      if (item) return item
    }
    throw new Error(`Unexpected replay request: ${request.method} ${path}`)
  })
}

export interface PlexCatalogue {
  movie: Record<string, unknown>; show: Record<string, unknown>; season: Record<string, unknown>
  episode: Record<string, unknown>; next: Record<string, unknown>; clip: Record<string, unknown>
  libraries: Record<string, unknown>[]
}
export const plexFixture = <T>(name: string): T => JSON.parse(
  readFileSync(resolve('test/fixtures/plex', `${name}.json`), 'utf8')) as T
export const plexIdentity = { clientId: 'test-device', deviceName: 'Living room TV', appVersion: '2.3.4' }
export const plexOptions = { ...plexIdentity, id: 'plex', name: 'Home Plex', serverId: 'server-a', userId: '42',
  userName: 'Maya', token: 'private-server-a', accountToken: 'private-account', url: 'https://home-a.plex.direct:32400' }

/** Both transports share the recording boundary; Plex checks each origin's token before custom routing. */
export function plexReplay(override?: (request: JellyfinRequest) => unknown | Promise<unknown>) {
  const cat = plexFixture<PlexCatalogue>('catalogue')
  const tokens = new Map([
    ['https://plex.tv', 'private-account'], ['https://clients.plex.tv', 'private-account'],
    ['https://home-a.plex.direct:32400', 'private-server-a'], ['http://192.168.1.20:32400', 'private-server-a'],
    ['https://remote-b.plex.direct:32400', 'private-server-b'], ['http://192.168.1.30:32400', 'private-server-b'],
  ])
  return jellyfinFetch(async (request) => {
    const { origin, hostname: host, pathname: path, searchParams: q } = request.url
    const unauthenticated = path === '/identity' || (origin === 'https://plex.tv' && path.startsWith('/api/v2/pins'))
    const expected = unauthenticated ? null : tokens.get(origin)
    if (expected === undefined || request.headers.get('X-Plex-Token') !== expected) return new Response(null, { status: 401 })
    const custom = await override?.(request)
    if (custom !== undefined) return custom
    const method = request.method
    if (host === 'plex.tv') {
      if (method === 'POST' && path === '/api/v2/pins') return { id: 71, code: 'ABCD', expiresIn: 600 }
      if (method === 'GET' && path === '/api/v2/pins/71') return { authToken: 'private-account' }
      if (method === 'GET' && path === '/api/v2/user') return { id: 42, username: 'Maya', email: 'private@example.invalid' }
    } else if (host === 'clients.plex.tv' && method === 'GET' && path === '/api/v2/resources') return plexFixture('resources')
    else if (['home-a.plex.direct', 'remote-b.plex.direct', '192.168.1.20', '192.168.1.30'].includes(host)) {
      if (method === 'GET' && path === '/identity') return { MediaContainer: {
        machineIdentifier: ['remote-b.plex.direct', '192.168.1.30'].includes(host) ? 'server-b' : 'server-a',
      } }
      if (method === 'PUT' && path === '/library/parts/501') return new Response(null, { status: 204 })
      if (method === 'GET') {
        const envelope = (Metadata: unknown[], extra = {}): unknown => ({ MediaContainer: { Metadata, size: Metadata.length, ...extra } })
        if (path === '/library/sections') return { MediaContainer: { Directory: cat.libraries } }
        if (path === '/hubs/continueWatching/items' || path === '/library/onDeck') return envelope([cat.movie, cat.episode])
        if (path === '/library/recentlyAdded') return envelope([cat.episode, cat.season, cat.movie, cat.next, cat.show])
        if (path === '/library/sections/1/all') return envelope([cat.movie], { totalSize: 42 })
        if (path === '/library/sections/2/all') return envelope([cat.show], { totalSize: 6 })
        if (path === '/library/metadata/201/children') return envelope([cat.season])
        if (path === '/library/metadata/202/children') return envelope([cat.episode, cat.next])
        if (path === '/hubs/search') return { MediaContainer: { Hub: [
          { type: 'movie', Metadata: [cat.movie] }, { type: 'artist', Metadata: [cat.clip] },
          { type: 'show', Metadata: [cat.show] }, { type: 'episode', Metadata: [cat.episode] },
        ] } }
        if (path.startsWith('/library/metadata/')) {
          const ids = decodeURIComponent(path.slice('/library/metadata/'.length)).split(',')
          return envelope([cat.movie, cat.show, cat.season, cat.episode, cat.next, cat.clip].filter((i) =>
            ids.includes(String(i.ratingKey))))
        }
        if (path === '/video/:/transcode/universal/decision') return { MediaContainer: { generalDecisionCode: 1001 } }
        if (['/:/timeline', '/:/scrobble', '/:/unscrobble', '/video/:/transcode/universal/stop'].includes(path)) {
          if (path === '/video/:/transcode/universal/stop' && !q.has('session')) throw Error('Missing session')
          return new Response(null, { status: 204 })
        }
      }
    }
    throw new Error(`Unexpected Plex replay request: ${host} ${method} ${path}`)
  })
}
