// First-run welcome: say hello, get online, add a Jellyfin or Plex server, then go to Home.
// Every step can be skipped; everything here is also in Settings.
import { useEffect, useState, type ReactNode } from 'react'
import { Button, FocusGroup } from '../components/Focusable'
import { Icon } from '../components/Icon'
import { LogoMark } from '../components/Logo'
import { setFocusFallback } from '../input/focus'
import { LAYER, useInputLayer } from '../input/input'
import { invalidateData, useCall } from '../lib/useCall'
import { focusScreen, resetTo } from '../state/nav'
import { loadSettings, updateSettings, useSettings } from '../state/settings'
import { SETUP_ORDER as ORDER, setupStep, type SetupStep } from '../state/setup'
import { useStore } from '../lib/store'
import { toast } from '../state/toasts'
import { NetworkPage } from './settings/devicePages'
import { SignInFlow, type SignInKind } from './settings/SignIn'

export function SetupScreen(): ReactNode {
  const step = useStore(setupStep)
  const [adding, setAdding] = useState<SignInKind>()
  const index = ORDER.indexOf(step)
  const go = (by: number): void => {
    const next = ORDER[index + by]
    if (next) setupStep.set(next)
  }
  // Setup always opens on the welcome step (for example after Erase everything).
  useEffect(() => setupStep.set('welcome'), [])
  // Recovery can jump to another step while a sign-in is open; that sign-in belongs to the libraries step only.
  if (step !== 'libraries' && adding) setAdding(undefined)
  // Adding a server is the point of the libraries step, so it starts there rather than on Skip.
  const first = step === 'libraries' ? 'setup:libraries:jellyfin' : `setup:${step}:next`

  // Each step starts on its main button; the fallback brings focus back if it is lost (after an overlay).
  useEffect(() => {
    if (adding) return
    setFocusFallback(() => first)
    focusScreen(first)
    return () => setFocusFallback(undefined)
  }, [first, adding])

  useInputLayer(LAYER.screen, (action) => {
    if (action !== 'back' || index === 0) return action === 'back'
    go(-1)
    return true
  })

  const finish = (): void =>
    void updateSettings({ setupDone: true }).then((ok) => {
      if (ok) resetTo({ name: 'home' })
    })

  return (
    <div className="setup" data-testid="setup" data-step={step}>
      <div className="setup-dots" aria-hidden>
        {ORDER.map((s, i) => (
          <span key={s} className={i <= index ? 'setup-dot is-done' : 'setup-dot'} />
        ))}
      </div>
      {step === 'welcome' && <Welcome onNext={() => go(1)} />}
      {step === 'network' && <NetworkStep onBack={() => go(-1)} onNext={() => go(1)} />}
      {step === 'libraries' && <LibrariesStep adding={adding} setAdding={setAdding} onBack={() => go(-1)} onNext={() => go(1)} />}
      {step === 'done' && <Done onBack={() => go(-1)} onFinish={finish} />}
    </div>
  )
}

function Actions(p: { step: SetupStep; onBack?: () => void; onNext: () => void; nextLabel: string }): ReactNode {
  return (
    <div className="setup-actions">
      {p.onBack && <Button focusKey={`setup:${p.step}:back`} label="Back" onSelect={p.onBack} testId="setup-back" />}
      <Button focusKey={`setup:${p.step}:next`} label={p.nextLabel} primary onSelect={p.onNext} testId="setup-next" />
    </div>
  )
}

function Welcome({ onNext }: { onNext: () => void }): ReactNode {
  const s = useSettings()
  return (
    <FocusGroup focusKey="setup:welcome" className="setup-step setup-centre">
      <LogoMark size="8rem" className="setup-hero" />
      <h1 className="setup-title">Welcome to {s.deviceName}</h1>
      <p className="setup-text">
        Three quick steps: get online, add your films and shows, and you are done. Use the arrows and OK on your remote. Back goes back a
        step.
      </p>
      <Actions step="welcome" onNext={onNext} nextLabel="Let's start" />
    </FocusGroup>
  )
}

function NetworkStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): ReactNode {
  const net = useCall('network.status', [])
  const online = net.data?.connected
  return (
    <FocusGroup focusKey="setup:network" className="setup-step" scroll="y">
      <h1 className="setup-title">Get online</h1>
      <p className="setup-text">
        {online
          ? 'You are connected. Press Next, or choose a different network below.'
          : 'Plug in a network cable, or choose your Wi-Fi network below.'}
      </p>
      <Actions step="network" onBack={onBack} onNext={onNext} nextLabel={online ? 'Next' : 'Skip for now'} />
      <div className="setup-panel">
        <NetworkPage k={(n) => `setup:network:${n}`} advanced={false} />
      </div>
    </FocusGroup>
  )
}

function LibrariesStep(p: {
  adding: SignInKind | undefined
  setAdding: (k: SignInKind | undefined) => void
  onBack: () => void
  onNext: () => void
}): ReactNode {
  const list = useCall('sources.list', [])
  // The Folders library is built in, so it isn't something the user added here.
  const added = (list.data ?? []).filter((s) => s.kind !== 'folders')

  if (p.adding) {
    return (
      <div className="setup-step">
        <SignInFlow
          kind={p.adding}
          prefix="setup:si"
          onCancel={() => p.setAdding(undefined)}
          onDone={(sources) => {
            toast(sources.length === 1 ? `Added ${sources[0]?.name ?? 'your server'}` : `Added ${sources.length} servers`, 'ok')
            p.setAdding(undefined)
            void loadSettings()
              .catch(() => undefined)
              .then(() => {
                invalidateData()
                list.reload()
              })
          }}
        />
      </div>
    )
  }

  return (
    <FocusGroup focusKey="setup:libraries" className="setup-step setup-centre">
      <h1 className="setup-title">Add your films and shows</h1>
      <p className="setup-text">
        MediaOS plays from your own Jellyfin or Plex server. You can add more, and network folders, later in
        Settings › Libraries. Streaming apps like Netflix and BBC iPlayer work without a server.
      </p>
      {added.length > 0 && (
        <ul className="setup-added" data-testid="setup-added">
          {added.map((s) => (
            <li key={s.id}>
              <Icon name="check" size="1.4rem" /> {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="setup-choices">
        <Button focusKey="setup:libraries:jellyfin" label="Add Jellyfin" icon={<Icon name="server" />} onSelect={() => p.setAdding('jellyfin')} testId="setup-add-jellyfin" />
        <Button focusKey="setup:libraries:plex" label="Add Plex" icon={<Icon name="server" />} onSelect={() => p.setAdding('plex')} testId="setup-add-plex" />
      </div>
      <Actions step="libraries" onBack={p.onBack} onNext={p.onNext} nextLabel={added.length > 0 ? 'Next' : 'Skip for now'} />
    </FocusGroup>
  )
}

function Done({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }): ReactNode {
  return (
    <FocusGroup focusKey="setup:done" className="setup-step setup-centre">
      <Icon name="check" size="6rem" className="setup-hero" />
      <h1 className="setup-title">You are all set</h1>
      <p className="setup-text">
        Press Home on your remote at any time to come back to the Home screen. Settings is at the top right. Hold Back to jump Home from
        anywhere.
      </p>
      <Actions step="done" onBack={onBack} onNext={onFinish} nextLabel="Start watching" />
    </FocusGroup>
  )
}
