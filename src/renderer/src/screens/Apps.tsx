// Apps: every streaming app as a big tile. Menu on an app: add to Home, hide, sign out.
import { useCallback, type ReactNode } from 'react'
import type { AppEntry } from '@shared/apps'
import { useCall } from '../lib/useCall'
import { exists, lostKey } from '../input/focus'
import { launchApp, openAppMenu } from '../lib/apps'
import { useScreenFocus, type Entry } from '../state/nav'
import { useSettings } from '../state/settings'
import { Button, FocusGroup } from '../components/Focusable'
import { Notice, Spinner } from '../components/Row'
import { AppTile } from '../components/Tile'
import { Icon } from '../components/Icon'

function Grid({ apps, prefix }: { apps: AppEntry[]; prefix: string }): ReactNode {
  return (
    <div className="app-grid" data-focus-section="">
      {apps.map((app) => (
        <div key={app.id} data-reveal="" className="grid-cell">
          <AppTile focusKey={`${prefix}:${app.id}`} app={app} onSelect={() => void launchApp(app)} onMenu={() => openAppMenu(app)} />
        </div>
      ))}
    </div>
  )
}

/** An app shown again (or hidden) moves to another grid under a new key: where it is now, if it still exists. */
function movedTo(lost: string | undefined): string | undefined {
  const m = lost ? /^apps(?:-hidden|-blocked)?:(.+)$/.exec(lost) : null
  if (!m) return undefined
  return ['apps', 'apps-blocked', 'apps-hidden'].map((p) => `${p}:${m[1]}`).find(exists)
}

export function AppsScreen({ entry }: { entry: Entry }): ReactNode {
  const settings = useSettings()
  const apps = useCall('apps.list', [])
  const hidden = new Set(settings.apps.hidden)
  const all = apps.data ?? []
  const shown = all.filter((a) => !hidden.has(a.id) && !a.blocked)
  const blocked = all.filter((a) => !hidden.has(a.id) && a.blocked)
  const hiddenApps = all.filter((a) => hidden.has(a.id))
  const firstKey = shown[0] ? `apps:${shown[0].id}` : apps.error ? 'apps:retry' : undefined
  // The app list and hidden set are listed so an app hidden from the grid hands focus to the one now in its place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fallback = useCallback(() => movedTo(lostKey()) ?? firstKey, [firstKey, apps.data, settings.apps.hidden])
  useScreenFocus(entry, Boolean(apps.data || apps.error), fallback)

  return (
    <FocusGroup focusKey="apps" className="page" scroll="y" testId="apps">
      <h1 className="page-title">Apps</h1>
      <p className="page-hint">
        Apps open full screen in a browser. Hold Back (or press Home) to come back here. Press Menu on an app to add it to Home or
        hide it.
      </p>
      {!apps.data && !apps.error && <Spinner />}
      {apps.error && !apps.data && (
        <Notice icon={<Icon name="warning" size="3rem" />} title="Apps could not load" body={apps.error}>
          <Button focusKey="apps:retry" label="Try again" primary onSelect={apps.reload} />
        </Notice>
      )}
      <Grid apps={shown} prefix="apps" />
      {blocked.length > 0 && (
        <section data-reveal="">
          <h2 className="row-title">Not available on this box</h2>
          <p className="page-hint">These services block Linux browsers or limit them to low quality. Use the TV&apos;s own app instead.</p>
          <Grid apps={blocked} prefix="apps-blocked" />
        </section>
      )}
      {hiddenApps.length > 0 && (
        <section data-reveal="">
          <h2 className="row-title">Hidden apps</h2>
          <Grid apps={hiddenApps} prefix="apps-hidden" />
        </section>
      )}
    </FocusGroup>
  )
}
