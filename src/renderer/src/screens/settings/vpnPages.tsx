// Settings > VPN (docs/design/vpn.md section 7): the status, the on/off switch, locations, which apps use it, and
// "Add a VPN location". Main owns the tunnel and the import; this page draws what main sends and asks it for changes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppEntry } from '@shared/apps'
import { VPN_LABEL_MAX, type AppVpnChoice, type VpnImportError, type VpnImportStage, type VpnStatus } from '@shared/vpn-types'
import { call, errorText, run, tryCall } from '../../lib/api'
import { useCall } from '../../lib/useCall'
import { LAYER, useInputLayer } from '../../input/input'
import { confirm, focusScreen, keyboard, menu } from '../../state/nav'
import { toast } from '../../state/toasts'
import { appChoice, useVpn, vpnStore } from '../../state/vpn'
import { Button, FocusGroup } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { Qr } from '../../components/Qr'
import { Spinner } from '../../components/Row'
import { RowsState, Section, SettingRow, ToggleRow } from './parts'

type K = { k: (n: string) => string; prefix: string }

// ---------- Wording ----------

function locationLabel(s: VpnStatus): string {
  return s.locations.find((l) => l.id === s.activeLocationId)?.label ?? 'your VPN location'
}

/** The status line at the top of the page (vpn.md 7.2, and review L6 for a slow start). */
export function statusLine(s: VpnStatus): { label: string; detail?: string; tone: 'ok' | 'busy' | 'bad' | 'off' } {
  const where = locationLabel(s)
  switch (s.state) {
    case 'connected':
      return { label: `Connected to ${where}.`, tone: 'ok' }
    case 'connecting':
      return s.slow
        ? {
            label: `Connecting to ${where}...`,
            detail: "Your VPN provider didn't answer. The file may have expired. Download a new one from your provider's website.",
            tone: 'bad',
          }
        : { label: `Connecting to ${where}...`, tone: 'busy' }
    case 'not-working':
      return {
        label: `Connected to ${where}, but the VPN isn't working.`,
        detail: "Apps set to use it won't open until it's fixed.",
        tone: 'bad',
      }
    case 'down':
      return { label: 'Not connected.', detail: "Apps set to use the VPN won't open until it's back.", tone: 'bad' }
    default:
      return { label: 'The VPN is off.', detail: 'All apps connect directly.', tone: 'off' }
  }
}

const CHECK_TEXT: Record<VpnStatus['check'], string | undefined> = {
  idle: undefined,
  checking: 'Checking...',
  ok: 'The VPN is working.',
  failed: "The VPN isn't working. Check your VPN account is active, or try a different location.",
}

export const IMPORT_ERRORS: Record<VpnImportError, string> = {
  'no-network': "The TV isn't connected to your home network. Connect it in Settings > Network, then try again.",
  'upload-unavailable': "The TV couldn't open the upload page. Restart the TV box and try again.",
  'not-wireguard': "This isn't a WireGuard file. Download a WireGuard file from your VPN provider and try again.",
  'several-peers': 'This file has more than one server in it. Download the file for one location and try again.',
  'not-full-tunnel':
    'This file only sends some traffic through the VPN. Download a file that sends all traffic, often called a full tunnel.',
  'no-private-key': 'This file is missing its private key. Download it again from your VPN provider.',
  'too-large': "This file is too large. WireGuard files are small, so check you chose the right one.",
  expired: 'The code has expired. Press OK to get a new one.',
  'too-many-locations': 'You already have 5 locations. Remove one before adding another.',
  'save-failed': "The VPN location couldn't be saved. Restart the TV box and try again.",
}

const CHOICES: { value: AppVpnChoice; label: string; short: string; detail?: string }[] = [
  { value: 'direct', label: "Don't use the VPN", short: 'Not used' },
  { value: 'vpn-only', label: "Use the VPN. If it isn't working, don't open", short: 'VPN only', detail: 'Recommended' },
  { value: 'vpn-or-direct', label: "Use the VPN. If it isn't working, open without it", short: 'VPN if working' },
]

function appCount(n: number): string {
  if (n === 0) return 'No apps'
  return n === 1 ? '1 app' : `${n} apps`
}

/** Apps the VPN can be chosen for: everything that opens on this box and isn't locked to connect directly. */
function vpnApps(list: AppEntry[] | undefined): AppEntry[] {
  return (list ?? []).filter((a) => !a.blocked && a.vpn?.lock !== 'direct')
}

