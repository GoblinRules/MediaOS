// "IP settings" for one network connection: Automatic or a fixed address, router and DNS.
// docs/design/network.md section 2. Nothing changes until "Save and test"; main then runs the "Keep these settings?" trial.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DnsChoice, DnsPreset, IpConfig, NetProfile } from '@shared/system-types'
import { checkIpConfig, parseIpv4, prefixToMask, type IpProblem } from '@shared/ipv4'
import { DNS_PRESETS } from '@shared/dns-presets'
import { LAYER, useInputLayer } from '../../input/input'
import { confirm, focusScreen, keyboard } from '../../state/nav'
import { applyIp } from '../../state/netTrial'
import { Button, FocusGroup } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { ChoiceRow, Section, SettingRow, type Choice } from './parts'

type DnsKind = 'auto' | 'router' | DnsPreset | 'custom'

interface Draft {
  method: 'auto' | 'manual'
  address: string
  prefix: number
  gateway: string
  dns: DnsKind
  dns1: string
  dns2: string
}

const MASKS = [24, 23, 22, 16, 25, 26, 8]
const PAD_HINT = 'Four numbers from 0 to 255, with dots between them.'
const DIGITS = /[0-9.]/

type Field = 'address' | 'gateway' | 'dns1' | 'dns2'

const EMPTY: Record<Field, string | undefined> = {
  address: 'Type an address for the box.',
  gateway: "Type your router's address. It's often on a sticker on the router.",
  dns1: 'Type at least one DNS server, or choose one of the ready-made choices.',
  dns2: undefined,
}

/** The pad's own check: a complete address (or empty for the optional second DNS server). */
function padProblem(value: string, field: Field): string | undefined {
  if (!value) return EMPTY[field]
  if (parseIpv4(value) !== undefined) return undefined
  if (value.split('.').some((part) => /^0\d/.test(part))) {
    return 'Leave out zeros at the start of a number: write 10.0.0.5, not 10.0.0.05.'
  }
  return "That isn't a complete address. It needs four numbers from 0 to 255 with dots between them."
}

/** Which DNS choice matches what the connection uses now. */
function dnsFromLive(live: NetProfile['live']): Pick<Draft, 'dns' | 'dns1' | 'dns2'> {
  const servers = live?.dns ?? []
  const first = servers[0]
  if (!first || first === live?.gateway) return { dns: 'router', dns1: '', dns2: '' }
  const preset = DNS_PRESETS.find((p) => p.ipv4[0] === first)
  if (preset) return { dns: preset.id, dns1: '', dns2: '' }
  return { dns: 'custom', dns1: first, dns2: servers[1] ?? '' }
}

function dnsFromChoice(choice: DnsChoice): Pick<Draft, 'dns' | 'dns1' | 'dns2'> {
  switch (choice.mode) {
    case 'auto':
    case 'router':
      return { dns: choice.mode, dns1: '', dns2: '' }
    case 'preset':
      return { dns: choice.preset, dns1: '', dns2: '' }
    case 'custom':
      return { dns: 'custom', dns1: choice.servers[0] ?? '', dns2: choice.servers[1] ?? '' }
  }
}

function initialDraft(p: NetProfile): Draft {
  const cfg = p.config
  if (cfg?.method === 'manual') {
    return { method: 'manual', address: cfg.address, prefix: cfg.prefix, gateway: cfg.gateway, ...dnsFromChoice(cfg.dns) }
  }
  // Automatic, or a method MediaOS doesn't offer ("Other"): start from Automatic.
  return { method: 'auto', address: '', prefix: 24, gateway: '', ...(cfg ? dnsFromChoice(cfg.dns) : { dns: 'auto', dns1: '', dns2: '' }) }
}

function toDnsChoice(d: Draft): DnsChoice {
  if (d.dns === 'auto' || d.dns === 'router') return { mode: d.dns }
  if (d.dns === 'custom') return { mode: 'custom', servers: [d.dns1, d.dns2].filter((s) => s !== '') }
  return { mode: 'preset', preset: d.dns }
}

function toConfig(d: Draft): IpConfig {
  const dns = toDnsChoice(d)
  if (d.method === 'auto') return { method: 'auto', dns }
  return { method: 'manual', address: d.address, prefix: d.prefix, gateway: d.gateway, dns }
}

/** Where focus goes to fix a problem. */
function problemRow(problem: IpProblem, d: Draft): string {
  if (problem.field === 'dns') return d.dns === 'custom' ? 'dns1' : 'dns'
  return problem.field
}

export interface IpSettingsProps {
  profile: NetProfile
  /** The page's focus keys (the view's rows go under `ipset:`). */
  k: (n: string) => string
  /** Leave without saving. */
  onCancel: () => void
  /** The trial has started (main shows "Keep these settings?"). */
  onSaved: () => void
}

