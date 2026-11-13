// Libraries: every library from every server, as big cards grouped by server.
import { useCallback, type ReactNode } from 'react'
import type { Library, SourceInfo } from '@shared/media-types'
import { useCall } from '../lib/useCall'
import { goTab, push, useScreenFocus, type Entry } from '../state/nav'
import { Button, Focusable, FocusGroup } from '../components/Focusable'
import { Notice, Spinner } from '../components/Row'
import { Icon } from '../components/Icon'

const KIND_ICON: Record<Library['kind'], string> = { movies: 'film', shows: 'tv', mixed: 'libraries' }

function groups(libs: Library[], sources: SourceInfo[]): { source: SourceInfo | undefined; id: string; libs: Library[] }[] {
  const out = new Map<string, Library[]>()
  for (const l of libs) out.set(l.sourceId, [...(out.get(l.sourceId) ?? []), l])
  return [...out].map(([id, list]) => ({ id, source: sources.find((s) => s.id === id), libs: list }))
}

export function LibrariesScreen({ entry }: { entry: Entry }): ReactNode {
  const libs = useCall('libraries.list', [])
  const sources = useCall('sources.list', [])
  const list = groups(libs.data ?? [], sources.data ?? [])
  const firstKey = list[0]?.libs[0] ? `libs:${list[0].libs[0].key}` : libs.error ? 'libs:retry' : 'libs:add'
  const fallback = useCallback(() => firstKey, [firstKey])
  useScreenFocus(entry, Boolean(libs.data || libs.error), fallback)

  return (
    <FocusGroup focusKey="libs" className="page" scroll="y" testId="libraries">
      <h1 className="page-title">Libraries</h1>
      {!libs.data && !libs.error && <Spinner />}
      {libs.error && !libs.data && (
        <Notice icon={<Icon name="warning" size="3rem" />} title="Libraries could not load" body={libs.error}>
          <Button focusKey="libs:retry" label="Try again" primary onSelect={libs.reload} />
        </Notice>
      )}
      {libs.data && list.length === 0 && (
        <Notice
          icon={<Icon name="server" size="3rem" />}
          title="No libraries yet"
          body="Add a Jellyfin or Plex server and its libraries appear here."
          testId="libraries-empty"
        >
          <Button focusKey="libs:add" label="Add a server" primary icon={<Icon name="plus" />} onSelect={() => goTab('settings', 'libraries')} />
        </Notice>
      )}
      {list.map((g) => (
        <section key={g.id} className="lib-group" data-reveal="">
          <h2 className="row-title">
            {g.source?.name ?? 'Server'}
            {g.source && g.source.status !== 'ok' && <span className="lib-status">{g.source.message ?? 'Offline'}</span>}
          </h2>
          <div className="lib-grid">
            {g.libs.map((l) => (
              <Focusable
                key={l.key}
                focusKey={`libs:${l.key}`}
                className="lib-card"
                label={l.title}
                testId="library-card"
                onSelect={() => push({ name: 'library', key: l.key, title: l.title })}
              >
                <Icon name={KIND_ICON[l.kind]} size="2.6rem" />
                <span className="lib-title">{l.title}</span>
                {l.itemCount !== undefined && <span className="lib-count">{l.itemCount.toLocaleString('en-GB')} items</span>}
              </Focusable>
            ))}
          </div>
        </section>
      ))}
    </FocusGroup>
  )
}
