// Settings pages for the box's hardware: network, picture, sound and remotes.
import { useEffect, useState, type ReactNode } from 'react'
import type { BtDevice, DisplayMode, DisplayOutput, NetProfile, NetStatus, WifiAp } from '@shared/system-types'
import { prefixToMask } from '@shared/ipv4'
import { call, run } from '../../lib/api'
import { useCall } from '../../lib/useCall'
import { closeOverlay, focusScreen, keyboard, menu, openOverlay } from '../../state/nav'
import { updateSettings, useSettings } from '../../state/settings'
import { toast } from '../../state/toasts'
import { ChoiceRow, RowsState, Section, SettingRow, StepperRow, ToggleRow } from './parts'
import { IpSettings } from './IpSettings'

// ---------- Network ----------

function signalWord(signal: number): string {
  if (signal >= 70) return 'Strong signal'
  if (signal >= 40) return 'Good signal'
  return 'Weak signal'
}

function statusText(n: NetStatus): { value: string; detail: string } {
  if (!n.connected) return { value: 'Not connected', detail: 'Plug in a network cable, or choose a Wi-Fi network below.' }
  const how = n.kind === 'ethernet' ? 'Connected by cable' : `Connected to ${n.ssid ?? 'Wi-Fi'}`
  return { value: how, detail: n.internet ? 'The internet is working.' : 'Connected, but the internet is not reachable. Check your router.' }
}

function showDetails(n: NetStatus): void {
  const rows: [string, string | undefined][] = [
    ['Address (IP)', n.ip],
    ['Router (gateway)', n.gateway],
    ['DNS', n.dns?.join(', ')],
    ['How it gets an address', n.method === 'manual' ? 'Fixed' : n.method === 'auto' ? 'Automatic' : n.method ? 'Other' : undefined],
    ['Subnet mask', n.prefix !== undefined ? prefixToMask(n.prefix) : undefined],
    ['Hardware address (MAC)', n.mac],
    ['Signal', n.signal !== undefined ? `${n.signal}%` : undefined],
  ]
  menu(
    'Connection details',
    rows.filter(([, v]) => v).map(([label, v]) => ({ id: label, label: v ?? '', detail: label, onSelect: () => undefined })),
  )
}

function ipValue(p: NetProfile): string {
  if (!p.editable) return 'Not available'
  if (p.config?.method === 'manual') return `Fixed: ${p.config.address}`
  return p.config ? 'Automatic' : 'Other'
}

/**
 * Settings > Network. `advanced` (default true) adds IP settings; setup leaves it out so no "Keep these settings?"
 * trial can start there.
 */
