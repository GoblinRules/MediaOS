import { afterEach, describe, expect, it, vi } from 'vitest'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { MediaHub } from '../../src/main/hub/MediaHub'
import { SourceError } from '../../src/main/sources/MediaSource'
import type { MediaItem } from '@shared/media-types'
import { deferred } from './helpers'

afterEach(() => vi.useRealTimers())
describe('hub request policies', () => {
  it.each(['notFound', 'unsupported', 'paywall'] as const)('keeps a library connected after an item-level %s', async (code) => {
    const source = new FixtureSource(), hub = new MediaHub()
    hub.add(source)
    vi.spyOn(source, 'item').mockRejectedValue(new SourceError('This item is unavailable.', code))
    try {
      await expect(hub.item('demo~gone')).rejects.toHaveProperty('code', code)
      expect(hub.list()[0]).toMatchObject({ status: 'ok', message: undefined })
    } finally { hub.dispose() }
  })
  it('allows a playback plan taking longer than four seconds and clears previous connection failures', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), hub = new MediaHub()
    hub.add(source)
    const movie = (await source.rows()).latest.find((i) => i.type === 'movie')!
    const plan = await source.playback(movie.id, { resume: false })
    vi.spyOn(source, 'item').mockRejectedValueOnce(new SourceError('Offline', 'offline'))
    await expect(hub.item(movie.key)).rejects.toThrow('Offline')
    const playback = vi.spyOn(source, 'playback').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(plan), 5000)
    }))
    const pending = hub.playback(movie.key, { resume: false }), done = vi.fn()
    void pending.then(done)
    await vi.advanceTimersByTimeAsync(4500); expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual(plan); expect(playback).toHaveBeenCalledOnce()
    expect(hub.list()[0]?.status).toBe('ok')
    hub.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['search', 4000], ['home', 8000], ['libraries', 8000], ['browse', 8000], ['item', 8000], ['children', 8000],
    ['playback', 15_000], ['setWatched', 15_000], ['setFavourite', 15_000],
  ] as const)('uses the default %s timeout of %s ms', async (method, ms) => {
    vi.useFakeTimers()
    const source = new FixtureSource(), hub = new MediaHub()
    hub.add(source)
    const never = deferred<never>()
    const invoke = () => {
      switch (method) {
        case 'search': vi.spyOn(source, 'search').mockReturnValue(never.promise); return hub.search('film')
        case 'home': vi.spyOn(source, 'rows').mockReturnValue(never.promise)
          return hub.home({ rows: [], hiddenRows: [], mergeContinue: false })
        case 'libraries': vi.spyOn(source, 'libraries').mockReturnValue(never.promise); return hub.libraries()
        case 'browse': vi.spyOn(source, 'browse').mockReturnValue(never.promise)
          return hub.browse('demo~movies', { sort: 'title', offset: 0, limit: 20 })
        case 'item': vi.spyOn(source, 'item').mockReturnValue(never.promise); return hub.item('demo~id')
        case 'children': vi.spyOn(source, 'children').mockReturnValue(never.promise); return hub.children('demo~id')
        case 'playback': vi.spyOn(source, 'playback').mockReturnValue(never.promise)
          return hub.playback('demo~id', { resume: false })
        case 'setWatched': vi.spyOn(source, 'setWatched').mockReturnValue(never.promise); return hub.setWatched('demo~id', true)
        case 'setFavourite': vi.spyOn(source, 'setFavourite').mockReturnValue(never.promise); return hub.setFavourite('demo~id', true)
      }
    }
    let settled = false
    const pending = invoke().then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(ms - 1); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await pending; expect(settled).toBe(true)
    expect(hub.list()[0]?.status).toBe(method === 'search' ? 'ok' : 'offline')
    hub.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves source failures on search timeout, but records genuine search connection errors', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource(), hub = new MediaHub()
    hub.add(source)
    const search = vi.spyOn(source, 'search').mockRejectedValueOnce(new SourceError('Offline', 'offline'))
    try {
      await hub.search('film')
      expect(hub.list()[0]).toMatchObject({ status: 'offline', message: 'Offline' })
      search.mockReturnValue(new Promise(() => undefined))
      const pending = hub.search('film')
      await vi.advanceTimersByTimeAsync(4000); await pending
      expect(hub.list()[0]).toMatchObject({ status: 'offline', message: 'Offline' })
      search.mockResolvedValue([]); await hub.search('film')
      expect(hub.list()[0]?.status).toBe('ok')
    } finally { hub.dispose() }
  })
  it('ignores no-op renames and enable changes, including missing sources', () => {
    const source = new FixtureSource(), hub = new MediaHub()
    hub.add(source)
    const changed = vi.fn(); hub.onChanged(changed)
    hub.rename('demo', source.name); hub.setEnabled('demo', true)
    hub.rename('missing', 'Name'); hub.setEnabled('missing', false)
    expect(changed).not.toHaveBeenCalled()
    hub.rename('demo', 'Our TV'); hub.rename('demo', 'Our TV')
    hub.setEnabled('demo', false); hub.setEnabled('demo', false)
    expect(changed).toHaveBeenCalledTimes(2); hub.dispose()
  })
  it('builds hero from progressed resume first, followed by latest, excluding an unprogressed newest resume', async () => {
    const source = new FixtureSource(), hub = new MediaHub()
    const item = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
      sourceId: 'demo', key: `demo~${id}`, id, type: 'movie', title: id, images: { backdrop: true }, ...extra,
    })
    vi.spyOn(source, 'rows').mockResolvedValue({
      resume: [item('empty', { lastPlayedAt: '99' }), item('progressed', { lastPlayedAt: '01', positionSec: 20 })],
      nextUp: [], latest: [item('latest', { addedAt: '99' })],
    })
    hub.add(source)
    const home = await hub.home({ rows: ['continue', 'latest'], hiddenRows: [], mergeContinue: false })
    expect(home.hero.map((i) => i.id)).toEqual(['progressed', 'latest'])
    hub.dispose()
  })
})

describe('fixture review regressions', () => {
  it.each(['added', 'year', 'rating'] as const)('sorts %s ascending, reversing exactly once for descending', async (sort) => {
    const source = new FixtureSource()
    const ascending = await source.browse('movies', { sort, offset: 0, limit: 200 })
    const descending = await source.browse('movies', { sort, descending: true, offset: 0, limit: 200 })
    const values = ascending.items.map((i) => sort === 'year' ? i.year ?? 0 : sort === 'rating' ? i.communityRating ?? 0 : i.addedAt!)
    expect(values).toEqual([...values].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b :
      String(a).localeCompare(String(b))))
    expect(new Set(values).size).toBeGreaterThan(1)
    expect(descending.items.map((i) => i.key)).toEqual(ascending.items.map((i) => i.key).reverse())
    source.dispose()
  })
  it('gives the same actionable offline message from requests and info', async () => {
    const source = new FixtureSource({ offline: true })
    await expect(source.rows()).rejects.toThrow(source.info().message)
    expect(source.info().message).toBe("Can't reach Demo library. Check the server is switched on, then try again.")
  })
})
