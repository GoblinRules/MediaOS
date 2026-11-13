// Details for a film, show or episode: artwork, facts, Play/Resume, watched and favourite, audio and subtitle
// choice, and for shows the seasons with their episodes.
import { useCallback, useState, type ReactNode } from 'react'
import type { MediaItem, MediaItemDetail, Track } from '@shared/media-types'
import { formatRuntime, formatTimeLeft, itemKey } from '@shared/media-types'
import { run } from '../lib/api'
import { exists } from '../input/focus'
import { useCall, type CallState } from '../lib/useCall'
import { canFavourite, hasResume, isPlayable, setFavourite, setWatched } from '../lib/items'
import { useSettings } from '../state/settings'
import { menu, push, useScreenFocus, type Entry, type MenuItem } from '../state/nav'
import { Button, Focusable, FocusGroup, cx } from '../components/Focusable'
import { Row, Notice, Spinner } from '../components/Row'
import { MediaTile } from '../components/Tile'
import { Icon } from '../components/Icon'
import { Backdrop } from './Home'

interface TrackChoice {
  audio?: number
  sub?: number
}

function trackItems(tracks: Track[], selected: number | undefined, pick: (i: number | undefined) => void, withOff: boolean): MenuItem[] {
  const items: MenuItem[] = []
  if (withOff) items.push({ id: 'off', label: 'Off', checked: selected === -1, onSelect: () => pick(-1) })
  items.push({ id: 'auto', label: 'Automatic', detail: 'Uses your Playback settings', checked: selected === undefined, onSelect: () => pick(undefined) })
  for (const t of tracks) {
    const extra = [t.codec?.toUpperCase(), t.forced ? 'Forced' : undefined, t.external ? 'External' : undefined].filter(Boolean).join(' · ')
    items.push({ id: `t${t.index}`, label: t.label, detail: extra || undefined, checked: selected === t.index, onSelect: () => pick(t.index) })
  }
  return items
}

const DEFAULT_BUTTONS = ['det:resume', 'det:play', 'det:watched']

/** The season the user was in when they left this screen (a season tab or one of its episodes had focus). */
function seasonFromEntry(entry: Entry): string | undefined {
  const group = entry.focusSpot?.group
  if (group?.startsWith('det:eps:')) return group.slice('det:eps:'.length)
  if (entry.focusKey?.startsWith('det:season:')) return entry.focusKey.slice('det:season:'.length)
  return undefined
}