export function NetworkPage({ k, advanced = true }: { k: (n: string) => string; advanced?: boolean }): ReactNode {
  const status = useCall('network.status', [])
  const aps = useCall('network.scan', [])
  const profiles = useCall('network.profiles', [])
  // The connection whose IP settings are open, and the row to go back to.
  const [editing, setEditing] = useState<{ profile: NetProfile; from: string }>()
  // An object so asking for the same row twice still moves focus.
  const [refocus, setRefocus] = useState<{ key: string }>()
  useEffect(() => {
    if (refocus) focusScreen(refocus.key)
  }, [refocus])

  const refresh = (): void => {
    status.reload()
    aps.reload()
    profiles.reload()
  }

  const connect = async (ssid: string, password?: string): Promise<void> => {
    if (password?.length === 64 && !/^[0-9a-fA-F]+$/.test(password)) {
      toast('A Wi-Fi password can be up to 63 characters. A 64-character key uses only 0-9 and A-F.', 'error')
      return
    }
    toast(`Connecting to ${ssid}…`, 'info')
    if (await run('network.connect', ssid, password)) toast(`Connected to ${ssid}`, 'ok')
    refresh()
  }
  const askPassword = (ssid: string): void =>
    keyboard({ title: `Password for ${ssid}`, initial: '', secret: true, maxLength: 64, onDone: (pw) => void connect(ssid, pw || undefined) })
  const forget = (ap: WifiAp): void =>
    void run('network.forget', ap.id).then((ok) => {
      if (ok) toast(`Forgot ${ap.ssid}`, 'ok')
      refresh()
    })
  const choose = (ap: WifiAp): void => {
    if (ap.active) apMenu(ap)
    else if (ap.known || !ap.secure) void connect(ap.ssid)
    else askPassword(ap.ssid)
  }
  const active = profiles.data?.find((p) => p.id === status.data?.profileId) ?? profiles.data?.find((p) => p.active)
  const openIp = (profile: NetProfile, from: string): void => {
    if (!profile.editable) {
      toast(profile.why ?? "These settings can't be changed here.", 'info')
      return
    }
    setEditing({ profile, from })
  }
  const apIp = (ap: WifiAp): void => {
    if (ap.active && active?.kind === 'wifi') openIp(active, k(`ap:${ap.id}`))
    else {
      toast(`Connect to ${ap.ssid} first. These settings can only be changed and tested while the box is using that connection.`, 'info')
    }
  }
  const apMenu = (ap: WifiAp): void =>
    menu(ap.ssid, [
      ...(ap.active ? [] : [{ id: 'connect', label: 'Connect', icon: 'wifi', onSelect: () => (ap.known || !ap.secure ? void connect(ap.ssid) : askPassword(ap.ssid)) }]),
      ...(advanced && ap.known ? [{ id: 'ip', label: 'IP settings', icon: 'sliders' as const, onSelect: () => apIp(ap) }] : []),
      ...(ap.secure ? [{ id: 'pw', label: 'Type a new password', icon: 'keyboard', onSelect: () => askPassword(ap.ssid) }] : []),
      ...(ap.known ? [{ id: 'forget', label: 'Forget this network', icon: 'trash', danger: true, onSelect: () => forget(ap) }] : []),
    ])
  const hidden = (): void =>
    keyboard({
      title: 'Network name',
      initial: '',
      maxLength: 32,
      hint: 'Type the name exactly, including capital letters.',
      onDone: (ssid) => {
        if (ssid) keyboard({ title: `Password for ${ssid}`, initial: '', secret: true, maxLength: 64, hint: 'Leave empty if it has none.', onDone: (pw) => void connect(ssid, pw || undefined) })
      },
    })

  if (editing) {
    const back = (): void => {
      setEditing(undefined)
      setRefocus({ key: editing.from })
    }
    return (
      <IpSettings
        profile={editing.profile}
        k={k}
        onCancel={back}
        onSaved={() => {
          back()
          refresh()
        }}
      />
    )
  }

  const st = status.data ? statusText(status.data) : undefined
  return (
    <>
      <Section title="Connection">
        <SettingRow
          focusKey={k('status')}
          icon={status.data?.kind === 'ethernet' ? 'ethernet' : 'wifi'}
          label="Status"
          value={st?.value ?? (status.error ? 'Unknown' : 'Checking…')}
          detail={st?.detail ?? status.error}
          onSelect={status.data ? () => showDetails(status.data as NetStatus) : status.reload}
          opens={Boolean(status.data)}
          testId="net-status"
        />
        {advanced && status.data?.connected && active && (
          <SettingRow
            focusKey={k('ip')}
            icon="sliders"
            label="IP settings"
            value={ipValue(active)}
            detail={active.editable ? `Address, router and DNS for ${active.name}.` : active.why}
            onSelect={() => openIp(active, k('ip'))}
            opens={active.editable}
            testId="net-ip"
          />
        )}
      </Section>
      <Section title="Wi-Fi networks" hint="A network cable is faster and more reliable for films, if you can use one.">
        <SettingRow focusKey={k('scan')} icon="refresh" label="Look for networks again" onSelect={aps.reload} />
        <RowsState loading={aps.loading && !aps.data} error={aps.error} focusKey={k('scan-retry')} onRetry={aps.reload} />
        {(aps.data ?? []).map((ap) => (
          <SettingRow
            key={ap.id}
            focusKey={k(`ap:${ap.id}`)}
            icon={ap.secure ? 'lock' : 'wifi'}
            label={ap.ssid}
            detail={`${signalWord(ap.signal)}${ap.secure ? '' : ' · Open network (not secured)'}`}
            value={ap.active ? 'Connected' : ap.known ? 'Saved' : undefined}
            onSelect={() => choose(ap)}
            onMenu={() => apMenu(ap)}
            testId={`net-ap-${ap.id}`}
          />
        ))}
        {aps.data?.length === 0 && <div className="set-loading">No Wi-Fi networks found.</div>}
        <SettingRow focusKey={k('hidden')} icon="plus" label="Join a hidden network" onSelect={hidden} opens />
      </Section>
    </>
  )
}

// ---------- Display ----------

const REVERT_SEC = 15

function modeText(m: DisplayMode | undefined): string {
  return m ? `${m.width} × ${m.height} at ${Math.round(m.refresh)} Hz` : 'Unknown'
}