/** Back closes a sub-view of this page (not the whole Settings screen). */
function useBack(onBack: () => void): void {
  useInputLayer(LAYER.screen + 5, (action) => {
    if (action !== 'back') return false
    onBack()
    return true
  })
}

// ---------- The page ----------

type View = { v: 'main' } | { v: 'add' } | { v: 'apps' }

export function VpnPage({ k, prefix }: K): ReactNode {
  const status = useVpn()
  const apps = useCall('apps.list', [])
  const [view, setView] = useState<View>({ v: 'main' })
  // An object so asking for the same row twice still moves focus.
  const [refocus, setRefocus] = useState<{ key: string }>()
  const [loadError, setLoadError] = useState<string>()

  useEffect(() => {
    if (refocus) focusScreen(refocus.key)
  }, [refocus])

  // The app reads the status at start-up; if that failed, this page reads it again (and on Try again).
  const read = (): void => {
    call('vpn.status').then(
      (s) => vpnStore.set(s),
      (err: unknown) => setLoadError(errorText(err)),
    )
  }
  const reload = (): void => {
    setLoadError(undefined)
    read()
  }
  useEffect(() => {
    if (!vpnStore.get()) read()
    // Once per visit.
  }, [])

  const back = (key: string): void => {
    setView({ v: 'main' })
    setRefocus({ key })
  }

  if (!status) {
    return <RowsState loading={!loadError} error={loadError} focusKey={k('vpn-retry')} onRetry={reload} />
  }

  if (view.v === 'add') {
    return (
      <AddVpnFlow
        prefix={prefix}
        onCancel={() => back(k(status.locations.length > 0 ? 'add' : 'first-add'))}
        onDone={(chooseApps) => {
          if (chooseApps) setView({ v: 'apps' })
          else back(k('enabled'))
        }}
      />
    )
  }
  if (view.v === 'apps') {
    return <VpnAppsView prefix={prefix} status={status} apps={apps.data} onBack={() => back(k('apps'))} />
  }

  if (status.state === 'not-set-up') {
    return (
      <section className="set-section" data-testid="vpn-intro">
        <p className="set-section-hint">
          A VPN sends an app&apos;s internet traffic through a server somewhere else, such as the UK. You choose which apps use it.
          Jellyfin and Plex always connect directly on your home network.
        </p>
        <p className="set-section-hint">
          You&apos;ll need a WireGuard file from your VPN provider. Most providers let you download one from their website.
        </p>
        <div className="set-rows" data-focus-section="">
          <SettingRow focusKey={k('first-add')} icon="plus" label="Add a VPN location" onSelect={() => setView({ v: 'add' })} opens
            testId="vpn-add" />
        </div>
      </section>
    )
  }

  const appName = (id: string): string => apps.data?.find((a) => a.id === id)?.name ?? 'The app that is open'
  const line = statusLine(status)
  const used = vpnApps(apps.data).filter((a) => appChoice(a, status) !== 'direct').length

  const setEnabled = (on: boolean): void => {
    if (!on && status.appOnVpn) {
      confirm({
        title: 'Turn the VPN off?',
        body: `${appName(status.appOnVpn)} is using the VPN and will close. After this, all apps connect directly.`,
        confirmLabel: 'Turn off',
        onConfirm: () => void run('vpn.setEnabled', false),
      })
      return
    }
    void run('vpn.setEnabled', on)
  }

  const chooseLocation = (): void =>
    menu(
      'Location',
      status.locations.map((l) => ({
        id: l.id,
        label: l.label,
        checked: l.id === status.activeLocationId,
        onSelect: () => {
          if (l.id !== status.activeLocationId) void run('vpn.setLocation', l.id)
        },
      })),
    )

  const removeLocation = (): void =>
    menu(
      'Remove a location',
      status.locations.map((l) => ({
        id: l.id,
        label: l.label,
        icon: 'trash',
        onSelect: () =>
          confirm({
            title: `Remove ${l.label}?`,
            body:
              status.locations.length < 2
                ? "Apps set to use the VPN won't open until you add a location again."
                : status.enabled && l.id === status.activeLocationId
                  ? "The VPN will turn off, so apps set to use only the VPN won't open until you turn it on again. " +
                    'You can add this location again later with its WireGuard file.'
                  : 'You can add this location again later with its WireGuard file.',
            confirmLabel: 'Remove',
            danger: true,
            onConfirm: () =>
              void run('vpn.removeLocation', l.id).then((ok) => {
                if (ok) toast(`Removed ${l.label}`, 'ok')
              }),
          }),
      })),
    )

  const check = (): void => {
    if (status.check !== 'checking') void tryCall('vpn.check')
  }

  return (
    <>
      <Section title="Connection">
        <SettingRow
          focusKey={k('status')}
          icon={line.tone === 'ok' ? 'shield' : line.tone === 'bad' ? 'warning' : 'info'}
          label={line.label}
          detail={line.detail}
          testId="vpn-status"
        />
        <ToggleRow focusKey={k('enabled')} icon="shield" label="Use the VPN" on={status.enabled} onChange={setEnabled}
          testId="vpn-enabled" />
        <SettingRow
          focusKey={k('location')}
          icon="globe"
          label="Location"
          value={locationLabel(status)}
          onSelect={status.locations.length > 1 ? chooseLocation : undefined}
          opens={status.locations.length > 1}
          testId="vpn-location"
        />
        <SettingRow
          focusKey={k('apps')}
          icon="apps"
          label="Which apps use the VPN"
          value={appCount(used)}
          onSelect={() => setView({ v: 'apps' })}
          opens
          testId="vpn-apps"
        />
        <SettingRow
          focusKey={k('check')}
          icon="refresh"
          label="Check the VPN"
          detail={CHECK_TEXT[status.check]}
          onSelect={status.enabled ? check : undefined}
          disabled={!status.enabled}
          testId="vpn-check"
        />
      </Section>
      <Section title="Locations">
        <SettingRow focusKey={k('add')} icon="plus" label="Add a VPN location" onSelect={() => setView({ v: 'add' })} opens
          testId="vpn-add" />
        <SettingRow focusKey={k('remove')} icon="trash" label="Remove a location" onSelect={removeLocation} opens testId="vpn-remove" />
      </Section>
    </>
  )
}

