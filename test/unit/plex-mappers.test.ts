import { describe, expect, it } from 'vitest'
import { mapItem, mapLibrary, mapDetail } from '../../src/main/sources/plex/mappers'
import { readItem, records } from '../../src/main/sources/plex/guards'
import { plexFixture, type PlexCatalogue } from './helpers'

const cat = plexFixture<PlexCatalogue>('catalogue')
describe('Plex mapping', () => {
  it('skips inherited property names and non-string types for both items and libraries', () => {
    for (const type of ['toString', 'constructor', '__proto__', { toString: null }, { toString: () => 'movie' }]) {
      expect(mapItem('p', { ...cat.movie, type })).toBeUndefined()
      expect(mapLibrary('p', { key: '1', title: 'Invalid library', type })).toBeUndefined()
    }
  })
  it('converts milliseconds, Unix seconds and release dates, with ratings and provider ids', () => {
    expect(mapItem('p', cat.movie)).toMatchObject({ key: 'p~101', sourceId: 'p', type: 'movie', title: 'The Lantern Keeper',
      runtimeSec: 7200.5, positionSec: 1200.5, progress: 1200500 / 7200500, watched: true,
      lastPlayedAt: '2025-10-09T08:53:20.000Z', addedAt: '2025-06-15T15:06:40.000Z', premieredAt: '2024-04-12T00:00:00.000Z',
      overview: 'A keeper returns to a quiet island.', officialRating: '12', communityRating: 8.3,
      genres: ['Drama', 'Mystery'], providerIds: { imdb: 'tt9876543', tmdb: '9876', tvdb: '321' },
      images: { poster: true, backdrop: true, thumb: true, logo: true } })
    expect(mapItem('p', { ...cat.movie, viewOffset: 999999999 })?.progress).toBe(1)
    expect(mapItem('p', cat.movie)).not.toHaveProperty('favourite')
    expect(mapItem('p', { ...cat.movie, contentRating: 'gb/12A' })?.officialRating).toBe('12A')
  })
  it('maps every supported type, episode relationships, subtitles and show/season watched rules', () => {
    expect(mapItem('p', cat.episode)).toMatchObject({ type: 'episode', subtitle: 'S2 · E5 · Across the Sound',
      seriesId: '201', seriesTitle: 'Tides of Tomorrow', seasonId: '202', seasonNumber: 2, episodeNumber: 5,
      watched: false, images: { poster: true, backdrop: true, thumb: true, logo: false } })
    expect(mapItem('p', cat.season)).toMatchObject({ type: 'season', seriesId: '201', seasonNumber: 2,
      watched: true, unwatchedCount: 0, images: { poster: true } })
    expect(mapItem('p', cat.show)).toMatchObject({ type: 'show', watched: false, unwatchedCount: 6 })
    expect(mapItem('p', { ...cat.show, leafCount: 0, viewedLeafCount: 0 })?.watched).toBe(false)
    expect(mapItem('p', cat.clip)?.type).toBe('video')
    expect(mapItem('p', { ...cat.movie, audienceRating: null, viewCount: 0 })).toMatchObject({ communityRating: 7.2, watched: false })
  })
  it('skips malformed entries and unsupported libraries and reads track and people detail safely', () => {
    for (const raw of [null, [], {}, { ratingKey: '1', type: 'artist', title: 'Music' }, { ...cat.movie, title: null }]) {
      expect(mapItem('p', raw)).toBeUndefined()
    }
    expect(cat.libraries.flatMap((l) => mapLibrary('p', l) ?? []).map((l) => l.kind)).toEqual(['movies', 'shows'])
    const detail = mapDetail(mapItem('p', cat.movie)!, readItem(cat.movie)!)
    expect(detail).toMatchObject({ tagline: 'One light remains.', cast: [{ name: 'Nora Vale', role: 'The Keeper' }],
      directors: ['Elliot Shore'], studios: ['Harbour Pictures'], videoInfo: '4K · HDR · HEVC', audioInfo: 'English · E-AC3 5.1' })
    expect(detail.audioTracks.map((t) => t.index)).toEqual([610, 611])
    expect(detail.subtitleTracks).toMatchObject([{ index: 620, external: true, default: true },
      { index: 621, external: false, forced: true }, { index: 622, external: true }])
    expect(records([null, 'bad', {}, []])).toEqual([{}])
  })
})
