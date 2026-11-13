// Home: a banner about the focused item over its backdrop art, then rows (Continue watching, Next up, Apps,
// Recently added, one row per library). The rows and their order come from Settings > Home screen.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppEntry } from '@shared/apps'
import type { HomeData, HomeRow, MediaItem } from '@shared/media-types'
import { formatRuntime, formatTimeLeft } from '@shared/media-types'
import type { Settings } from '@shared/settings-schema'
import { useCall } from '../lib/useCall'
import { useStore } from '../lib/store'
import { describeItem, focusedItem, hasResume, selectItem } from '../lib/items'
import { launchApp, openAppMenu } from '../lib/apps'
import { goTab, restartScreenFocus, useScreenFocus, type Entry } from '../state/nav'
import { useSettings } from '../state/settings'
import { FocusGroup, Button } from '../components/Focusable'
import { Row, Notice, Spinner } from '../components/Row'
import { AppTile, Art, MediaTile } from '../components/Tile'
import { Icon } from '../components/Icon'

interface ViewRow {
  id: string
  title: string
  kind: 'media' | 'apps'
  items: MediaItem[]
  apps: AppEntry[]
  landscape: boolean
  playDirectly: boolean
}

export function buildRows(home: HomeData | undefined, apps: AppEntry[] | undefined, s: Settings): ViewRow[] {
  const out: ViewRow[] = []
  const hidden = new Set(s.home.hiddenRows)
  for (const id of s.home.rows) {
    if (hidden.has(id)) continue
    if (id === 'apps') {
      const byId = new Map((apps ?? []).map((a) => [a.id, a]))
      const pinned = s.apps.pinned.map((p) => byId.get(p)).filter((a): a is AppEntry => Boolean(a && !a.blocked))
      if (pinned.length > 0) out.push({ id: 'apps', title: 'Apps', kind: 'apps', items: [], apps: pinned, landscape: true, playDirectly: false })
      continue
    }
    const kinds: HomeRow['kind'][] = id === 'libraries' ? ['library'] : [id]
    for (const row of home?.rows ?? []) {
      if (!kinds.includes(row.kind) || row.items.length === 0) continue
      const landscape = row.kind === 'continue' || row.kind === 'nextUp'
      out.push({ id: row.id, title: row.title, kind: 'media', items: row.items, apps: [], landscape, playDirectly: landscape })
    }
  }
  return out
}

function tileKey(row: ViewRow, id: string): string {
  return `home:${row.id}:${id}`
}

