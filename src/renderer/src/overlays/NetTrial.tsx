// "Keep these settings?": shown while main tests new IP settings (docs/design/network.md section 2). The old
// settings come back by themselves unless the user keeps the new ones. Drawn outside the overlay list so menus
// (Power, Recovery) can still open above it.
import { useEffect, type ReactNode } from 'react'
import type { NetCheck, NetTrial as Trial } from '@shared/system-types'
import { useStore } from '../lib/store'
import { LAYER, useInputLayer } from '../input/input'
import { focus, moveFocus, pressFocused } from '../input/focus'
import { beginModal, endModal, overlayStore } from '../state/nav'
import { keepTrial, netTrialStore, resetNetwork, revertTrial, trialShowing, watchNetTrial } from '../state/netTrial'
import { Button, FocusGroup, cx } from '../components/Focusable'
import { Icon } from '../components/Icon'

const GROUP = 'nettrial'

export function NetTrial(): ReactNode {
  const view = useStore(netTrialStore)
  const showing = trialShowing(view)
  const failed = view.failed !== undefined

  useEffect(() => watchNetTrial(), [])

  useEffect(() => {
    if (!showing) return
    beginModal(GROUP)
    return () => endModal()
  }, [showing])

  // The first button: Put back while the trial runs, Reset once putting back has failed.
  useEffect(() => {
    if (!showing || overlayStore.get().length > 0) return
    focus(`${GROUP}:${failed ? 'reset' : 'revert'}`)
  }, [showing, failed])

  useInputLayer(
    LAYER.overlay + 5,
    (action) => {
      // A menu opened above the dialog (Power, Recovery) handles its own keys.
      if (overlayStore.get().length > 0) return false
      switch (action) {
        case 'up':
        case 'down':
        case 'left':
        case 'right':
          moveFocus(action, GROUP)
          return true
        case 'select':
          pressFocused(GROUP)
          return true
        case 'back':
          if (failed) netTrialStore.set({ trial: null })
          else void revertTrial()
          return true
        case 'power':
        case 'recovery':
        case 'volumeUp':
        case 'volumeDown':
        case 'mute':
          return false
        default:
          // Short Home, Menu, Play/Pause: the choice here comes first.
          return true
      }
    },
    showing,
  )

  if (!showing) return null
  return (
    <div className="scrim scrim-trial" data-testid="net-trial">
      <FocusGroup focusKey={GROUP} boundary className="panel panel-centre panel-trial" role="alertdialog" label="Keep these settings?">
        {failed ? <Failed /> : view.trial && <Checking trial={view.trial} busy={view.busy} />}
      </FocusGroup>
    </div>
  )
}

const CHECK_TEXT: Record<'router' | 'web', Record<NetCheck, string>> = {
  router: { checking: 'Checking…', ok: 'Answering', failed: 'Not answering' },
  web: { checking: 'Checking…', ok: 'Working', failed: 'Not working' },
}

function CheckRow({ label, state, kind, testId }: { label: string; state: NetCheck; kind: 'router' | 'web'; testId: string }): ReactNode {
  return (
    <div className={cx('trial-row', `is-${state}`)} data-testid={testId} data-state={state}>
      <span className="trial-label">{label}</span>
      <span className="trial-value">
        {state === 'ok' && <Icon name="check" size="1.2rem" />}
        {state === 'failed' && <Icon name="warning" size="1.2rem" />}
        {CHECK_TEXT[kind][state]}
      </span>
    </div>
  )
}

function Checking({ trial, busy }: { trial: Trial; busy: string | undefined }): ReactNode {
  const routerFailed = trial.router === 'failed'
  const webFailed = !routerFailed && (trial.dns === 'failed' || trial.internet === 'failed')
  return (
    <>
      <h2 className="panel-title">Keep these settings?</h2>
      <p className="panel-sub">New IP settings for {trial.name}</p>
      <div className="trial-checks">
        <div className="trial-row" data-testid="net-trial-address">
          <span className="trial-label">Address</span>
          <span className="trial-value">{trial.address ?? 'Getting an address…'}</span>
        </div>
        <CheckRow label="Router" state={trial.router} kind="router" testId="net-trial-router" />
        <CheckRow label="Finding websites (DNS)" state={trial.dns} kind="web" testId="net-trial-dns" />
        <CheckRow label="Internet" state={trial.internet} kind="web" testId="net-trial-internet" />
      </div>
      {routerFailed && (
        <p className="trial-warning" role="alert">
          The box can't reach the router with these settings. Put back the old settings, then check the numbers.
        </p>
      )}
      {webFailed && (
        <p className="trial-warning" role="alert">
          The box reaches the router but not the internet. Keep these only if you're sure.
        </p>
      )}
      <p className="trial-countdown" data-testid="net-trial-countdown">
        {busy === 'revert'
          ? 'Putting the old settings back…'
          : busy === 'keep'
            ? 'Saving the new settings…'
            : trial.phase === 'applying'
              ? 'Trying the new settings…'
              : `If you do nothing, the old settings come back in ${trial.secondsLeft} seconds.`}
      </p>
      <div className="panel-actions">
        <Button focusKey={`${GROUP}:revert`} label="Put back the old settings" testId="net-trial-revert"
          onSelect={() => void revertTrial()} />
        <Button focusKey={`${GROUP}:keep`} label="Keep these settings" primary disabled={!trial.canKeep}
          testId="net-trial-keep" onSelect={() => void keepTrial()} />
      </div>
    </>
  )
}

function Failed(): ReactNode {
  return (
    <>
      <h2 className="panel-title">Couldn't put the old network settings back</h2>
      <p className="panel-body" role="alert" data-testid="net-trial-failed">
        Set the network back to automatic to get the box online again. The cable and every saved Wi-Fi network go
        back to Automatic. Saved Wi-Fi passwords are kept.
      </p>
      <div className="panel-actions">
        <Button focusKey={`${GROUP}:close`} label="Close" testId="net-trial-close" onSelect={() => netTrialStore.set({ trial: null })} />
        <Button focusKey={`${GROUP}:reset`} label="Reset network to automatic" primary testId="net-trial-reset"
          onSelect={() => void resetNetwork()} />
      </div>
    </>
  )
}
