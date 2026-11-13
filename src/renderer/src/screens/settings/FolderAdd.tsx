// Adding a network folder (a shared folder on a computer or NAS), step by step: pick the computer (found on the
// network, or typed), say how to sign in (a user name and password, or as a guest), then pick the shared folder.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FoundComputer, ShareLogin } from '@shared/folder-types'
import { call, errorText } from '../../lib/api'
import { useCall } from '../../lib/useCall'
import { LAYER, useInputLayer } from '../../input/input'
import { focusScreen, keyboard } from '../../state/nav'
import { toast } from '../../state/toasts'
import { Button, FocusGroup } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/Row'
import { SettingRow } from './parts'

/** A computer picked from the list or typed in; `share` is set when the user typed a full \\computer\folder path. */
interface Computer extends FoundComputer {
  share?: string
}

type Choose =
  | { s: 'find' }
  | { s: 'login'; pc: Computer }
  | { s: 'shares'; pc: Computer; login: ShareLogin; shares: string[] }

type Step = Choose | { s: 'busy'; text: string } | { s: 'failed'; message: string; again: Choose }

/** "\\NAS\Films", "//nas.local/Films" or just "NAS" -> the computer and, when given, the folder. */
export function parseTyped(text: string): Computer | undefined {
  const parts = text.trim().replace(/^smb:/i, '').replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean)
  const host = parts[0]
  if (!host) return undefined
  return { name: host, host, share: parts[1] }
}

/** The library's name: "Films on NAS", cut to the 60 characters the box keeps. */
function libraryName(share: string, pc: Computer): string {
  const full = `${share} on ${pc.name}`
  return full.length <= 60 ? full : share.slice(0, 60)
}

export interface FolderAddProps {
  /** Prefix for focus keys, e.g. "set:libraries". */
  prefix: string
  onDone: (name: string) => void
  onCancel: () => void
}

export function FolderAddFlow(p: FolderAddProps): ReactNode {
  const [step, setStep] = useState<Step>({ s: 'find' })
  // False once the user has left: answers that arrive after that must not change anything.
  const open = useRef(true)
  const { onDone, onCancel } = p

  useEffect(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])

  const fail = (err: unknown, again: Choose): void => {
    if (open.current) setStep({ s: 'failed', message: errorText(err), again })
  }

  const add = (pc: Computer, login: ShareLogin, share: string): void => {
    const name = libraryName(share, pc)
    setStep({ s: 'busy', text: `Connecting to ${share}` })
    const back: Choose = { s: 'login', pc }
    call('folders.add', { ...login, share, name }).then(
      (r) => {
        if (!r.ok) return fail(new Error(r.error), back)
        // The user left while it was connecting, but the folder was added anyway: say so rather than stay silent.
        if (!open.current) toast(`Added ${name}`, 'ok')
        else onDone(name)
      },
      (err: unknown) => fail(err, back),
    )
  }

  const signIn = (pc: Computer, login: ShareLogin): void => {
    if (pc.share) return add(pc, login, pc.share)
    setStep({ s: 'busy', text: `Looking for shared folders on ${pc.name}` })
    call('folders.listShares', login).then(
      (shares) => {
        if (open.current) setStep({ s: 'shares', pc, login, shares })
      },
      (err: unknown) => fail(err, { s: 'login', pc }),
    )
  }

  // Back leaves the whole flow.
  useInputLayer(LAYER.screen + 5, (action) => {
    if (action !== 'back') return false
    onCancel()
    return true
  })

  // Each step is its own focus group; move focus into it when the step changes.
  const group = `${p.prefix}:fa:${step.s}`
  useEffect(() => {
    focusScreen(group)
  }, [group])

  const k = (name: string): string => `${group}:${name}`
  const cancel = <Button focusKey={k('cancel')} label="Cancel" icon={<Icon name="close" />} onSelect={onCancel} testId="folder-cancel" />

  return (
    <div className="signin" data-testid="folder-add" data-step={step.s}>
      <h2 className="signin-title">Add a network folder</h2>
      <FocusGroup key={group} focusKey={group} className="signin-step">
        {step.s === 'busy' && (
          <>
            <Spinner label={step.text} />
            <p className="signin-text">{step.text}…</p>
            {cancel}
          </>
        )}
        {step.s === 'find' && <FindComputer k={k} cancel={cancel} onPick={(pc) => setStep({ s: 'login', pc })} />}
        {step.s === 'login' && <Login k={k} pc={step.pc} cancel={cancel} onLogin={(login) => signIn(step.pc, login)} />}
        {step.s === 'shares' && (
          <ChooseShare k={k} step={step} cancel={cancel} onPick={(share) => add(step.pc, step.login, share)} />
        )}
        {step.s === 'failed' && (
          <>
            <div className="signin-error" role="alert">
              <Icon name="warning" size="2.4rem" />
              <p>{step.message}</p>
            </div>
            <div className="signin-actions">
              <Button focusKey={k('again')} label="Try again" primary onSelect={() => setStep(step.again)} testId="folder-again" />
              <Button focusKey={k('start')} label="Choose another computer" onSelect={() => setStep({ s: 'find' })} />
              {cancel}
            </div>
          </>
        )}
      </FocusGroup>
    </div>
  )
}

