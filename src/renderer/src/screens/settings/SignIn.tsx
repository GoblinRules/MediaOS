// Adding a Jellyfin server or a Plex account, step by step. Used by Settings > Libraries and by first-time
// setup. Jellyfin: pick a server found on the network (or type its address), then a Quick Connect code or a
// name and password. Plex: show a code to enter at plex.tv/link, then choose which servers to add.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JellyfinProbe, PlexServerChoice, SignInStart } from '@shared/ipc-contract'
import type { SourceInfo } from '@shared/media-types'
import { call, errorText } from '../../lib/api'
import { useCall } from '../../lib/useCall'
import { LAYER, useInputLayer } from '../../input/input'
import { focusScreen, keyboard } from '../../state/nav'
import { toast } from '../../state/toasts'
import { Button, FocusGroup } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Row'
import { SettingRow } from './parts'

export type SignInKind = 'jellyfin' | 'plex'

type Step =
  | { s: 'find' }
  | { s: 'busy'; text: string }
  | { s: 'method'; probe: JellyfinProbe }
  | { s: 'code'; start: SignInStart; expired?: boolean; url?: string }
  | { s: 'servers'; flowId: string; servers: PlexServerChoice[]; chosen: string[] }
  | { s: 'failed'; message: string; again: 'find' | 'plex' }

const POLL_MS = 2000

export interface SignInProps {
  kind: SignInKind
  /** Prefix for focus keys, e.g. "set:libraries" or "setup". */
  prefix: string
  /** Jellyfin only: go straight to this server (signing in again). */
  url?: string
  onDone: (sources: SourceInfo[]) => void
  onCancel: () => void
}

