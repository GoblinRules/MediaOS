// Demo media server: deterministic catalogue, generated SVG art, in-memory watch state.
import type {
  BrowseQuery, ImageKind, Library, MediaItem, MediaItemDetail, Page, SourceInfo,
} from '@shared/media-types'
import { itemKey } from '@shared/media-types'
import type {
  ImageRequest, MediaSource, PlaybackPlan, PlayOptions, ReportEvent, ReportHandle,
} from '../MediaSource'
import { SourceError } from '../MediaSource'
import { buildCatalog, FIXTURE_EPOCH, type FixtureCatalog } from './fixture-data'
import { renderArt } from './fixture-art'

export interface FixtureOptions {
  id?: string
  name?: string
  /** Simulated server latency, so loading states are visible in dev. */
  latencyMs?: number
  /** Start "offline" (every call fails) to exercise error screens. */
  offline?: boolean
}

const CAST = ['Ada Whitlock', 'Tomas Reyes', 'Priya Sandhu', 'Owen Marsh', 'Lena Okafor', 'Felix Byrne', 'Mina Hart', 'Jonah Pike']

export class FixtureSource implements MediaSource {
  readonly id: string
  readonly kind = 'fixture' as const
  readonly name: string
  private readonly cat: FixtureCatalog
  private readonly byId = new Map<string, MediaItem>()
  private readonly latencyMs: number
  offline: boolean
  private clock = FIXTURE_EPOCH

  constructor(opts: FixtureOptions = {}) {
    this.id = opts.id ?? 'demo'
    this.name = opts.name ?? 'Demo library'
    this.latencyMs = opts.latencyMs ?? 0
    this.offline = opts.offline ?? false
    this.cat = buildCatalog(this.id)
    for (const it of [...this.cat.movies, ...this.cat.shows, ...this.cat.seasons, ...this.cat.episodes]) this.byId.set(it.id, it)
  }

  info(): SourceInfo {
    return {
      id: this.id, kind: 'fixture', name: this.name, serverName: 'Demo server', userName: 'Guest',
      status: this.offline ? 'offline' : 'ok',
      message: this.offline ? `Can't reach ${this.name}. Check the server is switched on, then try again.` : undefined,
    }
  }

