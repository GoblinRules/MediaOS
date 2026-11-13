import { describe, expect, it } from 'vitest'
import { mapDetail, mapItem, mapLibrary, seconds } from '../../src/main/sources/jellyfin/mappers'
import { jellyfinFixture, type JellyfinCatalogue } from './helpers'

const cat = jellyfinFixture<JellyfinCatalogue>('catalogue')
describe('Jellyfin mapping', () => {
  it('maps all supported item types and skips other types', () => {
    expect([cat.movie, cat.show, cat.season, cat.episode, cat.video].map((r) => mapItem('jf', r)?.type))
      .toEqual(['movie', 'show', 'season', 'episode', 'video'])
    expect(mapItem('jf', { Id: 'song', Name: 'Song', Type: 'Audio' })).toBeUndefined()
  })
  it('checks untrusted fields, caps text and ids, and skips invalid items and stream indices', () => {
    for (const value of [null, 42, [], { Id: 'x', Type: 'constructor' }, { Id: {}, Type: 'Movie' },
      { Id: 'x'.repeat(129), Type: 'Movie' }, { Id: 'x', Type: {} }]) expect(mapItem('jf', value)).toBeUndefined()
    const raw = { ...cat.movie, Name: { bad: true }, Overview: 'o'.repeat(5001), ProductionYear: '2026',
      Genres: ['Drama', null, {}], ProviderIds: { Imdb: {}, Tmdb: '123' }, ImageTags: { Primary: {} },
      BackdropImageTags: 'bad', UserData: { Played: 'false', IsFavorite: {}, PlaybackPositionTicks: '100' },
      MediaSources: [{ Id: 'media', MediaStreams: [null, { Index: -1, Type: 'Audio' }, { Index: 1.5, Type: 'Audio' },
        { Index: '2', Type: 'Audio' }, { Index: 3, Type: 'Audio', Codec: {}, DisplayTitle: 't'.repeat(301), IsDefault: 'true' }] }],
      People: [null, { Name: {}, Type: 'Actor' }, { Name: 'n'.repeat(301), Type: 'Actor', Role: {} }], Studios: [null, { Name: {} }],
    }
    const item = mapItem('jf', raw)!
    expect(item).toMatchObject({ title: '', genres: ['Drama'], providerIds: { tmdb: '123' }, images: { poster: false } })
    expect(item.overview).toHaveLength(5000)
    expect(item.year).toBeUndefined(); expect(item.watched).toBeUndefined(); expect(item.positionSec).toBeUndefined()
    expect(mapItem('jf', { ...cat.movie, Name: 'n'.repeat(301) })?.title).toHaveLength(300)
    expect(mapItem('jf', { ...cat.movie, Id: 'i'.repeat(128) })?.id).toHaveLength(128)
    const detail = mapDetail(item, raw)
    expect(detail.audioTracks).toHaveLength(1)
    expect(detail.audioTracks[0]).toMatchObject({ index: 3, label: 't'.repeat(300) })
    expect(detail.audioTracks[0]?.default).toBeUndefined()
    expect(detail.cast).toEqual([{ name: 'n'.repeat(300), role: undefined }])
    expect(detail.studios).toEqual([])
    expect(mapLibrary('jf', null)).toBeUndefined()
  })
  it('converts fractional ticks, clamps positions and progress, and preserves user state and dates', () => {
    expect(seconds(12_500_000)).toBe(1.25)
    expect(seconds(undefined)).toBeUndefined()
    const movie = mapItem('jf', cat.movie)!
    expect(movie).toMatchObject({ key: 'jf~film-harbour', sourceId: 'jf', runtimeSec: 7200.25, positionSec: 60.125,
      watched: false, favourite: true, providerIds: { imdb: 'tt9876543', tmdb: '567890', tvdb: '123456' },
      addedAt: cat.movie.DateCreated, premieredAt: cat.movie.PremiereDate, lastPlayedAt: cat.movie.UserData?.LastPlayedDate })
    expect(movie.progress).toBeCloseTo(60.125 / 7200.25)
    expect(mapItem('jf', { ...cat.movie, UserData: { PlaybackPositionTicks: 1e15 } }))
      .toMatchObject({ positionSec: 7200.25, progress: 1 })
    expect(mapItem('jf', { ...cat.movie, UserData: { Played: true } })?.progress).toBe(1)
    expect(mapItem('jf', { ...cat.movie, UserData: { PlayedPercentage: 50 } })?.progress).toBe(0.5)
    expect(mapItem('jf', cat.show)?.unwatchedCount).toBe(8)
  })
  it('uses the episode subtitle format and signals available own and inherited artwork', () => {
    expect(mapItem('jf', cat.episode)).toMatchObject({ subtitle: 'S2 · E5 · The Lantern', seriesId: 'show-tides',
      seasonId: 'season-tides-2', images: { poster: true, backdrop: true, thumb: true, logo: false } })
    expect(mapItem('jf', cat.movie)?.images).toEqual({ poster: true, backdrop: true, thumb: true, logo: true })
    expect(mapItem('jf', cat.video)?.images).toEqual({ poster: false, backdrop: false, thumb: false, logo: false })
    expect(mapItem('jf', cat.season)?.seasonNumber).toBe(2)
  })
  it('filters library kinds and supports empty and home-video collection types', () => {
    expect(cat.libraries.flatMap((r) => mapLibrary('jf', r) ?? []).map((l) => l.kind))
      .toEqual(['movies', 'shows', 'mixed', 'mixed'])
    for (const CollectionType of ['music', 'books', 'photos', 'livetv', 'playlists', 'boxsets', 'unknown']) {
      expect(mapLibrary('jf', { ...cat.libraries[0]!, CollectionType })).toBeUndefined()
    }
  })
  it('maps stream indices, track flags, summaries and people', () => {
    const detail = mapDetail(mapItem('jf', cat.movie)!, cat.movie)
    expect(detail).toMatchObject({ videoInfo: '4K · HDR10 · HEVC', audioInfo: 'English · E-AC3 5.1',
      cast: [{ name: 'Maya Birch', role: 'The keeper' }], directors: ['Ellis Rowe'], studios: ['Lantern Films'] })
    expect(detail.audioTracks[0]).toMatchObject({ index: 2, label: 'English · E-AC3 5.1', default: true })
    expect(detail.subtitleTracks.find((s) => s.index === 4)).toMatchObject({ forced: true, default: true })
    expect(detail.subtitleTracks.find((s) => s.index === 6)).toMatchObject({ external: true })
  })
})