export function DetailsScreen({ entry, itemKey: key }: { entry: Entry; itemKey: string }): ReactNode {
  const detail = useCall('items.get', [key])
  const d = detail.data
  useSettings() // the favourite button depends on which kind of server the item is from
  const [choice, setChoice] = useState<TrackChoice>({})
  const seasons = (d?.type === 'show' && d.seasons) || []
  const defaultSeason = seasons.find((s) => s.id === d?.nextEpisode?.seasonId) ?? seasons[0]
  // Coming Back, the season the user was in; a season that has since gone falls back to the default.
  const [picked, setPicked] = useState(() => seasonFromEntry(entry))
  const season = seasons.find((s) => s.key === picked) ?? defaultSeason
  const episodes = useCall('items.children', [season?.key ?? key], Boolean(season))
  // Coming Back to an episode: wait for its season's episodes, so focus goes back to it rather than a button.
  const toEpisode = Boolean(season && entry.focusKey?.startsWith('det:ep:'))
  const ready = Boolean(detail.error || (d && (!toEpisode || episodes.data || episodes.error)))
  // Resume, else Play, else (a show watched to the end has no Play button) the first of the other buttons.
  const fallback = useCallback(() => (d ? DEFAULT_BUTTONS.find(exists) : 'det:retry'), [d])
  useScreenFocus(entry, ready, fallback)

  if (!d) {
    return (
      <div className="page details" data-testid="details">
        {detail.error ? (
          <FocusGroup focusKey="det:err">
            <Notice icon={<Icon name="warning" size="3rem" />} title="Could not load this" body={detail.error}>
              <Button focusKey="det:retry" label="Try again" primary onSelect={detail.reload} />
            </Notice>
          </FocusGroup>
        ) : (
          <Spinner />
        )}
      </div>
    )
  }

  const playOpts = (resume: boolean): { resume: boolean; audioIdx?: number; subIdx?: number } => ({
    resume,
    ...(choice.audio !== undefined ? { audioIdx: choice.audio } : {}),
    ...(choice.sub !== undefined ? { subIdx: choice.sub } : {}),
  })
  const playItem = (item: MediaItem, resume: boolean): void => {
    void run('player.play', item.key, item.key === d.key ? playOpts(resume) : { resume })
  }

  return (
    <div className="details" data-testid="details">
      <Backdrop item={d} />
      <FocusGroup focusKey="det" className="details-scroll" scroll="y">
        <section className="details-hero" data-reveal="top">
          <Facts d={d} />
          <FocusGroup focusKey="det:actions" className="details-actions" testId="details-actions">
            <PlayButtons d={d} playItem={playItem} />
            {isPlayable(d) && d.audioTracks.length > 1 && (
              <Button
                focusKey="det:audio"
                label="Audio"
                icon={<Icon name="sound" />}
                onSelect={() => menu('Audio', trackItems(d.audioTracks, choice.audio, (i) => setChoice((c) => ({ ...c, audio: i })), false))}
              />
            )}
            {isPlayable(d) && d.subtitleTracks.length > 0 && (
              <Button
                focusKey="det:subs"
                label="Subtitles"
                icon={<Icon name="subtitles" />}
                onSelect={() => menu('Subtitles', trackItems(d.subtitleTracks, choice.sub, (i) => setChoice((c) => ({ ...c, sub: i })), true))}
              />
            )}
            <Button
              focusKey="det:watched"
              label={d.watched ? 'Watched' : 'Mark watched'}
              icon={<Icon name={d.watched ? 'check' : 'eye'} />}
              testId="details-watched"
              onSelect={() => void setWatched(d, !d.watched)}
            />
            {canFavourite(d.sourceId) && <Button
              focusKey="det:fav"
              label={d.favourite ? 'Favourite' : 'Add to favourites'}
              icon={<Icon name="heart" className={cx(d.favourite && 'icon-filled')} />}
              onSelect={() => void setFavourite(d, !d.favourite)}
            />}
            {d.type === 'episode' && d.seriesId && (
              <Button
                focusKey="det:series"
                label="Go to series"
                icon={<Icon name="tv" />}
                onSelect={() => push({ name: 'details', key: itemKey(d.sourceId, d.seriesId!) })}
              />
            )}
          </FocusGroup>
        </section>
        {season && <Seasons seasons={seasons} season={season} pick={setPicked} episodes={episodes} />}
        {d.cast && d.cast.length > 0 && (
          <section className="details-cast" data-reveal="">
            <h2 className="row-title">Cast</h2>
            <p>{d.cast.slice(0, 12).map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ')}</p>
          </section>
        )}
      </FocusGroup>
    </div>
  )
}

function Facts({ d }: { d: MediaItemDetail }): ReactNode {
  const meta = [
    d.type === 'episode' && d.seasonNumber !== undefined ? `Season ${d.seasonNumber}, episode ${d.episodeNumber ?? '?'}` : undefined,
    d.year ? String(d.year) : undefined,
    d.officialRating,
    formatRuntime(d.runtimeSec),
    d.communityRating ? `★ ${d.communityRating.toFixed(1)}` : undefined,
  ].filter(Boolean)
  return (
    <div className="details-facts">
      {d.type === 'episode' && d.seriesTitle && <div className="details-kicker">{d.seriesTitle}</div>}
      <h1 className="details-title">{d.title}</h1>
      <div className="details-meta">{meta.join('  ·  ')}</div>
      {d.genres && d.genres.length > 0 && <div className="details-genres">{d.genres.slice(0, 4).join(' · ')}</div>}
      {d.tagline && <p className="details-tagline">{d.tagline}</p>}
      {d.overview && <p className="details-overview">{d.overview}</p>}
      <div className="details-tech">
        {[d.videoInfo, d.audioInfo, d.directors?.length ? `Directed by ${d.directors.join(', ')}` : undefined].filter(Boolean).join('   ·   ')}
      </div>
    </div>
  )
}

function PlayButtons({ d, playItem }: { d: MediaItemDetail; playItem: (item: MediaItem, resume: boolean) => void }): ReactNode {
  if (d.type === 'show' || d.type === 'season') {
    const next = d.nextEpisode
    if (!next) return null
    const se = next.seasonNumber !== undefined ? `S${next.seasonNumber} E${next.episodeNumber ?? '?'}` : next.title
    return (
      <Button
        focusKey="det:play"
        primary
        icon={<Icon name="play" />}
        label={hasResume(next) ? `Resume ${se}` : `Play ${se}`}
        testId="details-play"
        onSelect={() => playItem(next, hasResume(next))}
      />
    )
  }
  if (!isPlayable(d)) return null
  if (hasResume(d)) {
    return (
      <>
        <Button
          focusKey="det:resume"
          primary
          icon={<Icon name="play" />}
          label={`Resume (${formatTimeLeft(d)})`}
          testId="details-resume"
          onSelect={() => playItem(d, true)}
        />
        {/* Its own key: coming back after playing with Play (now gone) must land on Resume, not on this button. */}
        <Button focusKey="det:start" icon={<Icon name="restart" />} label="Play from the beginning" testId="details-start" onSelect={() => playItem(d, false)} />
      </>
    )
  }
  return <Button focusKey="det:play" primary icon={<Icon name="play" />} label="Play" testId="details-play" onSelect={() => playItem(d, false)} />
}

function Seasons({ seasons, season, pick, episodes }: {
  seasons: MediaItem[]
  season: MediaItem
  pick: (key: string) => void
  episodes: CallState<MediaItem[]>
}): ReactNode {
  return (
    <>
      <FocusGroup focusKey="det:seasons" className="season-tabs" revealBlock testId="season-tabs">
        {seasons.map((s) => (
          <Focusable
            key={s.key}
            focusKey={`det:season:${s.key}`}
            role="tab"
            className={cx('season-tab', s.key === season.key && 'is-active')}
            label={s.title}
            onSelect={() => pick(s.key)}
            onFocused={() => pick(s.key)}
          >
            {s.title}
            {s.unwatchedCount ? <span className="tile-badge">{s.unwatchedCount}</span> : null}
          </Focusable>
        ))}
      </FocusGroup>
      {episodes.loading && !episodes.data && <Spinner label="Loading episodes" />}
      {episodes.error && <Notice title="Episodes could not load" body={episodes.error} />}
      {episodes.data && (
        // Keyed by season: Norigin registers a group's name only when it mounts, so a reused row would keep the old name.
        <Row key={season.key} focusKey={`det:eps:${season.key}`} title={`${episodes.data.length} episodes`} testId="episodes">
          {episodes.data.map((ep) => (
            <MediaTile
              key={ep.key}
              focusKey={`det:ep:${ep.key}`}
              item={ep}
              shape="landscape"
              onSelect={() => void run('player.play', ep.key, { resume: hasResume(ep) })}
              // The season shown is the one the user is in: marking this episode watched (which changes the show's
              // next episode, and so its default season) must not switch to another season under them.
              onFocused={() => pick(season.key)}
            />
          ))}
        </Row>
      )}
    </>
  )
}