  private async wait(): Promise<void> {
    if (this.offline) {
      await new Promise((r) => setTimeout(r, 30))
      throw new SourceError(`Can't reach ${this.name}. Check the server is switched on, then try again.`, 'offline')
    }
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs))
  }

  private get(id: string): MediaItem {
    const it = this.byId.get(id)
    if (!it) throw new SourceError('That item is no longer on the server.', 'notFound')
    return it
  }

  private copy(it: MediaItem): MediaItem {
    return structuredClone(it)
  }

  private episodesOf(showId: string): MediaItem[] {
    return this.cat.episodes.filter((e) => e.seriesId === showId)
  }

  private nextEpisode(showId: string): MediaItem | undefined {
    const eps = this.episodesOf(showId)
    const resume = eps.find((e) => (e.positionSec ?? 0) > 0 && !e.watched)
    if (resume) return resume
    let lastWatched = -1
    eps.forEach((e, i) => {
      if (e.watched) lastWatched = i
    })
    return eps.slice(lastWatched + 1).find((e) => !e.watched) ?? eps.find((e) => !e.watched)
  }

  private refreshShow(showId: string): void {
    const show = this.byId.get(showId)
    if (!show) return
    const eps = this.episodesOf(showId)
    const unwatched = eps.filter((e) => !e.watched).length
    show.unwatchedCount = unwatched
    show.watched = unwatched === 0
    show.progress = eps.length ? 1 - unwatched / eps.length : 0
    for (const s of this.cat.seasons.filter((x) => x.seriesId === showId)) {
      const n = eps.filter((e) => e.seasonId === s.id && !e.watched).length
      s.unwatchedCount = n
      s.watched = n === 0
    }
  }

  async rows(): Promise<{ resume: MediaItem[]; nextUp: MediaItem[]; latest: MediaItem[] }> {
    await this.wait()
    const resume = [...this.cat.movies, ...this.cat.episodes]
      .filter((i) => (i.positionSec ?? 0) > 0 && !i.watched)
      .sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''))
    const resumeShows = new Set(resume.map((i) => i.seriesId).filter(Boolean))
    const nextUp: MediaItem[] = []
    for (const show of this.cat.shows) {
      if (resumeShows.has(show.id)) continue
      const eps = this.episodesOf(show.id)
      if (!eps.some((e) => e.watched)) continue
      const next = this.nextEpisode(show.id)
      if (next) nextUp.push(next)
    }
    const latest = [...this.cat.movies, ...this.cat.shows]
      .sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''))
      .slice(0, 16)
    return { resume: resume.map((i) => this.copy(i)), nextUp: nextUp.map((i) => this.copy(i)), latest: latest.map((i) => this.copy(i)) }
  }

  async libraries(): Promise<Library[]> {
    await this.wait()
    return [
      { key: itemKey(this.id, 'movies'), sourceId: this.id, id: 'movies', title: 'Movies', kind: 'movies',
        itemCount: this.cat.movies.length },
      { key: itemKey(this.id, 'shows'), sourceId: this.id, id: 'shows', title: 'TV Shows', kind: 'shows',
        itemCount: this.cat.shows.length },
    ]
  }

  async browse(libraryId: string, q: BrowseQuery): Promise<Page<MediaItem>> {
    await this.wait()
    let items: MediaItem[]
    if (libraryId === 'movies') items = [...this.cat.movies]
    else if (libraryId === 'shows') items = [...this.cat.shows]
    else throw new SourceError('That library is no longer on the server.', 'notFound')
    if (q.filter === 'unwatched') items = items.filter((i) => !i.watched)
    if (q.filter === 'favourites') items = items.filter((i) => i.favourite)
    const cmp: Record<BrowseQuery['sort'], (a: MediaItem, b: MediaItem) => number> = {
      title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)),
      added: (a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? ''),
      year: (a, b) => (a.year ?? 0) - (b.year ?? 0),
      rating: (a, b) => (a.communityRating ?? 0) - (b.communityRating ?? 0),
    }
    items.sort(cmp[q.sort])
    if (q.descending) items.reverse()
    return { items: items.slice(q.offset, q.offset + q.limit).map((i) => this.copy(i)), total: items.length, offset: q.offset }
  }

  async item(id: string): Promise<MediaItemDetail> {
    await this.wait()
    const it = this.get(id)
    const base = this.copy(it)
    const n = Number(id.replace(/\D+/g, '').slice(0, 3)) || 1
    const detail: MediaItemDetail = {
      ...base,
      tagline: it.type === 'movie' ? 'Some journeys only go one way.' : undefined,
      cast: CAST.slice(n % 3, (n % 3) + 5).map((name, i) => ({ name, role: ['Lead', 'Friend', 'Rival', 'Mentor', 'Stranger'][i] })),
      directors: it.type === 'movie' ? [CAST[(n + 5) % CAST.length] as string] : undefined,
      studios: ['Northlight Pictures'],
      audioTracks: [
        { index: 1, label: 'English · E-AC3 5.1', language: 'eng', codec: 'eac3', channels: 6, default: true },
        { index: 2, label: 'English · AAC Stereo (Audio Description)', language: 'eng', codec: 'aac', channels: 2 },
      ],
      subtitleTracks: [
        { index: 3, label: 'English', language: 'eng', codec: 'srt' },
        { index: 4, label: 'English (SDH)', language: 'eng', codec: 'srt' },
        { index: 5, label: 'Français', language: 'fre', codec: 'srt' },
      ],
      videoInfo: n % 3 === 0 ? '4K · HDR10 · HEVC' : '1080p · H.264',
      audioInfo: 'English · E-AC3 5.1',
    }
    if (it.type === 'show') {
      detail.seasons = this.cat.seasons.filter((s) => s.seriesId === id).map((s) => this.copy(s))
      const next = this.nextEpisode(id)
      detail.nextEpisode = next ? this.copy(next) : undefined
      detail.audioTracks = []
      detail.subtitleTracks = []
      detail.videoInfo = undefined
      detail.audioInfo = undefined
    }
    if (it.type === 'season') {
      detail.audioTracks = []
      detail.subtitleTracks = []
    }
    return detail
  }

  async children(id: string): Promise<MediaItem[]> {
    await this.wait()
    const it = this.get(id)
    if (it.type === 'show') return this.cat.seasons.filter((s) => s.seriesId === id).map((s) => this.copy(s))
    if (it.type === 'season') return this.cat.episodes.filter((e) => e.seasonId === id).map((e) => this.copy(e))
    return []
  }

  async search(text: string): Promise<MediaItem[]> {
    await this.wait()
    const q = text.trim().toLowerCase()
    if (!q) return []
    const hit = (i: MediaItem) => i.title.toLowerCase().includes(q)
    return [...this.cat.movies.filter(hit), ...this.cat.shows.filter(hit), ...this.cat.episodes.filter(hit)]
      .slice(0, 40)
      .map((i) => this.copy(i))
  }

  image(id: string, kind: ImageKind, w: number, h: number): ImageRequest {
    const it = this.byId.get(id)
    if (!it || kind === 'logo') return { kind: 'none' }
    let subject = { seedText: `${it.id}:${it.title}`, title: it.title, kicker: undefined as string | undefined, variant: 0 }
    if (it.type === 'season' || it.type === 'episode') {
      const show = it.seriesId ? this.byId.get(it.seriesId) : undefined
      if (show) {
        subject = {
          seedText: `${show.id}:${show.title}`, title: show.title,
          kicker: it.type === 'season' ? it.title : undefined,
          variant: it.type === 'episode' ? (it.episodeNumber ?? 0) + (it.seasonNumber ?? 0) * 20 : 0,
        }
      }
      if (it.type === 'episode' && kind === 'poster') kind = 'thumb'
    }
    return { kind: 'inline', mime: 'image/svg+xml', body: renderArt(subject, kind, w, h) }
  }

  async playback(id: string, opts: PlayOptions): Promise<PlaybackPlan> {
    await this.wait()
    let it = this.get(id)
    if (it.type === 'show') {
      const next = this.nextEpisode(id)
      if (!next) throw new SourceError('Every episode has been watched.', 'notFound')
      it = next
    }
    if (it.type === 'season') {
      const eps = this.cat.episodes.filter((e) => e.seasonId === id)
      const pick = eps.find((e) => !e.watched) ?? eps[0]
      if (!pick) throw new SourceError('This season has no episodes.', 'notFound')
      it = pick
    }
    const dur = it.runtimeSec ?? 600
    const detail = await this.item(it.id)
    const audio = detail.audioTracks ?? []
    const subtitles = detail.subtitleTracks ?? []
    const startSec = opts.resume ? it.positionSec ?? 0 : 0
    let next: MediaItem | undefined
    if (it.type === 'episode' && it.seriesId) {
      const eps = this.episodesOf(it.seriesId)
      const idx = eps.findIndex((e) => e.id === it.id)
      next = eps[idx + 1] ? this.copy(eps[idx + 1] as MediaItem) : undefined
    }
    return {
      url: `av://lavfi:testsrc2=size=1280x720:rate=25:duration=${dur}`,
      headers: {},
      startSec,
      durationSec: dur,
      subtitles: [],
      selection: {
        audio: opts.audioIdx === undefined ? undefined : audio.findIndex((t) => t.index === opts.audioIdx) + 1 || undefined,
        subtitle: opts.subIdx === -1 ? null : opts.subIdx === undefined ? undefined :
          subtitles.findIndex((t) => t.index === opts.subIdx) + 1 || undefined,
      },
      tracks: {
        audio: audio.map((t, i) => ({ index: i + 1, label: t.label, selected: t.default === true })),
        subtitles: subtitles.map((t, i) => ({ index: i + 1, label: t.label, selected: t.default === true })),
      },
      method: 'direct',
      report: { sourceId: this.id, itemId: it.id, data: { play: 'fixture' } },
      next,
      item: this.copy(it),
    }
  }

  async report(h: ReportHandle, e: ReportEvent): Promise<void> {
    const it = this.byId.get(h.itemId)
    if (!it || this.offline) return
    this.clock += 60_000
    it.lastPlayedAt = new Date(this.clock).toISOString()
    const dur = it.runtimeSec ?? 0
    if (e.state === 'stopped' && dur > 0 && e.positionSec >= dur * 0.9) {
      it.watched = true
      it.positionSec = 0
      it.progress = 1
    } else {
      it.positionSec = Math.max(0, Math.floor(e.positionSec))
      it.progress = dur > 0 ? Math.min(1, it.positionSec / dur) : 0
    }
    if (it.seriesId) this.refreshShow(it.seriesId)
  }

  async setWatched(id: string, watched: boolean): Promise<void> {
    await this.wait()
    const it = this.get(id)
    const targets = it.type === 'show' ? this.episodesOf(id) : it.type === 'season' ?
      this.cat.episodes.filter((e) => e.seasonId === id) : [it]
    for (const t of targets) {
      t.watched = watched
      t.positionSec = 0
      t.progress = watched ? 1 : 0
    }
    if (it.type === 'movie') return
    this.refreshShow(it.type === 'show' ? id : (it.seriesId as string))
  }

  async setFavourite(id: string, fav: boolean): Promise<void> {
    await this.wait()
    this.get(id).favourite = fav
  }

  dispose(): void {}
}

function sortTitle(t: string): string {
  return t.replace(/^(the|a|an)\s+/i, '')
}
