// The shell: top bar + the current screen, the player and running-app views, overlays and the screensaver.
// The app input layer gives Back, Home, Menu, Power and Play/Pause their meaning everywhere.
import { useEffect, type ReactNode } from 'react'
import { call, onEvent } from './lib/api'
import { useStore } from './lib/store'
import { invalidateData } from './lib/useCall'
import { focusedItem, play } from './lib/items'
import { LAYER, dispatch, noteScreenMove, useInputLayer } from './input/input'
import { currentFocus, focus, openFocusedMenu } from './input/focus'
import { closeAllOverlays, goTab, isTab, navStore, pop, resetTo, topEntry, type Entry } from './state/nav'
import { appRunning, foregroundStore, playerActive, playerStore } from './state/player'
import { useSettings } from './state/settings'
import { pushToast } from './state/toasts'
import { revertTrial, trialShowing } from './state/netTrial'
import { TopBar } from './components/TopBar'
import { Overlays } from './overlays/Overlays'
import { NetTrial } from './overlays/NetTrial'
import { openGeneralMenu, openPowerMenu, openRecoveryMenu } from './overlays/systemMenus'
import { Player } from './player/Player'
import { AppRunning } from './player/AppRunning'
import { Screensaver } from './player/Screensaver'
import { HomeScreen } from './screens/Home'
import { LibrariesScreen } from './screens/Libraries'
import { LibraryGrid } from './screens/LibraryGrid'
import { DetailsScreen } from './screens/Details'
import { SearchScreen } from './screens/Search'
import { AppsScreen } from './screens/Apps'
import { SettingsScreen } from './screens/settings/Settings'
import { SetupScreen } from './screens/Setup'

/** Home key: drop everything and go to the first tile of Home. */
export function goHome(): void {
  closeAllOverlays()
  if (playerActive()) void call('player.command', { kind: 'stop' })
  if (appRunning()) void call('apps.close')
  resetTo({ name: 'home' })
}

/** Back with nothing else to close: previous screen, then the top bar, then Home. */
function goBack(): void {
  if (pop()) return
  const route = topEntry().route
  if (route.name === 'setup') return
  const tab = isTab(route.name) ? route.name : 'home'
  if (!currentFocus()?.startsWith('tab:')) {
    if (focus(`tab:${tab}`)) noteScreenMove('back')
    return
  }
  if (tab !== 'home') goTab('home')
}

function playFocused(): void {
  const f = focusedItem.get()
  if (f && f.focusKey === currentFocus()) void play(f.item)
}

/**
 * Open the Power or Recovery menu. A network trial running at the time is undone first (the user may be pressing
 * these because the screen went wrong); the menu opens even if that fails.
 */
function openSystemMenu(open: () => void): void {
  const show = (): void => {
    closeAllOverlays()
    open()
  }
  if (!trialShowing()) show()
  else void revertTrial().then(show)
}

function useCoreEvents(): void {
  useEffect(() => {
    const offs = [
      onEvent('action', (p) => dispatch(p.action, { long: p.long ?? false })),
      onEvent('player', (s) => playerStore.set(s)),
      onEvent('foreground', (f) => foregroundStore.set(f)),
      onEvent('toast', (t) => pushToast(t)),
      onEvent('homeChanged', () => invalidateData()),
      onEvent('system', () => invalidateData()),
      onEvent('recovery', () => openSystemMenu(openRecoveryMenu)),
    ]
    call('shell.notices').then(
      (list) => list.forEach((t) => pushToast(t)),
      () => undefined,
    )
    call('player.state').then(
      (s) => playerStore.set(s),
      () => undefined,
    )
    return () => offs.forEach((off) => off())
  }, [])
}

export function App(): ReactNode {
  const settings = useSettings()
  const stack = useStore(navStore)
  const top: Entry = stack[stack.length - 1] ?? { id: 0, route: { name: 'home' } }
  useCoreEvents()

  useInputLayer(LAYER.app, (action) => {
    switch (action) {
      case 'back':
        goBack()
        return true
      case 'home':
        goHome()
        return true
      case 'menu':
        if (!openFocusedMenu()) openGeneralMenu()
        return true
      case 'power':
        openSystemMenu(openPowerMenu)
        return true
      case 'recovery':
        openSystemMenu(openRecoveryMenu)
        return true
      case 'playPause':
        playFocused()
        return true
      default:
        return false
    }
  })

  // Apply the text size setting (1rem = 16 px at 1080p, scaled).
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(settings.display.uiScale))
  }, [settings.display.uiScale])

  if (!settings.setupDone) {
    return (
      <div className="app">
        <SetupScreen />
        <Overlays />
        <NetTrial />
      </div>
    )
  }

  const route = top.route
  const tab = isTab(route.name) ? route.name : undefined
  return (
    <div className="app">
      {tab && <TopBar active={tab} />}
      <main className={tab ? 'screen screen-tab' : 'screen'} key={top.id}>
        <Screen entry={top} />
      </main>
      <Player />
      <AppRunning />
      <Overlays />
      <NetTrial />
      <Screensaver />
    </div>
  )
}

function Screen({ entry }: { entry: Entry }): ReactNode {
  const r = entry.route
  switch (r.name) {
    case 'home':
      return <HomeScreen entry={entry} />
    case 'libraries':
      return <LibrariesScreen entry={entry} />
    case 'apps':
      return <AppsScreen entry={entry} />
    case 'search':
      return <SearchScreen entry={entry} />
    case 'settings':
      return <SettingsScreen entry={entry} page={r.page} />
    case 'library':
      return <LibraryGrid entry={entry} libraryKey={r.key} title={r.title} />
    case 'details':
      return <DetailsScreen entry={entry} itemKey={r.key} />
    case 'setup':
      return <SetupScreen />
  }
}

/** Shown if core could not even give us the settings (should never happen; core falls back to defaults). */
export function StartupError({ message }: { message: string }): ReactNode {
  return (
    <div className="app startup-error" data-testid="startup-error">
      <h1>MediaOS could not start</h1>
      <p>{message}</p>
      <p>Turn the box off and on again. If this keeps happening, it may need to be set up again.</p>
    </div>
  )
}
