// Deterministic demo library: invented titles, generated art. Used in mock mode, tests and first-run "try it" mode.
import type { MediaItem } from '@shared/media-types'
import { itemKey } from '@shared/media-types'

export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MOVIE_TITLES = [
  'The Glass Orchard', 'Northbound', 'Paper Lanterns', 'The Last Lighthouse', 'Copper Sky', 'Midnight Ferry',
  'Saltwater Hymns', 'The Cartographer', 'Velvet Static', 'Iron Meadow', 'Small Hours', 'The Winter Signal',
  'Harbour Lights', 'Echo Valley', 'Quiet Thunder', 'The Orchid Code', 'Long Way Down', 'Satellite Hearts',
  'The Brass Key', 'Ember Road', 'Deep Water Radio', 'The Silent Shore', 'Kingfisher Lane', 'Neon Tide',
  'Atlas of Clouds', 'Second Spring', 'The Lantern Keeper', 'Hollow Pines', 'Moth & Moon', 'Red Sail',
  'The Ninth Bell', 'Foxglove', 'Marble Street', 'After the Rain', 'Summer of Kites', "The Clockmaker's Daughter",
  'Wildflower Run', 'Distant Fires', 'Blue Hour', 'The Orbit Club',
]

const GENRES = ['Drama', 'Thriller', 'Comedy', 'Adventure', 'Sci-Fi', 'Mystery', 'Romance', 'Family', 'Documentary', 'Animation']
const RATINGS = ['U', 'PG', '12A', '12', '15', '18']

const WHO = ['A retired ferry captain', 'Two estranged sisters', 'A night-shift radio host', 'A young cartographer',
  'An unlikely band of neighbours', 'A detective on her last case', 'A lighthouse keeper', 'A travelling clockmaker',
  'A teenage astronomer', 'A small-town baker']
const WHAT = ['uncovers a secret buried for forty years', 'must cross the country before the first snow',
  'receives a message from a station that shut down decades ago', 'inherits a house that rearranges itself',
  'races to save the last orchard on the coast', 'is drawn into a heist nobody planned',
  'tries to reunite a scattered family over one long weekend', 'finds a map to a place that is not on any map']
const HOW = ['A warm, funny story about second chances.', 'Tense, gorgeous and quietly devastating.',
  'Shot on location along the north coast.', 'A crowd-pleaser with a big heart.',
  'Based on an unlikely true story.', 'Twisty, stylish and surprisingly tender.']

export interface FixtureShow {
  id: string
  title: string
  year: number
  seasons: { number: number; episodes: number }[]
  genres: string[]
}

const SHOWS: Omit<FixtureShow, 'id'>[] = [
  { title: 'Coastline', year: 2021, seasons: [{ number: 1, episodes: 6 }, { number: 2, episodes: 6 }, { number: 3, episodes: 8 }], genres: ['Drama'] },
  { title: 'The Bureau of Small Things', year: 2023, seasons: [{ number: 1, episodes: 8 }, { number: 2, episodes: 8 }], genres: ['Comedy'] },
  { title: 'Night Shift at Pier 9', year: 2025, seasons: [{ number: 1, episodes: 10 }], genres: ['Thriller', 'Mystery'] },
  { title: 'Greenhouse', year: 2019, seasons: [{ number: 1, episodes: 6 }, { number: 2, episodes: 6 }], genres: ['Documentary'] },
  { title: 'Signal & Noise', year: 2024, seasons: [{ number: 1, episodes: 8 }, { number: 2, episodes: 6 }], genres: ['Sci-Fi', 'Drama'] },
  { title: 'The Allotment', year: 2026, seasons: [{ number: 1, episodes: 6 }], genres: ['Comedy', 'Family'] },
]

const EP_WORDS = ['Low Tide', 'The Visitor', 'Static', 'Homecoming', 'Fault Lines', 'The Long Night', 'Undertow',
  'Paper Trail', 'Open Water', 'First Light', 'The Signal', 'Crossings', 'Inventory', 'Weathervane', 'The Archive',
  'Last Orders', 'Thaw', 'Night Bus', 'Common Ground', 'The Return', 'Ballast', 'Kites', 'Small Mercies', 'Tidings']

export interface FixtureCatalog {
  movies: MediaItem[]
  shows: MediaItem[]
  seasons: MediaItem[]
  episodes: MediaItem[]
}

const DAY = 86_400_000
/** Fixed "now" so the demo data and screenshots are stable. */
export const FIXTURE_EPOCH = Date.UTC(2026, 10, 10, 20, 0, 0)

function overview(r: () => number): string {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T
  return `${pick(WHO)} ${pick(WHAT)}. ${pick(HOW)}`
}