// ---------- Which apps use the VPN (7.4) ----------

function VpnAppsView(p: { prefix: string; status: VpnStatus; apps: AppEntry[] | undefined; onBack: () => void }): ReactNode {
  const { status } = p
  useBack(p.onBack)
  const group = `${p.prefix}:vpnapps`
  const k = (n: string): string => `${group}:${n}`
  useEffect(() => {
    focusScreen(group)
  }, [group])

  const list = vpnApps(p.apps)
  const change = (app: AppEntry, choice: AppVpnChoice): void => {
    const send = (): void => void run('vpn.setAppVpn', app.id, choice)
    if (status.appOnVpn === app.id) {
      confirm({
        title: `Change ${app.name}?`,
        body: `${app.name} will close so the change can take effect.`,
        confirmLabel: 'Change',
        onConfirm: send,
      })
    } else send()
  }
  const pick = (app: AppEntry): void => {
    const now = appChoice(app, status)
    menu(
      app.name,
      CHOICES.map((c) => ({
        id: c.value,
        label: c.label,
        detail: c.detail,
        checked: c.value === now,
        onSelect: () => {
          if (c.value !== now) change(app, c.value)
        },
      })),
    )
  }
  const all = (choice: 'vpn-only' | 'direct'): void => {
    const send = (): void => void run('vpn.setAllApps', choice)
    if (status.appOnVpn && choice === 'direct') {
      const name = list.find((a) => a.id === status.appOnVpn)?.name ?? 'The app that is open'
      confirm({ title: 'Turn off for all apps?', body: `${name} will close so the change can take effect.`, confirmLabel: 'Turn off',
        onConfirm: send })
    } else send()
  }

  return (
    <div className="signin" data-testid="vpn-apps-view">
      <h2 className="signin-title">Which apps use the VPN</h2>
      <FocusGroup key={group} focusKey={group} className="signin-step">
        <div className="signin-actions">
          <Button focusKey={k('all-on')} label="Turn on for all apps" icon={<Icon name="shield" />} onSelect={() => all('vpn-only')}
            testId="vpn-all-on" />
          <Button focusKey={k('all-off')} label="Turn off for all apps" onSelect={() => all('direct')} testId="vpn-all-off" />
        </div>
        <div className="set-rows">
          {!p.apps && <div className="set-loading">Loading…</div>}
          {list.map((app) => {
            const now = CHOICES.find((c) => c.value === appChoice(app, status))
            return (
              <SettingRow
                key={app.id}
                focusKey={k(`app:${app.id}`)}
                icon={now?.value === 'direct' ? 'globe' : 'shield'}
                label={app.name}
                detail={app.vpn?.mayNotWork ? 'May not work over a VPN' : undefined}
                value={now?.short}
                onSelect={() => pick(app)}
                opens
                testId={`vpn-app-${app.id}`}
              />
            )
          })}
          <SettingRow
            focusKey={k('locked')}
            icon="lock"
            label="Jellyfin and Plex"
            detail="Always connect directly, whether the server is at home or elsewhere"
            disabled
          />
        </div>
        <p className="signin-note">
          Apps set to &quot;don&apos;t open&quot; never use your normal connection by mistake. Apps set to &quot;open without it&quot;
          will use your normal connection when the VPN isn&apos;t working, and tell you when they do.
        </p>
        <div className="signin-actions">
          <Button focusKey={k('back')} label="Done" icon={<Icon name="check" />} onSelect={p.onBack} testId="vpn-apps-done" />
        </div>
      </FocusGroup>
    </div>
  )
}