export function IpSettings({ profile, k: pageKey, onCancel, onSaved }: IpSettingsProps): ReactNode {
  const [start] = useState(() => initialDraft(profile))
  const [draft, setDraft] = useState(start)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const live = profile.live
  const k = (n: string): string => pageKey(`ipset:${n}`)
  const changed = JSON.stringify(toConfig(draft)) !== JSON.stringify(toConfig(start))
  const config = toConfig(draft)
  const problem = checkIpConfig(config)

  useEffect(() => {
    focusScreen(k('method'))
    // Once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const leave = (): void => {
    if (!changed) {
      onCancel()
      return
    }
    confirm({
      title: 'Leave without saving?',
      body: 'Your changes to the IP settings will be lost.',
      confirmLabel: 'Leave',
      cancelLabel: 'Stay',
      startOnCancel: true,
      onConfirm: onCancel,
    })
  }

  useInputLayer(LAYER.screen + 5, (action) => {
    if (action !== 'back') return false
    leave()
    return true
  })

  const update = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  const setMethod = (method: Draft['method']): void =>
    setDraft((d) => {
      if (method === 'auto') return { ...d, method, dns: d.dns === 'router' ? 'auto' : d.dns }
      // Fixed: start from what the connection uses now, so most people only change the last number.
      const next: Draft = {
        ...d,
        method,
        address: d.address || live?.address || '',
        prefix: d.address ? d.prefix : (live?.prefix ?? d.prefix),
        gateway: d.gateway || live?.gateway || '',
      }
      if (d.dns === 'auto') Object.assign(next, dnsFromLive(live))
      return next
    })

  const editIp = (field: Field, title: string): void =>
    keyboard({
      title,
      initial: draft[field],
      pad: 'ip',
      allowed: DIGITS,
      maxLength: 15,
      hint: PAD_HINT,
      validate: (v) => padProblem(v, field),
      onDone: (v) => update({ [field]: v }),
    })

  const save = (): void => {
    if (saving.current) return
    if (problem) {
      focusScreen(k(problemRow(problem, draft)))
      return
    }
    saving.current = true
    setBusy(true)
    void applyIp(profile.id, config).then((ok) => {
      saving.current = false
      setBusy(false)
      if (ok) onSaved()
    })
  }

  const manual = draft.method === 'manual'
  const gatewayText = draft.gateway || live?.gateway
  const maskChoices: Choice<number>[] = MASKS.map((p) => ({ value: p, label: prefixToMask(p), detail: p === 24 ? 'Most homes' : undefined }))
  for (const p of [live?.prefix, draft.prefix]) {
    if (p !== undefined && p >= 8 && p <= 30 && !maskChoices.some((c) => c.value === p)) {
      maskChoices.push({ value: p, label: prefixToMask(p), detail: 'In use now' })
    }
  }
  const dnsChoices: Choice<DnsKind>[] = [
    manual
      ? { value: 'router', label: gatewayText ? `Use my router (${gatewayText})` : 'Use my router' }
      : { value: 'auto', label: 'Automatic (from your router)' },
    ...DNS_PRESETS.map((p) => ({ value: p.id, label: p.label, detail: `${p.ipv4[0]} and ${p.ipv4[1]}` })),
    { value: 'custom', label: 'Type my own' },
  ]

  return (
    <div className="ipset" data-testid="ip-settings">
      <h2 className="ipset-title">IP settings: {profile.name}</h2>
      <FocusGroup focusKey={pageKey('ipset')} boundary className="ipset-rows">
        <Section title="Address">
          <ChoiceRow
            focusKey={k('method')}
            icon="sliders"
            label="Get an address"
            detail="Automatic suits almost every home. For a fixed address, reserving one on your router is easier and safer."
            value={draft.method}
            choices={[
              { value: 'auto', label: 'Automatic (recommended)', detail: 'Your router gives the box its address' },
              { value: 'manual', label: 'Fixed', detail: 'You type the address yourself' },
            ]}
            onChange={setMethod}
            testId="ip-method"
          />
          {manual && (
            <>
              <SettingRow
                focusKey={k('address')}
                icon="edit"
                label="Address"
                detail="Choose one your router won't give to another device. Router pages call this the DHCP range."
                value={draft.address || 'Not set'}
                onSelect={() => editIp('address', 'Address for the box')}
                testId="ip-address"
              />
              <ChoiceRow
                focusKey={k('mask')}
                icon="sliders"
                label="Subnet mask"
                value={draft.prefix}
                choices={maskChoices}
                onChange={(p) => update({ prefix: p })}
                testId="ip-mask"
              />
              <SettingRow
                focusKey={k('gateway')}
                icon="server"
                label="Router"
                detail="Often on a sticker on the router."
                value={draft.gateway || 'Not set'}
                onSelect={() => editIp('gateway', "Router's address")}
                testId="ip-gateway"
              />
            </>
          )}
        </Section>
        <Section title="DNS">
          <ChoiceRow
            focusKey={k('dns')}
            icon="globe"
            label="DNS"
            detail="DNS turns website names into addresses. Leave this alone unless you have a reason to change it."
            value={draft.dns}
            choices={dnsChoices}
            onChange={(dns) => update({ dns })}
            testId="ip-dns"
          />
          {draft.dns === 'custom' && (
            <>
              <SettingRow
                focusKey={k('dns1')}
                icon="globe"
                label="DNS server 1"
                value={draft.dns1 || 'Not set'}
                onSelect={() => editIp('dns1', 'DNS server 1')}
                testId="ip-dns1"
              />
              <SettingRow
                focusKey={k('dns2')}
                icon="globe"
                label="DNS server 2 (optional)"
                value={draft.dns2 || 'None'}
                onSelect={() => editIp('dns2', 'DNS server 2')}
                testId="ip-dns2"
              />
            </>
          )}
        </Section>
        {problem && (
          <SettingRow focusKey={k('problem')} icon="warning" label="Check this" detail={problem.message} testId="ip-problem" />
        )}
        <div className="panel-actions ipset-actions">
          <Button focusKey={k('cancel')} label="Cancel" onSelect={onCancel} testId="ip-cancel" />
          <Button
            focusKey={k('save')}
            label={busy ? 'Saving…' : 'Save and test'}
            icon={<Icon name="check" />}
            primary
            onSelect={save}
            testId="ip-save"
          />
        </div>
      </FocusGroup>
    </div>
  )
}