export function buildCatalog(sourceId: string): FixtureCatalog {
  const r = rng(hash(sourceId) ^ 0x9e3779b9)
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)] as T

  const movies: MediaItem[] = MOVIE_TITLES.map((title, i) => {
    const id = `m${i + 1}`
    const runtimeSec = (85 + Math.floor(r() * 70)) * 60
    const year = 1984 + Math.floor(r() * 43)
    const g1 = pick(GENRES)
    let g2 = pick(GENRES)
    if (g2 === g1) g2 = GENRES[(GENRES.indexOf(g1) + 3) % GENRES.length] as string
    const watched = i % 7 === 3
    // A few films part-watched, for Continue Watching.
    const inProgress = [1, 4, 9, 15].includes(i)
    const positionSec = inProgress ? Math.floor(runtimeSec * (0.15 + r() * 0.6)) : 0
    return {
      key: itemKey(sourceId, id), sourceId, id, type: 'movie', title, year,
      subtitle: String(year), overview: overview(r), runtimeSec, positionSec,
      progress: positionSec ? positionSec / runtimeSec : watched ? 1 : 0, watched, favourite: i % 9 === 2,
      genres: [g1, g2], officialRating: pick(RATINGS), communityRating: Math.round((5.5 + r() * 3.8) * 10) / 10,
      images: { poster: true, backdrop: true },
      addedAt: new Date(FIXTURE_EPOCH - i * 2.3 * DAY).toISOString(),
      lastPlayedAt: inProgress ? new Date(FIXTURE_EPOCH - (i + 1) * 0.4 * DAY).toISOString() : undefined,
      premieredAt: `${year}-0${1 + (i % 9)}-1${i % 10}`,
    }
  })

  const shows: MediaItem[] = []
  const seasons: MediaItem[] = []
  const episodes: MediaItem[] = []
  SHOWS.forEach((s, si) => {
    const showId = `s${si + 1}`
    let total = 0
    let unwatched = 0
    const showEpisodes: MediaItem[] = []
    for (const season of s.seasons) {
      const seasonId = `${showId}n${season.number}`
      let seasonUnwatched = 0
      for (let e = 1; e <= season.episodes; e++) {
        const id = `${seasonId}e${e}`
        const runtimeSec = (28 + Math.floor(r() * 30)) * 60
        // Shows 1, 2 and 5 are part-way through; the rest unwatched.
        const watchedUpTo = si === 0 ? [6, 4, 0] : si === 1 ? [8, 2] : si === 4 ? [3, 0] : []
        const wUpTo = watchedUpTo[season.number - 1] ?? 0
        const watched = e <= wUpTo
        const resumeHere = (si === 1 && season.number === 2 && e === 3) || (si === 4 && season.number === 1 && e === 4)
        const positionSec = resumeHere ? Math.floor(runtimeSec * 0.42) : 0
        const title = EP_WORDS[(si * 7 + season.number * 3 + e) % EP_WORDS.length] as string
        total++
        if (!watched) {
          unwatched++
          seasonUnwatched++
        }
        const ep: MediaItem = {
          key: itemKey(sourceId, id), sourceId, id, type: 'episode', title,
          subtitle: `S${season.number} · E${e}`, overview: overview(r), runtimeSec, positionSec,
          progress: positionSec ? positionSec / runtimeSec : watched ? 1 : 0, watched,
          seriesId: showId, seriesTitle: s.title, seasonId, seasonNumber: season.number, episodeNumber: e,
          images: { thumb: true, backdrop: true },
          addedAt: new Date(FIXTURE_EPOCH - (si * 9 + (s.seasons.length - season.number) * 30 + (season.episodes - e)) * DAY).toISOString(),
          lastPlayedAt: resumeHere ? new Date(FIXTURE_EPOCH - (si === 1 ? 0.2 : 1.1) * DAY).toISOString()
            : watched && si < 2 ? new Date(FIXTURE_EPOCH - (3 + si) * DAY).toISOString() : undefined,
          officialRating: '15',
        }
        showEpisodes.push(ep)
      }
      seasons.push({
        key: itemKey(sourceId, seasonId), sourceId, id: seasonId, type: 'season', title: `Season ${season.number}`,
        subtitle: `${season.episodes} episodes`, seriesId: showId, seriesTitle: s.title, seasonNumber: season.number,
        unwatchedCount: seasonUnwatched, watched: seasonUnwatched === 0, images: { poster: true },
      })
    }
    episodes.push(...showEpisodes)
    shows.push({
      key: itemKey(sourceId, showId), sourceId, id: showId, type: 'show', title: s.title, year: s.year,
      subtitle: `${s.seasons.length} season${s.seasons.length > 1 ? 's' : ''}`, overview: overview(r),
      genres: s.genres, unwatchedCount: unwatched, watched: unwatched === 0, progress: 1 - unwatched / total,
      favourite: si === 0, officialRating: '15', communityRating: Math.round((7 + r() * 2.5) * 10) / 10,
      images: { poster: true, backdrop: true },
      addedAt: new Date(FIXTURE_EPOCH - si * 9 * DAY).toISOString(),
    })
  })
  return { movies, shows, seasons, episodes }
}