export function SignInFlow(p: SignInProps): ReactNode {
  const [step, setStep] = useState<Step>(() =>
    p.kind === 'plex' ? { s: 'busy', text: 'Getting a code from Plex' } : p.url ? { s: 'busy', text: 'Checking the server' } : { s: 'find' },
  )
  const flowId = useRef<string | undefined>(undefined)
  const finished = useRef(false)
  // False once the user has left: answers that arrive after that must not change anything.
  const open = useRef(true)
  const { onDone, onCancel, kind, url } = p

  const finish = (sources: SourceInfo[]): void => {
    if (!open.current) {
      // The user left while it was still signing in, but the server was added anyway: say so rather than stay silent.
      const added = sources.length === 1 ? sources[0]?.name : undefined
      if (sources.length > 0) toast(added ? `Added ${added}` : `Added ${sources.length} servers`, 'ok')
      return
    }
    finished.current = true
    flowId.current = undefined
    onDone(sources)
  }

  const fail = (err: unknown, again: 'find' | 'plex'): void => {
    if (open.current) setStep({ s: 'failed', message: errorText(err), again })
  }

  /** A new code arrived. If the user has already left, give that sign-in up straight away. */
  const started = (start: SignInStart, url?: string): void => {
    if (!open.current) {
      void call('signin.cancel', start.flowId).catch(() => undefined)
      return
    }
    if (flowId.current && flowId.current !== start.flowId) void call('signin.cancel', flowId.current).catch(() => undefined)
    flowId.current = start.flowId
    setStep({ s: 'code', start, url })
  }

  const startPlex = (): Promise<void> => call('plex.pin').then((start) => started(start), (err: unknown) => fail(err, 'plex'))
  const startQuick = (server: string): Promise<void> =>
    call('jellyfin.quickConnect', server).then((start) => started(start, server), (err: unknown) => fail(err, 'find'))

  const probe = (address: string): Promise<void> =>
    call('jellyfin.probe', address).then(
      (r) => {
        if (open.current) setStep({ s: 'method', probe: r })
      },
      (err: unknown) => fail(err, 'find'),
    )

  // First step that needs the network: Plex code, or checking a known Jellyfin address.
  useEffect(() => {
    if (kind === 'plex') void startPlex()
    else if (url) void probe(url)
    // Runs once when the flow opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Give up the half-finished sign-in if the user leaves.
  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
      if (!finished.current && flowId.current) void call('signin.cancel', flowId.current).catch(() => undefined)
    }
  }, [])

  // Wait for the code to be entered on the other device.
  const pollId = step.s === 'code' && !step.expired ? step.start.flowId : undefined
  useEffect(() => {
    if (!pollId) return
    let busy = false
    let live = true
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      call('signin.poll', pollId)
        .then((r) => {
          // Approved at the same moment the user left: the server is added anyway, so finish() says so.
          if (!live) {
            if (r.state === 'done' && !open.current) finish([r.source])
            return
          }
          if (r.state === 'done') finish([r.source])
          else if (r.state === 'chooseServers') {
            setStep({ s: 'servers', flowId: pollId, servers: r.servers, chosen: r.servers.filter((x) => x.owned).map((x) => x.id) })
          } else if (r.state === 'expired') setStep((st) => (st.s === 'code' ? { ...st, expired: true } : st))
          else if (r.state === 'error') fail(new Error(r.message), kind === 'plex' ? 'plex' : 'find')
        })
        .catch((err: unknown) => {
          if (live) fail(err, kind === 'plex' ? 'plex' : 'find')
        })
        .finally(() => {
          busy = false
        })
    }, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
    // finish/fail only use refs and setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollId, kind])

  // Back leaves the whole sign-in.
  useInputLayer(LAYER.screen + 5, (action) => {
    if (action !== 'back') return false
    onCancel()
    return true
  })

  // Each step is its own focus group; move focus into it when the step changes.
  const group = `${p.prefix}:si:${step.s}${step.s === 'code' && step.expired ? ':x' : ''}`
  useEffect(() => {
    focusScreen(group)
  }, [group])

  const k = (name: string): string => `${group}:${name}`
  const cancel = <Button focusKey={k('cancel')} label="Cancel" icon={<Icon name="close" />} onSelect={onCancel} testId="signin-cancel" />
  const title = kind === 'plex' ? 'Add a Plex account' : 'Add a Jellyfin server'

  return (
    <div className="signin" data-testid="signin" data-step={step.s}>
      <h2 className="signin-title">{title}</h2>
      <FocusGroup key={group} focusKey={group} className="signin-step">
        {step.s === 'busy' && (
          <>
            <Spinner label={step.text} />
            <p className="signin-text">{step.text}…</p>
            {cancel}
          </>
        )}
        {step.s === 'find' && <FindServer k={k} onPick={(u) => {
          setStep({ s: 'busy', text: 'Checking the server' })
          void probe(u)
        }} cancel={cancel} />}
        {step.s === 'method' && (
          <Method
            k={k}
            probe={step.probe}
            cancel={cancel}
            onQuick={() => {
              setStep({ s: 'busy', text: 'Getting a Quick Connect code' })
              void startQuick(step.probe.url)
            }}
            onPassword={(user, pw) => {
              setStep({ s: 'busy', text: 'Signing in' })
              call('jellyfin.password', step.probe.url, user, pw).then(
                (src) => finish([src]),
                (err: unknown) => fail(err, 'find'),
              )
            }}
          />
        )}
        {step.s === 'code' && (
          <CodeStep
            k={k}
            start={step.start}
            expired={step.expired ?? false}
            cancel={cancel}
            onNewCode={() => {
              const server = step.url
              setStep({ s: 'busy', text: 'Getting a new code' })
              if (kind === 'plex') void startPlex()
              else if (server) void startQuick(server)
              else setStep({ s: 'find' })
            }}
          />
        )}
        {step.s === 'servers' && (
          <ChooseServers
            k={k}
            servers={step.servers}
            chosen={step.chosen}
            cancel={cancel}
            onToggle={(id) =>
              setStep((st) =>
                st.s === 'servers'
                  ? { ...st, chosen: st.chosen.includes(id) ? st.chosen.filter((x) => x !== id) : [...st.chosen, id] }
                  : st,
              )
            }
            onAdd={() => {
              const id = step.flowId
              const chosen = step.chosen
              setStep({ s: 'busy', text: 'Adding your servers' })
              call('plex.addServers', id, chosen).then(finish, (err: unknown) => fail(err, 'plex'))
            }}
          />
        )}
        {step.s === 'failed' && (
          <>
            <div className="signin-error" role="alert">
              <Icon name="warning" size="2.4rem" />
              <p>{step.message}</p>
            </div>
            <div className="signin-actions">
              <Button
                focusKey={k('again')}
                label="Try again"
                primary
                onSelect={() => {
                  if (step.again === 'plex') {
                    setStep({ s: 'busy', text: 'Getting a code from Plex' })
                    void startPlex()
                  } else setStep({ s: 'find' })
                }}
              />
              {cancel}
            </div>
          </>
        )}
      </FocusGroup>
    </div>
  )
}