function FindComputer(p: { k: (n: string) => string; onPick: (pc: Computer) => void; cancel: ReactNode }): ReactNode {
  const found = useCall('folders.discover', [])
  const type = (): void =>
    keyboard({
      title: "The computer's name",
      initial: '',
      maxLength: 200,
      hint: 'For example NAS, OFFICE-PC or 192.168.1.20. You can also type the whole path, like \\\\NAS\\Films.',
      onDone: (text) => {
        const pc = parseTyped(text)
        if (pc) p.onPick(pc)
      },
    })
  return (
    <>
      <p className="signin-text">Choose the computer or NAS that has your films. The ones on this network show up here by themselves.</p>
      <div className="set-rows">
        {(found.data ?? []).map((pc) => (
          <SettingRow
            key={pc.ip ?? pc.host}
            focusKey={p.k(`pc:${pc.ip ?? pc.host}`)}
            icon="server"
            label={pc.name}
            detail={pc.ip && pc.ip !== pc.name ? pc.ip : undefined}
            onSelect={() => p.onPick(pc)}
            opens
            testId={`folder-pc-${pc.name}`}
          />
        ))}
        {found.loading && !found.data && <div className="set-loading">Looking for computers…</div>}
        {found.data?.length === 0 && <div className="set-loading">No computers found on this network. Type its name instead.</div>}
        <SettingRow focusKey={p.k('type')} icon="keyboard" label="Type the computer's name" detail="If it isn't listed" onSelect={type} opens testId="folder-type" />
        <SettingRow focusKey={p.k('rescan')} icon="refresh" label="Look again" onSelect={found.reload} />
      </div>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function Login(p: { k: (n: string) => string; pc: Computer; cancel: ReactNode; onLogin: (login: ShareLogin) => void }): ReactNode {
  const base = { server: p.pc.host, ip: p.pc.ip }
  const askPassword = (): void =>
    keyboard({
      title: `Your user name on ${p.pc.name}`,
      initial: '',
      maxLength: 256,
      hint: 'On a Windows PC this is often the email address you sign in with.',
      onDone: (typed) => {
        const user = typed.trim()
        if (!user) return
        keyboard({
          title: `Password for ${user}`,
          initial: '',
          secret: true,
          maxLength: 256,
          onDone: (password) => p.onLogin({ ...base, guest: false, user, password }),
        })
      },
    })
  return (
    <>
      <p className="signin-text">
        How does <strong>{p.pc.name}</strong> let you in?
      </p>
      <div className="set-rows">
        <SettingRow
          focusKey={p.k('password')}
          icon="keyboard"
          label="Type a user name and password"
          detail={`The ones you use on ${p.pc.name}. MediaOS keeps them on this box only.`}
          onSelect={askPassword}
          opens
          testId="folder-password"
        />
        <SettingRow
          focusKey={p.k('guest')}
          icon="user"
          label="Open it as a guest"
          detail="For folders shared with everyone, with no password."
          onSelect={() => p.onLogin({ ...base, guest: true })}
          opens
          testId="folder-guest"
        />
      </div>
      <p className="signin-note">MediaOS only reads the folder. It never changes or deletes anything on {p.pc.name}.</p>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}

function ChooseShare(p: {
  k: (n: string) => string
  step: Extract<Choose, { s: 'shares' }>
  cancel: ReactNode
  onPick: (share: string) => void
}): ReactNode {
  const { pc, shares } = p.step
  const type = (): void =>
    keyboard({
      title: 'Shared folder name',
      initial: '',
      maxLength: 80,
      hint: `The name ${pc.name} shares it under, for example Films.`,
      onDone: (text) => {
        const share = text.trim().replace(/^[\\/]+|[\\/]+$/g, '')
        if (share) p.onPick(share)
      },
    })
  return (
    <>
      <p className="signin-text">
        {shares.length > 0 ? `Choose the folder with your films on ${pc.name}.` : `${pc.name} isn't sharing any folders this box can see.`}
      </p>
      <div className="set-rows">
        {shares.map((share) => (
          <SettingRow key={share} focusKey={p.k(`share:${share}`)} icon="folderNet" label={share} onSelect={() => p.onPick(share)} opens
            testId={`folder-share-${share}`} />
        ))}
        <SettingRow focusKey={p.k('type')} icon="keyboard" label="Type the folder name" detail="If it isn't listed" onSelect={type} opens />
      </div>
      <div className="signin-actions">{p.cancel}</div>
    </>
  )
}
