import { describe, expect, it } from 'vitest'
import { JellyfinSource } from '../../src/main/sources/jellyfin/JellyfinSource'
import { jellyfinReplay } from './helpers'

const options = { id: 'jf', name: 'Harbour Jellyfin', url: 'http://harbour:8096', serverId: 'server-harbour',
  userId: 'user', token: 'private-token', deviceId: 'device', deviceName: 'TV', appVersion: '0.1.0' }
describe('Jellyfin source', () => {
  it('skips malformed list entries and rejects non-object whole replies as server failures', async () => {
    let response: unknown = { Items: [null, 42, { Id: 'bad', Type: 'constructor' }, { Id: 'good', Type: 'Movie', Name: {} }],
      TotalRecordCount: 'wrong' }
    const fake = jellyfinReplay(() => Response.json(response))
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    expect(await source.search('film')).toMatchObject([{ id: 'good', title: '' }])
    for (response of [null, 42, 'wrong']) {
      await expect(source.search('film')).rejects.toMatchObject({ code: 'server' })
      await expect(source.libraries()).rejects.toMatchObject({ code: 'server' })
      await expect(source.item('film')).rejects.toMatchObject({ code: 'server' })
    }
    source.dispose()
  })
  it('rejects unexpected non-GET replay routes rather than treating them as successes', async () => {
    const fake = jellyfinReplay()
    await expect(fake.fetch('http://harbour/Unexpected', { method: 'POST' }))
      .rejects.toThrow('Unexpected replay request: POST /Unexpected')
  })
  it('loads all home rows with user scope, video limits, fields and image types', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    const rows = await source.rows()
    expect(rows.resume.map((i) => i.type)).toEqual(['movie', 'episode'])
    expect(rows.nextUp[0]!.id).toBe('episode-tides-5')
    expect(rows.latest.map((i) => i.type)).toEqual(['movie', 'show'])
    expect(fake.calls.map((r) => r.url.pathname)).toEqual(['/UserItems/Resume', '/Shows/NextUp', '/Items/Latest'])
    for (const call of fake.calls) {
      expect(call.url.searchParams.get('userId')).toBe('user')
      expect(call.url.searchParams.get('limit')).toBe('24')
      expect(call.url.searchParams.get('Fields')).toBe('Overview,ProviderIds,Genres,DateCreated,PremiereDate,ParentId')
      expect(call.url.searchParams.get('enableImageTypes')).toBe('Primary,Backdrop,Thumb,Logo')
    }
    expect(fake.calls[0]!.url.searchParams.get('mediaTypes')).toBe('Video')
    source.dispose()
  })
  it('maps libraries and browse sorting, filters, pagination and total', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    expect((await source.libraries()).map((l) => l.kind)).toEqual(['movies', 'shows', 'mixed', 'mixed'])
    for (const [sort, SortBy] of Object.entries({ title: 'SortName', added: 'DateCreated,SortName',
      year: 'ProductionYear,SortName', rating: 'CommunityRating,SortName' }) as [
        'title' | 'added' | 'year' | 'rating', string][]) {
      const page = await source.browse('home', { sort, descending: true, filter: 'unwatched', offset: 10, limit: 5 })
      expect(page).toMatchObject({ total: 42, offset: 10, items: [{ id: 'film-harbour' }] })
      expect(Object.fromEntries(fake.calls.at(-1)!.url.searchParams)).toMatchObject({ userId: 'user', ParentId: 'home',
        IncludeItemTypes: 'Movie,Series,Video', Recursive: 'true', StartIndex: '10', Limit: '5',
        EnableTotalRecordCount: 'true', SortBy, SortOrder: 'Descending', Filters: 'IsUnplayed' })
    }
    await source.browse('movies', { sort: 'title', filter: 'favourites', offset: 0, limit: 10 })
    expect(Object.fromEntries(fake.calls.at(-1)!.url.searchParams)).toMatchObject({ SortOrder: 'Ascending',
      IncludeItemTypes: 'Movie,Series', Filters: 'IsFavorite' })
    await source.browse('shows', { sort: 'title', filter: 'all', offset: 0, limit: 10 })
    expect(fake.calls.at(-1)!.url.searchParams.has('Filters')).toBe(false)
    source.dispose()
  })
  it('loads detail, show seasons and next up, and reuses the bounded season-parent cache for children', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    expect(await source.item('film-harbour')).toMatchObject({ audioInfo: 'English · E-AC3 5.1', audioTracks: [{ index: 2 }, { index: 3 }] })
    const show = await source.item('show-tides')
    expect(show.seasons?.[0]!.id).toBe('season-tides-2')
    expect(show.nextEpisode?.id).toBe('episode-tides-5')
    expect((await source.children('season-tides-2')).map((i) => i.id)).toEqual(['episode-tides-5', 'episode-tides-6'])
    await source.children('season-tides-2')
    expect(fake.calls.filter((r) => r.url.pathname === '/Items/season-tides-2')).toHaveLength(0)
    expect(Object.fromEntries(fake.calls.at(-1)!.url.searchParams)).toMatchObject({ userId: 'user', seasonId: 'season-tides-2' })
    source.dispose()
  })
  it('gets an uncached season parent and falls back to the first episode when next up is empty', async () => {
    const fake = jellyfinReplay(({ url }) => url.pathname === '/Shows/NextUp' ? { Items: [] } : undefined)
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    expect((await source.children('season-tides-2'))[0]!.type).toBe('episode')
    expect(fake.calls.some((r) => r.url.pathname === '/Items/season-tides-2')).toBe(true)
    expect((await source.item('show-tides')).nextEpisode?.id).toBe('episode-tides-5')
    source.dispose()
  })
  it('searches recursively for films, shows and episodes with an encoded term', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    expect((await source.search('harbour & coast'))[0]!.title).toBe('The Quiet Harbour')
    expect(Object.fromEntries(fake.calls[0]!.url.searchParams)).toMatchObject({ searchTerm: 'harbour & coast',
      IncludeItemTypes: 'Movie,Series,Episode', Recursive: 'true', Limit: '50', userId: 'user' })
    expect(await source.search(' ')).toEqual([])
    expect(fake.calls).toHaveLength(1)
    source.dispose()
  })
  it('constructs authenticated image requests with tags and episode and parent fallbacks', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    await source.rows()
    const image = (id: string, kind: 'poster' | 'backdrop' | 'thumb' | 'logo'): URL => {
      const result = source.image(id, kind, 600, 900)
      if (result.kind !== 'http') throw Error('Expected HTTP art')
      expect(result.headers.Authorization).toContain('Token="private-token"')
      expect(result.authOrigin).toBe('http://harbour:8096')
      expect(result.url).not.toContain('private-token')
      const url = new URL(result.url)
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ fillWidth: '600', fillHeight: '900', quality: '90' })
      return url
    }
    expect(image('film-harbour', 'poster').searchParams.get('tag')).toBe('poster-harbour')
    expect(image('film-harbour', 'thumb').pathname).toBe('/Items/film-harbour/Images/Thumb')
    expect(image('film-harbour', 'logo').pathname).toBe('/Items/film-harbour/Images/Logo')
    expect(image('episode-tides-5', 'poster').pathname).toBe('/Items/show-tides/Images/Primary')
    expect(image('episode-tides-5', 'poster').searchParams.get('tag')).toBe('poster-tides')
    expect(image('episode-tides-5', 'backdrop').pathname).toBe('/Items/show-tides/Images/Backdrop/0')
    expect(image('episode-tides-5', 'backdrop').searchParams.get('tag')).toBe('back-tides')
    expect(image('episode-tides-5', 'thumb').pathname).toBe('/Items/episode-tides-5/Images/Primary')
    await source.item('episode-tides-6')
    expect(image('episode-tides-6', 'backdrop').pathname).toBe('/Items/show-tides/Images/Backdrop/0')
    expect(image('unknown', 'poster').pathname).toBe('/Items/unknown/Images/Primary')
    expect(image('unknown', 'backdrop').pathname).toBe('/Items/unknown/Images/Backdrop/0')
    source.dispose()
  })
  it('sets and clears watched and favourite state with user-scoped POST and DELETE', async () => {
    const fake = jellyfinReplay()
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    await source.setWatched('film-harbour', true); await source.setWatched('film-harbour', false)
    await source.setFavourite('film-harbour', true); await source.setFavourite('film-harbour', false)
    expect(fake.calls.map((r) => [r.method, r.url.pathname, r.url.searchParams.get('userId')])).toEqual([
      ['POST', '/UserPlayedItems/film-harbour', 'user'], ['DELETE', '/UserPlayedItems/film-harbour', 'user'],
      ['POST', '/UserFavoriteItems/film-harbour', 'user'], ['DELETE', '/UserFavoriteItems/film-harbour', 'user'],
    ])
    source.dispose()
  })
  it('shows signed-out state for a missing token and after an authentication error', async () => {
    const fake = jellyfinReplay(() => new Response(null, { status: 401 }))
    const source = new JellyfinSource({ ...options, fetch: fake.fetch })
    await expect(source.item('film-harbour')).rejects.toMatchObject({ code: 'auth' })
    expect(source.info()).toMatchObject({ status: 'signed-out', message: 'Sign in to Harbour Jellyfin again in Settings.' })
    const missing = new JellyfinSource({ ...options, token: undefined, fetch: fake.fetch })
    expect(missing.info().status).toBe('signed-out')
    await expect(missing.rows()).rejects.toMatchObject({ code: 'auth', message: missing.info().message })
    await expect(missing.search(' ')).rejects.toMatchObject({ code: 'auth' })
    expect(fake.calls).toHaveLength(1)
    source.dispose(); missing.dispose()
  })
})
