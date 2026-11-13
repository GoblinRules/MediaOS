import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlexSource } from '../../src/main/sources/plex/PlexSource'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { plexOptions, plexReplay, plexFixture, type PlexCatalogue } from './helpers'

const sources: PlexSource[] = []
function setup(override?: Parameters<typeof plexReplay>[0], options: Partial<ConstructorParameters<typeof PlexSource>[0]> = {}) {
  const fake = plexReplay(override), source = new PlexSource({ ...plexOptions, fetch: fake.fetch, ...options })
  sources.push(source)
  return { source, fake }
}
afterEach(() => { sources.splice(0).forEach((s) => s.dispose()); vi.useRealTimers() })
describe('Plex source', () => {
  it('keeps grouped shows in Recently added ordered by their newest episode or season on Home', async () => {
    const cat = plexFixture<PlexCatalogue>('catalogue')
    const { source } = setup(({ url }) => url.pathname === '/library/recentlyAdded' ? { MediaContainer: { Metadata: [
      { ...cat.episode, addedAt: 1754000000 }, { ...cat.season, addedAt: 1755000000 },
      { ...cat.movie, addedAt: 1753000000 }, { ...cat.next, addedAt: 1752000000 },
    ] } } : undefined)
    const hub = new MediaHub()
    hub.add(source)
    try {
      const home = await hub.home({ rows: ['latest'], hiddenRows: [], mergeContinue: false })
      expect(home.rows[0]?.items.map((i) => i.id)).toEqual(['201', '101'])
      expect(home.rows[0]?.items[0]?.addedAt).toBe(new Date(1755000000 * 1000).toISOString())
    } finally { hub.dispose() }
  })
  it('skips malformed search hub types without coercing objects into strings', async () => {
    const cat = plexFixture<PlexCatalogue>('catalogue')
    const { source } = setup(({ url }) => url.pathname === '/hubs/search' ? { MediaContainer: { Hub: [
      ...['toString', 'constructor', '__proto__', { toString: null }].map((type) => ({ type, Metadata: [cat.movie] })),
      { type: 'movie', Metadata: [cat.movie] },
    ] } } : undefined)
    expect((await source.search('film')).map((i) => i.id)).toEqual(['101'])
  })
  it('uses the saved verified address without plex.tv, maps rows and batches recently added shows in order', async () => {
    const { source, fake } = setup()
    expect(source.image('101', 'poster', 100, 150)).toEqual({ kind: 'none' })
    const rows = await source.rows()
    expect(rows.resume.map((i) => i.id)).toEqual(['101'])
    expect(rows.nextUp.map((i) => i.id)).toEqual(['205'])
    expect(rows.latest.map((i) => i.id)).toEqual(['201', '101'])
    expect(fake.calls.some((c) => c.url.hostname === 'clients.plex.tv')).toBe(false)
    expect(fake.calls.filter((c) => c.url.pathname.startsWith('/library/metadata/')).map((c) => c.url.pathname))
      .toEqual(['/library/metadata/201'])
    const latest = fake.calls.find((c) => c.url.pathname === '/library/recentlyAdded')!
    expect(latest.url.searchParams.get('X-Plex-Container-Size')).toBe('60')
    expect(latest.url.searchParams.get('X-Plex-Container-Start')).toBe('0')
  })
  it('uses onDeck on a continueWatching 404 and skips malformed items', async () => {
    const { source, fake } = setup(({ url }) => url.pathname === '/hubs/continueWatching/items' ?
      new Response(null, { status: 404 }) : url.pathname === '/library/onDeck' ? { MediaContainer: { Metadata: [
        null, {}, { ratingKey: 'bad', type: 'artist', title: 'Music' }, plexFixture<PlexCatalogue>('catalogue').episode,
      ] } } : undefined)
    expect((await source.rows()).nextUp.map((i) => i.id)).toEqual(['205'])
    expect(fake.calls.some((c) => c.url.pathname === '/library/onDeck')).toBe(true)
  })
  it('discovers after a wrong saved identity and saves the new connection without sending credentials to the wrong machine', async () => {
    const changed = vi.fn()
    const { source, fake } = setup(({ url }) => url.hostname === '192.168.1.99' ?
      { MediaContainer: { machineIdentifier: 'other-server' } } : undefined,
    { url: 'http://192.168.1.99:32400', onConnection: changed })
    await source.libraries()
    expect(changed).toHaveBeenCalledExactlyOnceWith('https://home-a.plex.direct:32400')
    expect(source.info().url).toBe('https://home-a.plex.direct:32400')
    expect(fake.calls.find((c) => c.url.hostname === '192.168.1.99')?.headers.has('X-Plex-Token')).toBe(false)
  })
  it('names the server when both saved and account discovery fail, and tolerates a failed connection save', async () => {
    const offline = setup(() => { throw Error('private account error') })
    await expect(offline.source.libraries()).rejects.toMatchObject({ code: 'offline',
      message: "Can't reach Home Plex. Check the server is switched on." })
    const log = vi.fn()
    const recovered = setup(undefined, { url: undefined, onConnection: () => { throw Error('disk full') },
      logger: { debug: log, info: log, warn: log, error: log } })
    expect(await recovered.source.libraries()).toHaveLength(2)
    expect(log).toHaveBeenCalledWith('Plex connection could not be saved')
  })
  it('re-finds and retries once on a changed connection, with a sixty second cooldown', async () => {
    vi.useFakeTimers()
    let offline = false, address = 'http://192.168.1.20:32400'
    const { source, fake } = setup(({ url }) => {
      if (url.hostname === 'clients.plex.tv') return [{ clientIdentifier: 'server-a', name: 'Home Plex', provides: 'server',
        connections: [{ uri: address, local: true }] }]
      if (offline && url.pathname === '/library/sections') throw Error('offline')
    })
    await source.libraries()
    offline = true
    await expect(source.libraries()).rejects.toMatchObject({ code: 'offline' })
    expect(source.info().url).toBe(address)
    expect(fake.calls.filter((c) => c.url.hostname === 'clients.plex.tv')).toHaveLength(1)
    await expect(source.libraries()).rejects.toMatchObject({ code: 'offline' })
    expect(fake.calls.filter((c) => c.url.hostname === 'clients.plex.tv')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    address = 'https://home-a.plex.direct:32400'
    await expect(source.libraries()).rejects.toMatchObject({ code: 'offline' })
    expect(fake.calls.filter((c) => c.url.hostname === 'clients.plex.tv')).toHaveLength(2)
    offline = false
    expect(await source.libraries()).toHaveLength(2)
  })
  it('recovers a data request on a different verified connection and shares discovery between concurrent failures', async () => {
    let failed = false
    const changed = vi.fn()
    const { source, fake } = setup(({ url }) => {
      if (url.hostname === 'clients.plex.tv') return [{ clientIdentifier: 'server-a', name: 'Home Plex', provides: 'server',
        connections: [{ uri: 'http://192.168.1.20:32400', local: true }] }]
      if (failed && url.hostname === 'home-a.plex.direct' && url.pathname !== '/identity') throw Error('address changed')
    }, { onConnection: changed })
    await source.libraries(); failed = true
    expect((await Promise.all([source.libraries(), source.libraries()])).map((libs) => libs.length)).toEqual([2, 2])
    expect(fake.calls.filter((c) => c.url.hostname === 'clients.plex.tv')).toHaveLength(1)
    expect(changed).toHaveBeenCalledExactlyOnceWith('http://192.168.1.20:32400')
    expect(source.info().url).toBe('http://192.168.1.20:32400')
  })
  it('maps libraries, browse sorts, filters and paging, and returns favourites without making a request', async () => {
    const { source, fake } = setup()
    expect(await source.browse('1', { sort: 'title', offset: 9, limit: 5, filter: 'favourites' }))
      .toEqual({ items: [], total: 0, offset: 9 })
    expect(fake.calls).toHaveLength(0)
    expect((await source.libraries()).map((l) => l.kind)).toEqual(['movies', 'shows'])
    for (const [sort, expected] of Object.entries({ title: 'titleSort', added: 'addedAt', year: 'year', rating: 'audienceRating' })) {
      const page = await source.browse('2', { sort: sort as 'title' | 'added' | 'year' | 'rating',
        descending: true, filter: 'unwatched', offset: 10, limit: 5 })
      expect(page).toMatchObject({ total: 6, offset: 10, items: [{ type: 'show' }] })
      const q = fake.calls.at(-1)!.url.searchParams
      expect(Object.fromEntries(q)).toMatchObject({ type: '2', includeGuids: '1', sort: `${expected}:desc`, unwatched: '1',
        'X-Plex-Container-Start': '10', 'X-Plex-Container-Size': '5' })
    }
  })
  it('returns detail tracks, show seasons and onDeck, children and search hubs in order', async () => {
    const { source, fake } = setup()
    expect(await source.item('101')).toMatchObject({ audioTracks: [{ index: 610 }, { index: 611 }],
      subtitleTracks: [{ index: 620, external: true }, { index: 621, forced: true }, { index: 622 }] })
    expect(await source.item('201')).toMatchObject({ seasons: [{ id: '202' }], nextEpisode: { id: '205' } })
    expect((await source.children('202')).map((i) => i.id)).toEqual(['205', '206'])
    expect((await source.search('sound & sea')).map((i) => i.id)).toEqual(['101', '201', '205'])
    expect(fake.calls.at(-1)!.url.searchParams.get('query')).toBe('sound & sea')
    expect(await source.search('   ')).toEqual([])
    const fallback = setup(({ url }) => url.pathname === '/library/metadata/201' ? { MediaContainer: {
      Metadata: [{ ...plexFixture<PlexCatalogue>('catalogue').show, OnDeck: undefined }],
    } } : undefined)
    expect((await fallback.source.item('201')).nextEpisode?.id).toBe('205')
  })
  it('constructs artwork by kind and parent fallback with header-only tokens, rejecting unsafe artwork', async () => {
    const { source } = setup()
    await source.item('101'); await source.item('205'); await source.item('202')
    for (const [id, kind, path] of [
      ['101', 'poster', '/library/metadata/101/thumb/1700'], ['101', 'backdrop', '/library/metadata/101/art/1700'],
      ['101', 'logo', '/library/metadata/101/clearLogo/1700'], ['205', 'poster', '/library/metadata/201/thumb/1700'],
      ['205', 'backdrop', '/library/metadata/201/art/1700'], ['205', 'thumb', '/library/metadata/205/thumb/1700'],
      ['202', 'poster', '/library/metadata/201/thumb/1700'], ['unknown', 'poster', '/library/metadata/unknown/thumb'],
      ['unknown', 'backdrop', '/library/metadata/unknown/art'],
    ] as const) {
      const image = source.image(id, kind, 320, 480)
      expect(image.kind).toBe('http')
      if (image.kind !== 'http') throw Error('Missing image')
      const url = new URL(image.url)
      expect(url.pathname).toBe('/photo/:/transcode')
      expect(url.searchParams.get('url')).toBe(path)
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ width: '320', height: '480', minSize: '1', upscale: '1' })
      expect(image.headers['X-Plex-Token']).toBe('private-server-a')
      expect(image.authOrigin).toBe('https://home-a.plex.direct:32400')
      expect(image.url).not.toMatch(/token|private-/i)
    }
    expect(source.image('unknown', 'logo', 10, 10)).toEqual({ kind: 'none' })
    for (const thumb of ['https://other.invalid/art', '/thumb?X-Plex-Token=secret', 'relative/art']) {
      const bad = setup(({ url }) => url.pathname === '/library/metadata/101' ? { MediaContainer: {
        Metadata: [{ ...plexFixture<PlexCatalogue>('catalogue').movie, thumb }],
      } } : undefined)
      await bad.source.item('101')
      expect(bad.source.image('101', 'poster', 10, 10)).toEqual({ kind: 'none' })
    }
  })
  it('uses scrobble and unscrobble and rejects favourites, while missing tokens and HTTP auth mark signed-out', async () => {
    const { source, fake } = setup()
    await source.setWatched('101', true); await source.setWatched('101', false)
    expect(fake.calls.slice(-2).map((c) => [c.method, c.url.pathname, Object.fromEntries(c.url.searchParams)]))
      .toEqual(['scrobble', 'unscrobble'].map((s) => ['GET', `/:/${s}`, { identifier: 'com.plexapp.plugins.library', key: '101' }]))
    await expect(source.setFavourite('101', true)).rejects.toMatchObject({ code: 'unsupported',
      message: "Plex doesn't have favourites, so this can't be saved." })
    const signedOut = setup(undefined, { token: undefined })
    expect(signedOut.source.info()).toMatchObject({ status: 'signed-out', message: 'Sign in to Home Plex again in Settings.' })
    await expect(signedOut.source.rows()).rejects.toMatchObject({ code: 'auth' })
    expect(signedOut.fake.calls).toHaveLength(0)
    const expired = setup(({ url }) => url.pathname === '/library/sections' ? new Response(null, { status: 401 }) : undefined)
    await expect(expired.source.libraries()).rejects.toMatchObject({ code: 'auth' })
    expect(expired.source.info().status).toBe('signed-out')
  })
})
