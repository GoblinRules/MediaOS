import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@shared/media-types'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { SourceError } from '../../src/main/sources/MediaSource'
import { MediaHub, type HomeOptions } from '../../src/main/hub/MediaHub'

const options: HomeOptions = { rows: ['continue', 'nextUp', 'apps', 'latest', 'libraries'], hiddenRows: [], mergeContinue: false }
function item(sourceId: string, id: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { sourceId, id, key: `${sourceId}~${id}`, type: 'movie', title: id, images: { backdrop: true }, ...extra }
}
afterEach(() => vi.useRealTimers())

describe('MediaHub', () => {
  it('builds ordered rows, skips apps and hidden rows, sorts and limits, and builds a hero', async () => {
    const a = new FixtureSource({ id: 'a' }), b = new FixtureSource({ id: 'b' })
    const sourceRows = (sourceId: string) => ({
      resume: Array.from({ length: 22 }, (_, i) => item(sourceId, `resume${i}`, {
        positionSec: 20, lastPlayedAt: String(i).padStart(2, '0'),
      })),
      nextUp: [item(sourceId, 'next', { type: 'episode', seriesId: 'show', seriesTitle: 'Show' })],
      latest: Array.from({ length: 28 }, (_, i) => item(sourceId, `latest${i}`, { addedAt: String(i).padStart(2, '0') })),
    })
    vi.spyOn(a, 'rows').mockResolvedValue(sourceRows('a')); vi.spyOn(b, 'rows').mockResolvedValue(sourceRows('b'))
    const hub = new MediaHub(); hub.add(a); hub.add(b)
    try {
      const data = await hub.home(options)
      expect(data.rows.map((r) => r.id)).toEqual([
        'continue', 'nextUp', 'latest', 'lib:a~movies', 'lib:a~shows', 'lib:b~movies', 'lib:b~shows',
      ])
      expect(data.rows[0]?.items).toHaveLength(20)
      expect(data.rows[0]?.items[0]?.id).toBe('resume21')
      expect(data.rows[2]?.items).toHaveLength(24)
      expect(data.rows[2]?.items[0]?.id).toBe('latest27')
      expect(data.rows[3]?.title).toContain(a.name)
      expect(data.rows[3]?.items).toHaveLength(20)
      expect(data.hero).toHaveLength(6); expect(data.hero[0]?.id).toBe('resume21')
      expect(data.rows[0]?.items.every((i) => i.sourceId === 'a')).toBe(true)
      const hidden = await hub.home({ ...options, hiddenRows: ['continue', 'latest', 'lib:a~movies'] })
      expect(hidden.rows.some((r) => ['continue', 'latest', 'lib:a~movies'].includes(r.id))).toBe(false)
    } finally { hub.dispose() }
  })
  it('deduplicates provider ids and normalised title/year, preferring progress over source order', async () => {
    const a = new FixtureSource({ id: 'a' }), b = new FixtureSource({ id: 'b' })
    vi.spyOn(a, 'rows').mockResolvedValue({ resume: [], nextUp: [], latest: [
      item('a', 'id1', { title: 'First title', providerIds: { imdb: 'tt1' } }),
      item('a', 'id2', { title: 'Café: Sky!', year: 2020 }),
      item('a', 'id3', { title: 'Same', providerIds: { tmdb: '123' } }),
    ] })
    vi.spyOn(b, 'rows').mockResolvedValue({ resume: [], nextUp: [], latest: [
      item('b', 'other1', { title: 'Changed title', providerIds: { imdb: 'tt1' }, progress: 0.5 }),
      item('b', 'other2', { title: 'CAFE SKY', year: 2020 }),
      item('b', 'other3', { title: 'Same', providerIds: { tmdb: '123' } }),
    ] })
    const hub = new MediaHub(); hub.add(a); hub.add(b)
    try {
      const latest = (await hub.home({ ...options, rows: ['latest'] })).rows[0]!.items
      expect(latest.map((i) => i.key)).toEqual(['b~other1', 'a~id2', 'a~id3'])
    } finally { hub.dispose() }
  })
  it('merges Next up into Continue, keeping one episode per show and excluding empty rows', async () => {
    const source = new FixtureSource()
    const resume = item('demo', 'e1', { type: 'episode', seriesTitle: 'Show', seriesId: 's1', positionSec: 50 })
    const next = item('demo', 'e2', { type: 'episode', seriesTitle: 'Show', seriesId: 's1' })
    vi.spyOn(source, 'rows').mockResolvedValue({ resume: [resume], nextUp: [next, item('demo', 'new')], latest: [] })
    const hub = new MediaHub(); hub.add(source)
    try {
      const data = await hub.home({ ...options, rows: ['continue', 'nextUp', 'latest'], mergeContinue: true })
      expect(data.rows.map((r) => r.id)).toEqual(['continue'])
      expect(data.rows[0]?.items.map((i) => i.id)).toEqual(['e1', 'new'])
    } finally { hub.dispose() }
  })
  it('requests sources in parallel, times out a slow source, skips failed rows and records offline status', async () => {
    vi.useFakeTimers()
    const slow = new FixtureSource({ id: 'slow' }), fast = new FixtureSource({ id: 'fast' })
    const never = vi.spyOn(slow, 'rows').mockImplementation(() => new Promise(() => undefined))
    const fastRows = vi.spyOn(fast, 'rows')
    const hub = new MediaHub({ timeoutMs: 80 }); hub.add(slow); hub.add(fast)
    try {
      const pending = hub.home(options)
      await vi.advanceTimersByTimeAsync(0)
      expect(never).toHaveBeenCalled(); expect(fastRows).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(80)
      const result = await pending
      expect(result.sources[0]).toMatchObject({ status: 'offline' })
      expect(result.rows.every((r) => r.items.every((i) => i.sourceId === 'fast'))).toBe(true)
    } finally { hub.dispose() }
  })
  it('keeps the source signed-out message after an authentication failure', async () => {
    const source = new FixtureSource()
    vi.spyOn(source, 'info').mockReturnValue({ id: source.id, kind: source.kind, name: source.name,
      status: 'signed-out', message: 'Sign in again in Settings.' })
    vi.spyOn(source, 'libraries').mockRejectedValue(new SourceError('Server rejected the token.', 'auth'))
    const hub = new MediaHub(); hub.add(source)
    try {
      await hub.libraries()
      expect(hub.list()[0]).toMatchObject({ status: 'signed-out', message: 'Sign in again in Settings.' })
    } finally { hub.dispose() }
  })
  it('wraps unexpected errors, preserves SourceErrors and recovers status after success', async () => {
    const source = new FixtureSource()
    const hub = new MediaHub(); hub.add(source)
    const spy = vi.spyOn(source, 'item').mockRejectedValueOnce(new Error('private technical error'))
    try {
      await expect(hub.item('demo~x')).rejects.toThrow('Something went wrong talking to Demo library. Try again in a moment.')
      expect(hub.list()[0]?.status).toBe('error')
      spy.mockRejectedValueOnce(new SourceError('Sign in again.', 'auth'))
      await expect(hub.item('demo~x')).rejects.toThrow('Sign in again.')
      spy.mockRestore()
      await hub.libraries(); expect(hub.list()[0]?.status).toBe('ok')
      expect(() => hub.sourceFor('missing~x')).toThrow("That library isn't connected any more.")
    } finally { hub.dispose() }
  })
  it('caches for 60 seconds, shares pending home calls, separates row options and invalidates watched/favourite changes', async () => {
    vi.useFakeTimers()
    const source = new FixtureSource()
    const rows = vi.spyOn(source, 'rows')
    const hub = new MediaHub(); hub.add(source)
    const changed = vi.fn(); hub.onChanged(changed)
    try {
      const [data] = await Promise.all([hub.home(options), hub.home(options)])
      data!.rows.length = 0
      expect((await hub.home(options)).rows.length).toBeGreaterThan(0)
      expect(rows).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000); await hub.home(options)
      expect(rows).toHaveBeenCalledTimes(2)
      const key = (await hub.home(options)).hero[0]!.key
      await hub.setWatched(key, true); await hub.home(options)
      await hub.setFavourite(key, true); await hub.home(options)
      expect(rows).toHaveBeenCalledTimes(4); expect(changed).toHaveBeenCalledTimes(2)
      hub.refresh(); await hub.home(options); expect(rows).toHaveBeenCalledTimes(5)
      await hub.home({ ...options, rows: [] }); expect(rows).toHaveBeenCalledTimes(6)
    } finally { hub.dispose() }
  })
  it('searches all sources, puts exact titles first, deduplicates, caps at 60 and skips blank queries', async () => {
    const a = new FixtureSource({ id: 'a' }), b = new FixtureSource({ id: 'b' })
    const aSearch = vi.spyOn(a, 'search').mockResolvedValue([
      ...Array.from({ length: 70 }, (_, i) => item('a', `Film ${i}`)), item('a', 'exact', { title: 'Film' }),
    ])
    const bSearch = vi.spyOn(b, 'search').mockResolvedValue([item('b', 'same', { title: 'Film' })])
    const hub = new MediaHub(); hub.add(a); hub.add(b)
    try {
      expect(await hub.search(' \n ')).toEqual([]); expect(aSearch).not.toHaveBeenCalled()
      const results = await hub.search('Film')
      expect(results).toHaveLength(60); expect(results[0]?.key).toBe('a~exact'); expect(bSearch).toHaveBeenCalled()
      expect(results.some((i) => i.key === 'b~same')).toBe(false)
      hub.setEnabled('b', false); bSearch.mockClear(); await hub.search('Film'); expect(bSearch).not.toHaveBeenCalled()
      const libraries = await hub.libraries()
      const page = await hub.browse(libraries[0]!.key, { sort: 'title', limit: 10, offset: 0 })
      expect(page.items).toHaveLength(10)
      expect((await hub.item(page.items[0]!.key)).title).toBe(page.items[0]!.title)
      expect(await hub.children(page.items[0]!.key)).toEqual([])
    } finally { hub.dispose() }
  })
})