export function HomeScreen({ entry }: { entry: Entry }): ReactNode {
  const settings = useSettings()
  const home = useCall('home.get', [])
  const apps = useCall('apps.list', [])
  const rows = useMemo(() => buildRows(home.data, apps.data, settings), [home.data, apps.data, settings])
  const sources = home.data?.sources ?? []
  const noSources = Boolean(home.data) && sources.length === 0
  const problems = sources.filter((s) => s.status !== 'ok' && s.status !== 'connecting')

  const failed = Boolean(home.error && !home.data)
  const ready = Boolean((home.data || home.error) && (apps.data || apps.error))
  // Loaded, but every row is empty or switched off: say so, with a way out, so focus always has somewhere to go.
  const nothing = ready && rows.length === 0 && !noSources && !failed
  const allRowsOff = settings.home.rows.every((id) => settings.home.hiddenRows.includes(id))

  const first = rows[0]
  const firstId = first ? (first.kind === 'apps' ? first.apps[0]?.id : first.items[0]?.key) : undefined
  const firstKey = first && firstId
    ? tileKey(first, firstId)
    : noSources ? 'home:add-server' : failed ? 'home:retry' : nothing ? 'home:nothing-settings' : undefined
  // Rows are listed so a tile that leaves Home (marked as watched, say) hands focus to the one now in its place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fallback = useCallback(() => firstKey, [firstKey, rows])
  useScreenFocus(entry, ready, fallback)
  const reloadHome = home.reload
  const retry = useCallback(() => {
    // The button disappears while Home reloads, so focus the screen afresh once it has loaded.
    restartScreenFocus()
    reloadHome()
  }, [reloadHome])

  return (
    <div className="home" data-testid="home">
      <Backdrop />
      {settings.home.hero && <Banner fallback={home.data?.hero[0]} />}
      <FocusGroup focusKey="home:rows" className="home-rows" scroll="y" rows testId="home-rows">
        {problems.map((s) => (
          <div className="banner-warn" key={s.id} data-testid="source-problem">
            <Icon name="warning" size="1.4rem" />
            <span>{s.message ?? `Can't reach ${s.name}. Check the server is switched on.`}</span>
          </div>
        ))}
        {noSources && (
          <FocusGroup focusKey="home:empty" className="home-empty" revealBlock>
            <Notice
              icon={<Icon name="server" size="3rem" />}
              title="Add your media"
              body="Connect a Jellyfin or Plex server to see your films and shows here."
              testId="home-no-sources"
            >
              <Button focusKey="home:add-server" label="Add a server" primary icon={<Icon name="plus" />} onSelect={() => goTab('settings', 'libraries')} />
            </Notice>
          </FocusGroup>
        )}
        {failed && (
          <FocusGroup focusKey="home:error" className="home-empty" revealBlock>
            <Notice icon={<Icon name="warning" size="3rem" />} title="Home could not load" body={home.error} testId="home-error">
              <Button focusKey="home:retry" label="Try again" primary icon={<Icon name="refresh" />} onSelect={retry} />
            </Notice>
          </FocusGroup>
        )}
        {nothing && (
          <FocusGroup focusKey="home:nothing" className="home-empty" revealBlock>
            <Notice
              icon={<Icon name="info" size="3rem" />}
              title="Nothing to show yet"
              body={
                allRowsOff
                  ? 'Every row on Home is switched off. Turn some back on in Settings > Home screen.'
                  : 'Your servers have nothing to show yet. Check they are connected in Settings > Libraries.'
              }
              testId="home-nothing"
            >
              <Button
                focusKey="home:nothing-settings"
                testId="home-nothing-settings"
                label={allRowsOff ? 'Home screen settings' : 'Check servers'}
                primary
                icon={<Icon name="settings" />}
                onSelect={() => goTab('settings', allRowsOff ? 'home' : 'libraries')}
              />
            </Notice>
          </FocusGroup>
        )}
        {!ready && rows.length === 0 && <Spinner label="Loading Home" />}
        {rows.map((row) => (
          <Row key={row.id} focusKey={`home:${row.id}`} title={row.title} testId={`row-${row.id}`}>
            {row.kind === 'apps'
              ? row.apps.map((app) => (
                  <AppTile
                    key={app.id}
                    focusKey={tileKey(row, app.id)}
                    app={app}
                    onSelect={() => void launchApp(app)}
                    onMenu={() => openAppMenu(app)}
                  />
                ))
              : row.items.map((item) => (
                  <MediaTile
                    key={item.key}
                    focusKey={tileKey(row, item.key)}
                    item={item}
                    shape={row.landscape ? 'landscape' : 'poster'}
                    onSelect={() => selectItem(item, row.playDirectly)}
                  />
                ))}
          </Row>
        ))}
        <div className="home-end" />
      </FocusGroup>
    </div>
  )
}

/** Full-screen artwork of the focused item (changes after focus rests briefly, so scrolling stays smooth). */
export function Backdrop({ item: fixed }: { item?: MediaItem }): ReactNode {
  const focused = useStore(focusedItem)
  const wanted = fixed ?? focused?.item
  const [shown, setShown] = useState<MediaItem | undefined>(wanted)
  useEffect(() => {
    const t = setTimeout(() => setShown(wanted), 250)
    return () => clearTimeout(t)
  }, [wanted])
  if (!shown || !(shown.images.backdrop || shown.images.thumb)) return <div className="backdrop backdrop-empty" />
  return (
    <div className="backdrop" key={shown.key}>
      <Art item={shown} kind="backdrop" w={1920} h={1080} />
      <div className="backdrop-shade" />
    </div>
  )
}

function Banner({ fallback }: { fallback?: MediaItem }): ReactNode {
  const focused = useStore(focusedItem)
  const item = focused?.focusKey.startsWith('home:') ? focused.item : fallback
  if (!item) return <div className="banner" />
  const meta = [
    describeItem(item),
    item.officialRating,
    item.type === 'show' ? undefined : hasResume(item) ? formatTimeLeft(item) : formatRuntime(item.runtimeSec),
    item.communityRating ? `★ ${item.communityRating.toFixed(1)}` : undefined,
  ].filter(Boolean)
  return (
    <section className="banner" data-testid="banner">
      <h1 className="banner-title">{item.type === 'episode' ? item.title : (item.seriesTitle ?? item.title)}</h1>
      <div className="banner-meta">{meta.join('  ·  ')}</div>
      {item.overview && <p className="banner-overview">{item.overview}</p>}
    </section>
  )
}
