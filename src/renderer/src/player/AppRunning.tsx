// Shown while a streaming app has the screen. On the box the app's own Chrome window is on top, so this is
// only seen briefly while it opens; in mock mode (Windows dev) it stands in for the app.
import type { ReactNode } from 'react'
import { call } from '../lib/api'
import { useStore } from '../lib/store'
import { useCall } from '../lib/useCall'
import { LAYER, useInputLayer } from '../input/input'
import { foregroundStore } from '../state/player'
import { Icon } from '../components/Icon'
import { AppIcon } from '../components/Tile'

function closeApp(): void {
  void call('apps.close').catch(() => undefined)
}

export function AppRunning(): ReactNode {
  const fg = useStore(foregroundStore)
  const appId = fg.kind === 'app' ? fg.appId : undefined
  const apps = useCall('apps.list', [], Boolean(appId))
  const app = apps.data?.find((a) => a.id === appId)

  useInputLayer(
    LAYER.player,
    (action) => {
      if (action === 'back' || action === 'stop' || action === 'select') {
        closeApp()
        return true
      }
      return !['home', 'power', 'recovery', 'volumeUp', 'volumeDown', 'mute'].includes(action)
    },
    Boolean(appId),
  )

  if (!appId) return null
  return (
    <div className="app-running" data-testid="app-running" style={{ background: app?.colour }}>
      <div className="app-running-card">
        <div className="app-running-name" role="img" aria-label={app?.name ?? 'App'} style={{ color: app?.accent ?? '#fff' }}>
          {app ? <AppIcon key={app.id} app={app} /> : 'App'}
        </div>
        <p>
          {app?.nav === 'pointer'
            ? "This app needs a pointer: hold Menu to turn the remote's arrows into a pointer, or use a mouse."
            : 'Use the arrows and OK to move around the app.'}
        </p>
        <p className="app-running-help">
          <Icon name="back" size="1.3rem" /> Press Back (or OK here) to close the app and return to MediaOS. Home also works at any time.
        </p>
      </div>
    </div>
  )
}