// ---------- Add a VPN location (7.3) ----------

function AddVpnFlow(p: { prefix: string; onDone: (chooseApps: boolean) => void; onCancel: () => void }): ReactNode {
  const status = useVpn()
  const [answered, setAnswered] = useState<VpnImportStage>()
  // Undefined until the user types a name; until then the suggested one shows.
  const [typed, setTyped] = useState<string>()
  // False once the user has left: answers that arrive after that must not change anything.
  const open = useRef(true)
  const { onDone, onCancel } = p

  const answer = (r: Promise<VpnImportStage>): void => {
    r.then(
      (s) => {
        if (open.current) setAnswered(s)
      },
      (err: unknown) => {
        if (open.current) toast(errorText(err), 'error')
      },
    )
  }
  const start = (): void => {
    setTyped(undefined)
    answer(call('vpn.startImport'))
  }

  useEffect(() => {
    open.current = true
    answer(call('vpn.startImport'))
    return () => {
      open.current = false
      void call('vpn.cancelImport').catch(() => undefined)
    }
    // Starts once per visit; leaving always cancels.
  }, [])

  // Main moves the flow on by itself too (a file arriving, the code expiring) and always puts the current stage in
  // the status, so that wins; the call's own answer covers the moment before the status event arrives.
  const stage = status?.import ?? answered
  const label = typed ?? (stage?.stage === 'name' ? stage.suggested : '')

  useBack(onCancel)

  const group = `${p.prefix}:vpnadd:${stage?.stage ?? 'start'}`
  // The name step starts on Save: the suggested name is usually right, and Name is one press up.
  useEffect(() => {
    focusScreen(group.endsWith(':name') ? `${group}:save` : group)
  }, [group])
  const k = (n: string): string => `${group}:${n}`

  const cancel = <Button focusKey={k('cancel')} label="Cancel" icon={<Icon name="close" />} onSelect={onCancel} testId="vpn-add-cancel" />
  const title = stage?.stage === 'choose' ? 'Choose a server' : stage?.stage === 'name' ? 'Name this location'
    : stage?.stage === 'error' ? "We couldn't use this file" : 'Add a VPN location'

  return (
    <div className="signin" data-testid="vpn-add-flow" data-step={stage?.stage ?? 'start'}>
      <h2 className="signin-title">{title}</h2>
      <FocusGroup key={group} focusKey={group} className="signin-step">
        {(!stage || stage.stage === 'saving') && (
          <>
            <Spinner label={stage ? 'Saving' : 'Starting'} />
            {stage && <p className="signin-text">Saving…</p>}
            {cancel}
          </>
        )}
        {stage?.stage === 'waiting' && <Waiting stage={stage} cancel={cancel} />}
        {stage?.stage === 'checking' && (
          <>
            <Spinner label="Checking" />
            <p className="signin-text">File received. Checking it...</p>
            {cancel}
          </>
        )}
        {stage?.stage === 'choose' && (
          <ChooseServer k={k} stage={stage} cancel={cancel} onPick={(id) => answer(call('vpn.chooseImportEntry', id))} />
        )}
        {stage?.stage === 'name' && (
          <>
            <p className="signin-text">Give it a short name you&apos;ll recognise, such as UK.</p>
            <div className="set-rows">
              <SettingRow
                focusKey={k('label')}
                icon="edit"
                label="Name"
                value={label}
                onSelect={() =>
                  keyboard({
                    title: 'Name this location',
                    initial: label,
                    maxLength: VPN_LABEL_MAX,
                    onDone: (typed) => {
                      const clean = typed.trim()
                      if (clean) setTyped(clean)
                    },
                  })
                }
                opens
                testId="vpn-add-label"
              />
            </div>
            {stage.removed.length > 0 && (
              <p className="signin-note" data-testid="vpn-add-removed">
                Some settings in this file were removed because MediaOS doesn&apos;t need them: {stage.removed.join(', ')}.
              </p>
            )}
            <div className="signin-actions">
              <Button focusKey={k('save')} label="Save" primary icon={<Icon name="check" />}
                onSelect={() => answer(call('vpn.finishImport', label))} testId="vpn-add-save" />
              {cancel}
            </div>
          </>
        )}
        {stage?.stage === 'done' && (
          <>
            <p className="signin-text">{stage.label} has been added. Choose which apps use the VPN.</p>
            <div className="signin-actions">
              <Button focusKey={k('apps')} label="Choose apps" primary onSelect={() => onDone(true)} testId="vpn-add-apps" />
              <Button focusKey={k('done')} label="Done" onSelect={() => onDone(false)} testId="vpn-add-done" />
            </div>
          </>
        )}
        {stage?.stage === 'error' && (
          <>
            <div className="signin-error" role="alert">
              <Icon name="warning" size="2.4rem" />
              <p data-testid="vpn-add-error">{IMPORT_ERRORS[stage.error]}</p>
            </div>
            <div className="signin-actions">
              {stage.error === 'expired' && <Button focusKey={k('ok')} label="OK" primary onSelect={start} testId="vpn-add-again" />}
              {stage.error === 'too-many-locations' && <Button focusKey={k('ok')} label="OK" primary onSelect={onCancel} />}
              {stage.error !== 'expired' && stage.error !== 'too-many-locations' && (
                <Button focusKey={k('again')} label="Try again" primary onSelect={start} testId="vpn-add-again" />
              )}
              {stage.error !== 'too-many-locations' && cancel}
            </div>
          </>
        )}
      </FocusGroup>
    </div>
  )
}

