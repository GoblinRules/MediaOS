import { describe, expect, it } from 'vitest'
import type { MediaItem } from '../../src/shared/media-types'
import type { MediaSource } from '../../src/main/sources/MediaSource'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { JellyfinSource } from '../../src/main/sources/jellyfin/JellyfinSource'
import { PlexSource } from '../../src/main/sources/plex/PlexSource'
import { jellyfinReplay, plexReplay, plexOptions } from '../unit/helpers'

const factories: [string, () => MediaSource][] = [
  ['Fixture', () => new FixtureSource({ id: 'fixture' })],
  ['Jellyfin replay', () => new JellyfinSource({ id: 'jf', name: 'Harbour', url: 'http://harbour:8096',
    serverId: 'server', userId: 'user', token: 'token', deviceId: 'device', deviceName: 'TV', appVersion: '0.1.0',
    fetch: jellyfinReplay().fetch })],
  ['Plex replay', () => new PlexSource({ ...plexOptions, fetch: plexReplay().fetch })],
]
describe.each(factories)('%s MediaSource contract', (_name, factory) => {
  it('provides valid items, library keys, pages, children, detail and a playback plan', async () => {
    const source = factory()
    const check = (item: MediaItem): void => {
      expect(item.id).toBeTypeOf('string')
      expect(item.title).toBeTypeOf('string')
      expect(['movie', 'show', 'season', 'episode', 'video']).toContain(item.type)
      expect(item.sourceId).toBe(source.id)
      expect(item.key).toBe(`${source.id}~${item.id}`)
      expect(item.images).toBeTypeOf('object')
      if (item.progress !== undefined) { expect(item.progress).toBeGreaterThanOrEqual(0); expect(item.progress).toBeLessThanOrEqual(1) }
      if (item.positionSec !== undefined && item.runtimeSec !== undefined) expect(item.positionSec).toBeLessThanOrEqual(item.runtimeSec)
    }
    try {
      const rows = await source.rows()
      for (const items of Object.values(rows)) items.forEach(check)
      const libraries = await source.libraries()
      expect(libraries.length).toBeGreaterThan(0)
      for (const library of libraries) {
        expect(library.key).toBe(`${source.id}~${library.id}`)
        expect(library.sourceId).toBe(source.id)
        expect(library.title).toBeTypeOf('string')
        expect(['movies', 'shows', 'mixed']).toContain(library.kind)
        const page = await source.browse(library.id, { sort: 'title', offset: 0, limit: 5 })
        expect(page.total).toBeGreaterThanOrEqual(page.items.length)
        expect(page.offset).toBe(0)
        page.items.forEach(check)
      }
      const show = rows.latest.find((i) => i.type === 'show')!
      const detail = await source.item(show.id)
      check(detail)
      expect(Array.isArray(detail.audioTracks)).toBe(true)
      expect(Array.isArray(detail.subtitleTracks)).toBe(true)
      const seasons = await source.children(show.id)
      expect(seasons.length).toBeGreaterThan(0)
      seasons.forEach(check)
      const episodes = await source.children(seasons[0]!.id)
      expect(episodes.length).toBeGreaterThan(0)
      episodes.forEach(check)
      const movie = rows.latest.find((i) => i.type === 'movie')!
      check(await source.item(movie.id))
      const plan = await source.playback(movie.id, { resume: true })
      expect(plan.url.length).toBeGreaterThan(0)
      expect(['direct', 'transcode']).toContain(plan.method)
      expect(plan.report).toMatchObject({ sourceId: source.id, itemId: movie.id, data: expect.any(Object) })
    } finally { source.dispose() }
  })
})
