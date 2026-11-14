// Settings > Remotes > Phone remote: the switch, "Pair a phone" (QR code + 8-digit code) and the list of paired phones.
// Main owns pairing and the phone list; this file draws them and asks main for changes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PairStartResult, PhoneInfo } from '@shared/remote-types'
import { call, errorText, onEvent, run } from '../../lib/api'
import { useCall } from '../../lib/useCall'
import { LAYER, useInputLayer } from '../../input/input'
import { confirm, focusScreen } from '../../state/nav'
import { updateSettings, useSettings } from '../../state/settings'
import { toast } from '../../state/toasts'
import { Button, FocusGroup } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { Qr } from '../../components/Qr'
import { Spinner } from '../../components/Row'
import { SettingRow, Section, ToggleRow } from './parts'

const DAY_MS = 86_400_000

/** "today", "yesterday", "3 days ago", then a date such as "14 Nov". */
export function whenText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.ceil((startOfToday.getTime() - t) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return dateText(iso)
}

function dateText(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function phoneDetail(p: PhoneInfo, now = Date.now()): string {
  return `Added ${dateText(p.pairedAt)} · Last used ${whenText(p.lastUsed, now)}`
}

const START_ERRORS: Record<Exclude<PairStartResult, { ok: true }>['error'], string> = {
  off: 'The phone remote is switched off. Turn it on first.',
  'no-network': 'Connect the box to your home network (Wi-Fi or cable) first. Your phone needs to be on the same network.',
  unavailable: "Couldn't start pairing. Try again in a moment.",
}

/** The Phone remote section of Settings > Remotes. */
export function PhoneRemoteSection({ k, onPair }: { k: (n: string) => string; onPair: () => void }): ReactNode {
  const s = useSettings()
  const phones = useCall('remote.phones', [])
  const reload = phones.reload
  useEffect(() => onEvent('remotePhones', () => reload()), [reload])

  const remove = (p: PhoneInfo): void =>
    confirm({
      title: `Remove ${p.name}?`,
      body: 'It will stop working as a remote until you pair it again.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () =>
        void run('remote.removePhone', p.id).then((ok) => {
          if (ok) toast(`Removed ${p.name}`, 'ok')
          reload()
        }),
    })

  const list = phones.data ?? []
  return (
    <Section title="Phone remote" hint="Use a phone on the same Wi-Fi as a remote, and type on it instead of the TV keyboard.">
      <ToggleRow
        focusKey={k('phone')}
        icon="phone"
        label="Use a phone as a remote"
        detail={s.remote.phoneRemote ? undefined : 'Turned off. Paired phones stop working until you turn this on again.'}
        on={s.remote.phoneRemote}
        onChange={(on) => void updateSettings({ remote: { phoneRemote: on } })}
      />
      <SettingRow
        focusKey={k('phone-pair')}
        icon="plus"
        label="Pair a phone"
        disabled={!s.remote.phoneRemote}
        onSelect={onPair}
        opens
        testId="phone-pair"
      />
      {phones.error && !phones.data && <div className="set-loading">{phones.error}</div>}
      {list.map((p) => (
        <SettingRow
          key={p.id}
          focusKey={k(`phone:${p.id}`)}
          icon="phone"
          label={p.name}
          detail={phoneDetail(p)}
          onSelect={() => remove(p)}
          onMenu={() => remove(p)}
          testId={`phone-${p.id}`}
        />
      ))}
    </Section>
  )
}

type Stage = { s: 'starting' } | { s: 'waiting'; url: string; code: string } | { s: 'error'; text: string } | { s: 'expired'; why: string }

/** The "Pair a phone" view. Shows the QR code until a phone pairs, the code runs out, or the user leaves. */
export function PairPhoneFlow(p: { prefix: string; onDone: () => void }): ReactNode {
  const [stage, setStage] = useState<Stage>({ s: 'starting' })
  const open = useRef(true)
  const attempt = useRef(0)
  // Kept in a ref so the event listeners set up once per visit always call the latest one.
  const done = useRef(p.onDone)
  useEffect(() => {
    done.current = p.onDone
  })
  const onDone = (): void => done.current()

  const request = (): void => {
    const mine = ++attempt.current
    call('remote.pairStart').then(
      (r) => {
        if (!open.current || mine !== attempt.current) return
        setStage(r.ok ? { s: 'waiting', url: r.url, code: r.code } : { s: 'error', text: START_ERRORS[r.error] })
      },
      (err: unknown) => {
        if (open.current && mine === attempt.current) setStage({ s: 'error', text: errorText(err) })
      },
    )
  }
  const start = (): void => {
    setStage({ s: 'starting' })
    request()
  }

  useEffect(() => {
    open.current = true
    request()
    const offs = [
      onEvent('remotePaired', ({ name, replaced }) => {
        if (!open.current) return
        toast(
          replaced
            ? `${name} paired. ${replaced} was removed to make room (8 phones at most).`
            : `${name} paired. You can use it as a remote now.`,
          'ok',
        )
        onDone()
      }),
      onEvent('remotePairEnded', ({ reason }) => {
        if (!open.current || reason === 'paired') return
        if (reason === 'off') return onDone()
        setStage({
          s: 'expired',
          why: reason === 'too-many-tries' ? 'The code was typed wrong too many times.' : 'The code has run out.',
        })
      }),
    ]
    return () => {
      open.current = false
      offs.forEach((off) => off())
      void call('remote.pairCancel').catch(() => undefined)
    }
    // Starts once per visit; leaving always cancels.
  }, [])

  useInputLayer(LAYER.screen + 5, (action) => {
    if (action !== 'back') return false
    onDone()
    return true
  })

  const group = `${p.prefix}:phonepair:${stage.s}`
  useEffect(() => {
    focusScreen(group)
  }, [group])
  const k = (n: string): string => `${group}:${n}`
  const cancel = <Button focusKey={k('cancel')} label="Cancel" icon={<Icon name="close" />} onSelect={onDone} testId="phone-pair-cancel" />

  return (
    <div className="signin" data-testid="phone-pair-flow" data-step={stage.s}>
      <h2 className="signin-title">Pair a phone</h2>
      <FocusGroup key={group} focusKey={group} className="signin-step">
        {stage.s === 'starting' && (
          <>
            <Spinner label="Starting" />
            {cancel}
          </>
        )}
        {stage.s === 'waiting' && (
          <>
            <p className="signin-text">On your phone, scan this code with the camera. Your phone needs to be on the same Wi-Fi as this TV.</p>
            <div className="vpn-upload-scan">
              <Qr text={stage.url} testId="phone-pair-qr" />
              <div className="vpn-upload-address">
                <p className="signin-note">Or open this address in your phone&apos;s web browser:</p>
                <div className="signin-code is-address">{stage.url.replace(/\?.*$/, '')}</div>
                <p className="signin-note">and type this code:</p>
                <div className="signin-code" data-testid="phone-pair-code">
                  {stage.code.slice(0, 4)} {stage.code.slice(4)}
                </div>
              </div>
            </div>
            <p className="signin-note">This code works once and stops working in 5 minutes.</p>
            <div className="signin-actions">{cancel}</div>
          </>
        )}
        {(stage.s === 'error' || stage.s === 'expired') && (
          <>
            <div className="signin-error" role="alert">
              <Icon name="warning" size="2.4rem" />
              <p data-testid="phone-pair-error">{stage.s === 'error' ? stage.text : `${stage.why} Get a new code to try again.`}</p>
            </div>
            <div className="signin-actions">
              <Button focusKey={k('again')} label={stage.s === 'expired' ? 'Get a new code' : 'Try again'} primary onSelect={start}
                testId="phone-pair-again" />
              {cancel}
            </div>
          </>
        )}
      </FocusGroup>
    </div>
  )
}