/** Change the picture size, and change it back unless the user says it looks right within 15 seconds. */
async function trySetMode(out: DisplayOutput, modeId: string, after: () => void): Promise<void> {
  const before = out.current?.id
  if (!(await run('display.setMode', out.id, modeId))) return
  after()
  if (!before) return
  const restore = before
  let kept = false
  const id = openOverlay({
    kind: 'confirm',
    title: 'Can you see this clearly?',
    body: `If not, do nothing: the picture goes back to how it was in ${REVERT_SEC} seconds.`,
    confirmLabel: 'Yes, keep it',
    cancelLabel: 'Go back',
    startOnCancel: true,
    onConfirm: () => {
      kept = true
      clearTimeout(timer)
    },
    onCancel: () => revert(),
  })
  function revert(): void {
    if (kept) return
    kept = true
    clearTimeout(timer)
    closeOverlay(id)
    void run('display.setMode', out.id, restore).then(after)
  }
  const timer = setTimeout(revert, REVERT_SEC * 1000)
}

const SCALES = [
  { value: 0.85, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Extra large' },
]
const SAVER = [0, 5, 10, 20, 30, 60].map((m) => ({ value: m, label: m === 0 ? 'Never' : `After ${m} minutes` }))
const SCREEN_OFF = [0, 30, 60, 120, 240].map((m) => ({
  value: m,
  label: m === 0 ? 'Never' : m < 60 ? `After ${m} minutes` : `After ${m / 60} hour${m === 60 ? '' : 's'}`,
}))

export function DisplayPage({ k }: { k: (n: string) => string }): ReactNode {
  const s = useSettings()
  const outs = useCall('display.outputs', [])
  const shown = (outs.data ?? []).filter((o) => o.connected)
  const multi = shown.length > 1

  return (
    <>
      <Section title="Picture">
        <RowsState loading={outs.loading && !outs.data} error={outs.error} focusKey={k('retry')} onRetry={outs.reload} />
        {shown.map((o) => (
          <ChoiceRow
            key={o.id}
            focusKey={k(`mode:${o.id}`)}
            icon="display"
            label={multi ? `Picture size (${o.name})` : 'Picture size'}
            detail="Choose the size your TV says it supports. 4K TVs: 3840 × 2160."
            value={o.current?.id}
            choices={o.modes.map((m) => ({ value: m.id, label: modeText(m) }))}
            onChange={(id) => void trySetMode(o, id, outs.reload)}
          />
        ))}
        {outs.data && shown.length === 0 && <div className="set-loading">No TV is connected.</div>}
        <ChoiceRow
          focusKey={k('scale')}
          icon="sliders"
          label="Text size"
          detail="Makes everything on screen bigger or smaller."
          value={SCALES.find((x) => Math.abs(x.value - s.display.uiScale) < 0.01)?.value ?? s.display.uiScale}
          choices={SCALES}
          onChange={(v) => void updateSettings({ display: { uiScale: v } })}
        />
      </Section>
      <Section title="When nothing is happening">
        <ChoiceRow
          focusKey={k('saver')}
          icon="moon"
          label="Screensaver"
          detail="Shows a clock when the remote hasn't been used for a while. Never during films."
          value={s.display.screensaverMin}
          choices={SAVER}
          onChange={(v) => void updateSettings({ display: { screensaverMin: v } })}
        />
        <ChoiceRow
          focusKey={k('off')}
          icon="power"
          label="Turn the screen off"
          value={s.display.screenOffMin}
          choices={SCREEN_OFF}
          onChange={(v) => void updateSettings({ display: { screenOffMin: v } })}
        />
      </Section>
    </>
  )
}

// ---------- Sound ----------

const CHANNELS = [
  { value: 'stereo' as const, label: 'Stereo', detail: 'TV speakers and most soundbars' },
  { value: '5.1' as const, label: '5.1 surround', detail: 'Surround sound systems' },
  { value: '7.1' as const, label: '7.1 surround', detail: 'Larger surround systems' },
]

export function SoundPage({ k }: { k: (n: string) => string }): ReactNode {
  const s = useSettings()
  const outs = useCall('audio.outputs', [])
  const vol = useCall('audio.volume', [])
  const active = outs.data?.find((o) => o.active)

  return (
    <>
      <Section title="Sound">
        <RowsState loading={outs.loading && !outs.data} error={outs.error} focusKey={k('retry')} onRetry={outs.reload} />
        {outs.data && outs.data.length === 0 && (
          <div className="set-loading">No sound outputs found. Check the TV or speakers are plugged in and switched on.</div>
        )}
        {outs.data && outs.data.length > 0 && (
          <ChoiceRow
            focusKey={k('output')}
            icon="sound"
            label="Play sound through"
            value={active?.id}
            choices={outs.data.map((o) => ({ value: o.id, label: o.name }))}
            onChange={(id) => void run('audio.setOutput', id).then(outs.reload)}
          />
        )}
        {vol.data !== undefined && (
          <StepperRow
            focusKey={k('volume')}
            icon="sound"
            label="Volume"
            detail="Use left and right to change it. Your TV's own volume works as well."
            value={vol.data}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onChange={(v) => void run('audio.setVolume', v).then(vol.reload)}
          />
        )}
        <ChoiceRow
          focusKey={k('channels')}
          icon="sliders"
          label="Speakers"
          value={s.sound.channels}
          choices={CHANNELS}
          onChange={(v) =>
            void run('audio.setChannels', v).then((ok) => {
              if (ok) void updateSettings({ sound: { channels: v } })
            })
          }
        />
        <SettingRow focusKey={k('test')} icon="play" label="Play a test sound" onSelect={() => void run('audio.testTone')} />
        <ToggleRow
          focusKey={k('ui')}
          icon="remote"
          label="Button sounds"
          detail="A soft click when you move around the menus."
          on={s.sound.uiSounds}
          onChange={(on) => void updateSettings({ sound: { uiSounds: on } })}
        />
      </Section>
    </>
  )
}

// ---------- Remotes ----------

const KIND: Record<BtDevice['kind'], string> = {
  remote: 'Remote',
  gamepad: 'Game controller',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  headphones: 'Headphones',
  speaker: 'Speaker',
  phone: 'Phone',
  other: 'Device',
}
const KIND_ICON: Record<BtDevice['kind'], string> = {
  remote: 'remote',
  gamepad: 'gamepad',
  keyboard: 'keyboard',
  mouse: 'pointer',
  headphones: 'sound',
  speaker: 'sound',
  phone: 'phone',
  other: 'bluetooth',
}
const SCAN_MS = 60_000

const BUTTON_HELP: [string, string][] = [
  ['OK', 'Choose. Hold it to see options (same as the Menu button).'],
  ['Back', 'Go back. Hold it to jump to Home.'],
  ['Home', 'Go to Home from anywhere, even inside apps. Hold it for recovery options.'],
  ['Play/Pause', 'Play the film or show you are on.'],
  ['Keyboard', 'Arrows and Enter; Esc is Back, F1 is Home, M is Menu, F12 is Power.'],
  ['Game controller', 'A is OK, B is Back, Start is Menu, the Xbox/PS button is Home.'],
]

export function RemotesPage({ k }: { k: (n: string) => string }): ReactNode {
  const s = useSettings()
  const cec = useCall('cec.status', [])
  const bt = useCall('bluetooth.devices', [])
  const net = useCall('network.status', [])
  const [scanning, setScanning] = useState(false)
  const reloadBt = bt.reload

  // While looking for devices, refresh the list every few seconds and stop after a minute.
  useEffect(() => {
    if (!scanning) return
    const tick = setInterval(reloadBt, 3000)
    const stop = setTimeout(() => {
      setScanning(false)
      void call('bluetooth.scan', false).catch(() => undefined)
    }, SCAN_MS)
    return () => {
      clearInterval(tick)
      clearTimeout(stop)
    }
  }, [scanning, reloadBt])
  // Stop looking when leaving the page.
  useEffect(() => () => void call('bluetooth.scan', false).catch(() => undefined), [])

  const toggleScan = (): void => {
    const next = !scanning
    void run('bluetooth.scan', next).then((ok) => {
      if (ok) setScanning(next)
    })
  }
  const pair = (d: BtDevice): void => {
    toast(`Pairing with ${d.name}…`, 'info')
    void run('bluetooth.pair', d.address).then((ok) => {
      if (ok) toast(`${d.name} is ready to use`, 'ok')
      bt.reload()
    })
  }
  const remove = (d: BtDevice): void =>
    menu(d.name, [
      {
        id: 'remove',
        label: 'Forget this device',
        icon: 'trash',
        danger: true,
        onSelect: () =>
          void run('bluetooth.remove', d.address).then((ok) => {
            if (ok) toast(`Forgot ${d.name}`, 'ok')
            bt.reload()
          }),
      },
    ])

  const c = cec.data
  const tvPower = c?.tvPower === 'on' ? 'on' : c?.tvPower === 'standby' ? 'on standby' : undefined
  // The adapter only has an HDMI address once it can see the TV.
  const seesTv = !!c?.adapter && c.physicalAddress !== undefined
  const phoneUrl = net.data?.ip ? `http://${net.data.ip}:${s.remote.port}` : undefined

  return (
    <>
      <Section title="TV remote (HDMI-CEC)" hint="Lets your normal TV remote control MediaOS, and turns the TV on and off with the box.">
        <SettingRow
          focusKey={k('cec')}
          icon="tv"
          label="TV connection"
          value={c ? (c.adapter ? (seesTv ? 'Ready' : "Can't see the TV") : 'No adapter') : cec.error ? 'Unknown' : 'Checking…'}
          detail={
            c?.adapter
              ? seesTv
                ? `${c.adapterName ?? 'CEC adapter'}${c.tvName ? ` · ${c.tvName}` : ''}${tvPower ? ` (${tvPower})` : ''}`
                : `${c.adapterName ?? 'CEC adapter'} · Check its HDMI cable goes into the TV and the TV is plugged in.`
              : c
                ? "Most mini PCs can't hear the TV remote on their own. Plug a Pulse-Eight USB-CEC adapter in between the box and the TV."
                : cec.error
          }
          onSelect={cec.reload}
        />
        <ToggleRow
          focusKey={k('cec-wake')}
          label="Turn the TV on when MediaOS starts"
          on={s.cec.wakeTvOnStart}
          disabled={!c?.adapter}
          onChange={(on) => void updateSettings({ cec: { wakeTvOnStart: on } })}
        />
        <ToggleRow
          focusKey={k('cec-standby')}
          label="Turn the TV off when the box turns off"
          on={s.cec.standbyTvOnPowerOff}
          disabled={!c?.adapter}
          onChange={(on) => void updateSettings({ cec: { standbyTvOnPowerOff: on } })}
        />
        {c?.adapter && (
          <>
            <SettingRow focusKey={k('tv-on')} icon="power" label="Turn the TV on" onSelect={() => void run('cec.wakeTv').then(cec.reload)} />
            <SettingRow focusKey={k('tv-off')} icon="moon" label="Put the TV on standby" onSelect={() => void run('cec.standbyTv').then(cec.reload)} />
          </>
        )}
      </Section>
      <Section title="Bluetooth" hint="Remotes, game controllers, keyboards and headphones. Put the device in pairing mode first.">
        <SettingRow
          focusKey={k('bt-scan')}
          icon="bluetooth"
          label={scanning ? 'Stop looking for devices' : 'Look for devices'}
          detail={scanning ? 'Looking… new devices appear below.' : undefined}
          onSelect={toggleScan}
          testId="bt-scan"
        />
        <RowsState loading={bt.loading && !bt.data} error={bt.error} focusKey={k('bt-retry')} onRetry={bt.reload} />
        {(bt.data ?? []).map((d) => (
          <SettingRow
            key={d.address}
            focusKey={k(`bt:${d.address}`)}
            icon={KIND_ICON[d.kind]}
            label={d.name}
            detail={`${KIND[d.kind]}${d.battery !== undefined ? ` · Battery ${d.battery}%` : ''}${
              d.paired && !d.connected ? ' · Switch it on to use it' : !d.paired ? ' · Choose to add it' : ''
            }`}
            value={d.connected ? 'Connected' : d.paired ? 'Not connected' : 'New'}
            onSelect={() => (d.paired ? remove(d) : pair(d))}
            onMenu={d.paired ? () => remove(d) : undefined}
          />
        ))}
        {bt.data && bt.data.length === 0 && !scanning && <div className="set-loading">No Bluetooth devices.</div>}
      </Section>
      <Section title="Phone remote">
        <ToggleRow
          focusKey={k('phone')}
          icon="phone"
          label="Use a phone as a remote"
          detail={
            s.remote.phoneRemote
              ? phoneUrl
                ? `On a phone on the same Wi-Fi, open ${phoneUrl}`
                : 'Connect the box to your network to use this.'
              : 'Turned off.'
          }
          on={s.remote.phoneRemote}
          onChange={(on) => void updateSettings({ remote: { phoneRemote: on } })}
        />
      </Section>
      <Section title="Buttons">
        {BUTTON_HELP.map(([label, text]) => (
          <SettingRow key={label} focusKey={k(`help:${label}`)} label={label} detail={text} />
        ))}
      </Section>
    </>
  )
}