function FindServer(p: { k: (n: string) => string; onPick: (url: string) => void; cancel: ReactNode }): ReactNode {
  const found = useCall('jellyfin.discover', [])
  const typeAddress = (): void =>
    keyboard({
      title: 'Jellyfin server address',
      initial: 'http://',
      maxLength: 200,
      hint: 'For example http://192.168.1.20:8096',
      onDone: (v) => {
        if (v.trim() && v.trim() !== 'http://') p.onPick(v.trim())
      },
    })
  return (
    <>
      <p className="signin-text">Choose your server. Servers on this network show up here by themselves.</p>
      <div className="set-rows">
        {(found.data ?? []).map((s) => (
          <SettingRow key={s.id} focusKey={p.k(`srv:${s.id}`)} icon="server" label={s.name} detail={s.url} onSelect={() => p.onPick(s.url)} opens />
        ))}
        {found.loading && !found.data && <div className="set-loading">Looking for servers…</div>}
        {found.data?.length === 0 && <div className="set-loading">No servers found on this network.</div>}
        <SettingRow focusKey={p.k('type')} icon="keyboard" label="Type the address" detail="If your server is not listed" onSelect={typeAddress} opens />
        <SettingRow focusKey={p.k('rescan')} icon="refresh" label="Look again" onSelect={found.reload} />
      </div>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function Method(p: {
  k: (n: string) => string
  probe: JellyfinProbe
  cancel: ReactNode
  onQuick: () => void
  onPassword: (user: string, pw: string) => void
}): ReactNode {
  const askPassword = (): void =>
    keyboard({
      title: 'Your Jellyfin user name',
      initial: '',
      maxLength: 200,
      onDone: (user) => {
        if (!user.trim()) return
        keyboard({
          title: `Password for ${user.trim()}`,
          initial: '',
          secret: true,
          maxLength: 500,
          hint: 'Leave empty if this user has no password.',
          onDone: (pw) => p.onPassword(user.trim(), pw),
        })
      },
    })
  return (
    <>
      <p className="signin-text">
        Found <strong>{p.probe.serverName}</strong> (Jellyfin {p.probe.version}). How do you want to sign in?
      </p>
      <div className="set-rows">
        {p.probe.quickConnect && (
          <SettingRow
            focusKey={p.k('quick')}
            icon="phone"
            label="Use a code (easiest)"
            detail="Approve this TV from the Jellyfin app on your phone or computer. No typing needed."
            onSelect={p.onQuick}
            opens
          />
        )}
        <SettingRow focusKey={p.k('password')} icon="keyboard" label="Type your name and password" onSelect={askPassword} opens />
      </div>
      {!p.probe.quickConnect && (
        <p className="signin-note">Tip: turn on Quick Connect in your Jellyfin server&apos;s dashboard to sign in with a code instead.</p>
      )}
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function CodeStep(p: {
  k: (n: string) => string
  start: SignInStart
  expired: boolean
  cancel: ReactNode
  onNewCode: () => void
}): ReactNode {
  if (p.expired) {
    return (
      <>
        <p className="signin-text">That code has run out. Get a new one and try again.</p>
        <div className="signin-actions">
          <Button focusKey={p.k('new')} label="Get a new code" primary onSelect={p.onNewCode} />
          {p.cancel}
        </div>
      </>
    )
  }
  return (
    <>
      <p className="signin-text">
        On your phone or computer, go to <strong>{p.start.where}</strong> and enter this code:
      </p>
      <div className="signin-code" data-testid="signin-code" aria-label={`Code ${p.start.code.split('').join(' ')}`}>
        {p.start.code}
      </div>
      <p className="signin-wait">
        <span className="spinner spinner-small" /> Waiting for you to enter the code…
      </p>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function ChooseServers(p: {
  k: (n: string) => string
  servers: PlexServerChoice[]
  chosen: string[]
  cancel: ReactNode
  onToggle: (id: string) => void
  onAdd: () => void
}): ReactNode {
  if (p.servers.length === 0) {
    return (
      <>
        <p className="signin-text">You&apos;re signed in, but this Plex account has no servers yet. Set up Plex Media Server first.</p>
        <div className="signin-actions">{p.cancel}</div>
      </>
    )
  }
  const n = p.chosen.length
  return (
    <>
      <p className="signin-text">Signed in. Choose the servers to show on this TV.</p>
      <div className="set-rows">
        {p.servers.map((s) => {
          const on = p.chosen.includes(s.id)
          return (
            <SettingRow
              key={s.id}
              focusKey={p.k(`srv:${s.id}`)}
              icon={on ? 'check' : 'server'}
              label={s.name}
              detail={`${s.owned ? 'Your server' : 'Shared with you'} · ${s.reach}`}
              value={on ? 'Added' : 'Not added'}
              onSelect={() => p.onToggle(s.id)}
            />
          )
        })}
      </div>
      <div className="signin-actions">
        <Button
          focusKey={p.k('add')}
          label={n === 0 ? 'Choose at least one' : n === 1 ? 'Add 1 server' : `Add ${n} servers`}
          primary
          disabled={n === 0}
          onSelect={p.onAdd}
          testId="signin-add"
        />
        {p.cancel}
      </div>
    </>
  )
}