function Waiting(p: { stage: Extract<VpnImportStage, { stage: 'waiting' }>; cancel: ReactNode }): ReactNode {
  const { url, code } = p.stage
  if (!url || !code) {
    // Shown for a moment while the TV opens its upload page, or while the developer file path is read.
    return (
      <>
        <p className="signin-wait">Getting the code ready...</p>
        <div className="signin-actions">{p.cancel}</div>
      </>
    )
  }
  return (
    <>
      <p className="signin-text">
        On your phone, scan this code, then choose the WireGuard file from your VPN provider. You can also paste the text of the
        file.
      </p>
      <div className="vpn-upload-scan">
        <Qr text={url} testId="vpn-add-qr" />
        <div className="vpn-upload-address">
          <p className="signin-note">Or type this address into your phone&apos;s web browser:</p>
          <div className="signin-code is-address" data-testid="vpn-add-code">
            {url}
          </div>
        </div>
      </div>
      <p className="signin-note">
        Your phone needs to be on the same Wi-Fi as this TV. This code works for 5 minutes.
      </p>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function ChooseServer(p: {
  k: (n: string) => string
  stage: Extract<VpnImportStage, { stage: 'choose' }>
  cancel: ReactNode
  onPick: (id: string) => void
}): ReactNode {
  return (
    <>
      <p className="signin-text">This file has several servers. Choose the one you want.</p>
      <div className="set-rows">
        <SettingRow focusKey={p.k('any')} icon="shield" label="Pick one for me" onSelect={() => p.onPick('any')} opens testId="vpn-add-any" />
      </div>
      {p.stage.groups.map((g) => (
        <section key={g.country || 'other'} className="set-section">
          <h3 className="set-section-title">{g.country || 'Other servers'}</h3>
          <div className="set-rows">
            {g.entries.map((e) => (
              <SettingRow key={e.id} focusKey={p.k(`e:${e.id}`)} icon="globe" label={e.name} onSelect={() => p.onPick(e.id)} opens
                testId={`vpn-add-entry-${e.id}`} />
            ))}
          </div>
        </section>
      ))}
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}
