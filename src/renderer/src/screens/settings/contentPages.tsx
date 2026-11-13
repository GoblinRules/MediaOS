// Settings pages about what you watch: libraries (servers), the Home screen, apps, playback and the system.
import { useEffect, useState, type ReactNode } from 'react'
import type { SourceInfo, SourceStatus } from '@shared/media-types'
import type { HomeRowId, Settings } from '@shared/settings-schema'
import type { UpdateAction } from '@shared/system-types'
import { placeDetail, placeLabel, type WeatherPlace } from '@shared/weather'
import { run, tryCall } from '../../lib/api'
import { openAppMenu } from '../../lib/apps'
import { invalidateData, useCall } from '../../lib/useCall'
import { factoryReset, openPowerMenu, saveDiagnostics } from '../../overlays/systemMenus'
import { confirm, focusScreen, keyboard, menu } from '../../state/nav'
import { loadSettings, updateSettings, useSettings } from '../../state/settings'
import { toast } from '../../state/toasts'
import { ChoiceRow, RowsState, Section, SettingRow, StepperRow, ToggleRow } from './parts'
import { SignInFlow, type SignInKind } from './SignIn'

type K = { k: (n: string) => string; prefix: string }

// ---------- Libraries ----------

const STATUS: Record<SourceStatus, string> = {
  ok: 'Connected',
  connecting: 'Connecting…',
  offline: "Can't reach it",
  'signed-out': 'Signed out',
  error: 'Problem',
}

function sourceDetail(s: SourceInfo): string {
  if (s.status !== 'ok' && s.message) return s.message
  const kind = s.kind === 'plex' ? 'Plex' : s.kind === 'jellyfin' ? 'Jellyfin' : 'Demo'
  return [kind, s.serverName && s.serverName !== s.name ? s.serverName : undefined, s.userName && `signed in as ${s.userName}`]
    .filter(Boolean)
    .join(' · ')
}

async function refreshSources(): Promise<void> {
  await loadSettings().catch(() => undefined)
  invalidateData()
}

export function LibrariesPage({ k, prefix }: K): ReactNode {
  const list = useCall('sources.list', [])
  const [adding, setAdding] = useState<{ kind: SignInKind; url?: string; from: string }>()
  // An object so asking for the same row twice still moves focus.
  const [refocus, setRefocus] = useState<{ key: string }>()

  useEffect(() => {
    if (refocus) focusScreen(refocus.key)
  }, [refocus])

  if (adding) {
    const back = (): void => {
      setAdding(undefined)
      setRefocus({ key: adding.from })
    }
    return (
      <SignInFlow
        kind={adding.kind}
        prefix={prefix}
        url={adding.url}
        onCancel={back}
        onDone={(added) => {
          toast(added.length === 1 ? `Added ${added[0]?.name ?? 'your server'}` : `Added ${added.length} servers`, 'ok')
          back()
          void refreshSources().then(list.reload)
        }}
      />
    )
  }

  const rename = (s: SourceInfo): void =>
    keyboard({
      title: 'Name for this library',
      initial: s.name,
      maxLength: 80,
      onDone: (name) => {
        const clean = name.trim()
        if (!clean || clean === s.name) return
        void run('sources.rename', s.id, clean).then(async (ok) => {
          if (ok) await refreshSources()
          list.reload()
        })
      },
    })
  const remove = (s: SourceInfo): void =>
    confirm({
      title: `Remove ${s.name}?`,
      body: 'Its films and shows disappear from MediaOS. Nothing is deleted from the server itself.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () =>
        void run('sources.remove', s.id).then(async (ok) => {
          if (ok) {
            toast(`Removed ${s.name}`, 'ok')
            await refreshSources()
            setRefocus({ key: k('add-jellyfin') })
          }
          list.reload()
        }),
    })
  const options = (s: SourceInfo): void =>
    menu(s.name, [
      { id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => rename(s) },
      ...(s.kind === 'jellyfin' && s.url
        ? [{ id: 'signin', label: 'Sign in again', icon: 'user', onSelect: () => setAdding({ kind: 'jellyfin', url: s.url, from: k(`src:${s.id}`) }) }]
        : []),
      ...(s.kind === 'plex' ? [{ id: 'signin', label: 'Sign in to Plex again', icon: 'user', onSelect: () => setAdding({ kind: 'plex', from: k(`src:${s.id}`) }) }] : []),
      { id: 'remove', label: 'Remove', icon: 'trash', danger: true, onSelect: () => remove(s) },
    ])

  return (
    <>
      <Section title="Add a library" hint="MediaOS plays films and shows from your own Jellyfin or Plex server.">
        <SettingRow
          focusKey={k('add-jellyfin')}
          icon="server"
          label="Add a Jellyfin server"
          detail="Finds servers on your network for you."
          onSelect={() => setAdding({ kind: 'jellyfin', from: k('add-jellyfin') })}
          opens
          testId="add-jellyfin"
        />
        <SettingRow
          focusKey={k('add-plex')}
          icon="server"
          label="Add Plex"
          detail="Sign in with a code on your phone. Watching away from home needs Plex Pass."
          onSelect={() => setAdding({ kind: 'plex', from: k('add-plex') })}
          opens
          testId="add-plex"
        />
      </Section>
      <Section title="Your libraries">
        <RowsState loading={list.loading && !list.data} error={list.error} focusKey={k('retry')} onRetry={list.reload} />
        {list.data?.length === 0 && <div className="set-loading">No libraries yet. Add one above.</div>}
        {(list.data ?? []).map((s) => (
          <SettingRow
            key={s.id}
            focusKey={k(`src:${s.id}`)}
            icon={s.status === 'ok' ? 'server' : 'warning'}
            label={s.name}
            detail={sourceDetail(s)}
            value={STATUS[s.status]}
            onSelect={() => options(s)}
            onMenu={() => options(s)}
            opens
            testId={`source-${s.id}`}
          />
        ))}
      </Section>
    </>
  )
}

// ---------- Home screen ----------

const ROW_LABEL: Record<HomeRowId, string> = {
  continue: 'Continue watching',
  nextUp: 'Next up',
  apps: 'Apps',
  latest: 'Recently added',
  libraries: 'Your libraries',
}

function moveRow(rows: HomeRowId[], id: HomeRowId, by: number): HomeRowId[] {
  const i = rows.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= rows.length) return rows
  const next = [...rows]
  next[i] = rows[j] as HomeRowId
  next[j] = id
  return next
}

/** The list with `id` added (when `add`) or taken out, built from the newest settings so quick toggles all survive. */
function toggled(list: HomeRowId[], id: HomeRowId, add: boolean): HomeRowId[] {
  const rest = list.filter((x) => x !== id)
  return add ? [...rest, id] : rest
}

/** Asks for a town by name and lets the user pick the right one; the weather service never sees the network address. */
function chooseTown(initial: string): void {
  keyboard({
    title: 'Choose your town',
    initial,
    maxLength: 100,
    hint: 'Type the name of your town or city.',
    onDone: (text) => void findTown(text),
  })
}

async function findTown(text: string): Promise<void> {
  const name = text.trim()
  if (name.length < 2) return
  const places = await tryCall('weather.search', name)
  if (!places) return
  if (places.length === 0) {
    toast(`No towns found called "${name}". Check the spelling.`)
    return
  }
  const pick = (place: WeatherPlace): void => void updateSettings({ weather: { place, enabled: true } })
  menu('Choose your town', places.map((place, i) => ({
    id: `town:${i}`, label: place.name, detail: placeDetail(place),
    onSelect: () => pick(place),
  })), `Towns called "${name}"`)
}

function WeatherSection({ k }: Pick<K, 'k'>): ReactNode {
  const weather = useSettings().weather
  return (
    <Section title="Weather" hint="The weather for your town shows beside the clock. It comes from Open-Meteo, a free weather service.">
      <ToggleRow
        focusKey={k('weather')}
        label="Weather beside the clock"
        detail={weather.place ? 'Updates every 30 minutes. It hides when the TV is offline.' : 'Choose your town below to see it.'}
        on={weather.enabled}
        onChange={(v) => void updateSettings({ weather: { enabled: v } })}
      />
      <SettingRow
        focusKey={k('town')}
        label="Your town"
        value={weather.place ? placeLabel(weather.place) : 'Not chosen'}
        opens
        onSelect={() => chooseTown(weather.place?.name ?? '')}
        testId="weather-town"
      />
      <ChoiceRow
        focusKey={k('units')}
        label="Temperature"
        title="Temperature"
        value={weather.units}
        choices={[{ value: 'c', label: 'Celsius (°C)' }, { value: 'f', label: 'Fahrenheit (°F)' }]}
        onChange={(v) => void updateSettings({ weather: { units: v } })}
      />
    </Section>
  )
}

export function HomePage({ k }: K): ReactNode {
  const s = useSettings()
  const home = s.home
  const save = (patch: Partial<Settings['home']>): void => void updateSettings({ home: patch })
  const move = (id: HomeRowId, by: number): void => void updateSettings((c) => ({ home: { rows: moveRow(c.home.rows, id, by) } }))
  const rowMenu = (id: HomeRowId, i: number): void =>
    menu(ROW_LABEL[id], [
      { id: 'up', label: 'Move up', icon: 'back', disabled: i === 0, onSelect: () => move(id, -1) },
      { id: 'down', label: 'Move down', icon: 'next', disabled: i === home.rows.length - 1, onSelect: () => move(id, 1) },
    ])

  return (
    <>
      <Section title="Rows on Home" hint="Turn rows on or off. Press Menu (or hold OK) on a row to move it up or down.">
        {home.rows.map((id, i) => {
          const on = !home.hiddenRows.includes(id)
          return (
            <ToggleRow
              key={id}
              focusKey={k(`row:${id}`)}
              label={ROW_LABEL[id]}
              detail={`Row ${i + 1} of ${home.rows.length}`}
              on={on}
              onChange={(v) => void updateSettings((c) => ({ home: { hiddenRows: toggled(c.home.hiddenRows, id, !v) } }))}
              onMenu={() => rowMenu(id, i)}
            />
          )
        })}
      </Section>
      <Section title="Look">
        <ToggleRow
          focusKey={k('hero')}
          label="Big picture at the top"
          detail="Shows artwork and details of whatever you are on."
          on={home.hero}
          onChange={(v) => save({ hero: v })}
        />
        <ToggleRow
          focusKey={k('merge')}
          label="One Continue watching row"
          detail="Mixes all your servers into one row instead of one row each."
          on={home.mergeContinue}
          onChange={(v) => save({ mergeContinue: v })}
        />
      </Section>
      <WeatherSection k={k} />
    </>
  )
}

// ---------- Apps ----------

export function AppsPage({ k }: K): ReactNode {
  const s = useSettings()
  const apps = useCall('apps.list', [])
  const pinned = new Set(s.apps.pinned)
  const hidden = new Set(s.apps.hidden)
  return (
    <Section title="Streaming apps" hint="Choose an app to add it to Home, hide it, or sign out of it.">
      <RowsState loading={apps.loading && !apps.data} error={apps.error} focusKey={k('retry')} onRetry={apps.reload} />
      {(apps.data ?? []).map((a) => (
        <SettingRow
          key={a.id}
          focusKey={k(`app:${a.id}`)}
          icon={a.nav === 'pointer' ? 'pointer' : 'tv'}
          label={a.name}
          detail={a.blocked ? 'Not available on this box' : (a.note ?? (a.nav === 'pointer' ? 'Uses an on-screen pointer' : undefined))}
          value={hidden.has(a.id) ? 'Hidden' : pinned.has(a.id) ? 'On Home' : undefined}
          onSelect={() => openAppMenu(a)}
          onMenu={() => openAppMenu(a)}
          opens
        />
      ))}
    </Section>
  )
}

// ---------- Playback ----------

const LANGS: [string, string][] = [
  ['eng', 'English'],
  ['fra', 'French'],
  ['deu', 'German'],
  ['spa', 'Spanish'],
  ['ita', 'Italian'],
  ['por', 'Portuguese'],
  ['nld', 'Dutch'],
  ['pol', 'Polish'],
  ['swe', 'Swedish'],
  ['nor', 'Norwegian'],
  ['dan', 'Danish'],
  ['fin', 'Finnish'],
  ['cym', 'Welsh'],
  ['gle', 'Irish'],
  ['jpn', 'Japanese'],
  ['kor', 'Korean'],
  ['zho', 'Chinese'],
  ['hin', 'Hindi'],
  ['ara', 'Arabic'],
]

export function PlaybackPage({ k }: K): ReactNode {
  const s = useSettings()
  const p = s.playback
  const save = (patch: Partial<Settings['playback']>): void => void updateSettings({ playback: patch })
  const langs = (none: string) => [{ value: '', label: none }, ...LANGS.map(([value, label]) => ({ value, label }))]

  return (
    <>
      <Section title="Buttons while watching">
        <StepperRow
          focusKey={k('skip-back')}
          icon="rewind"
          label="Left skips back"
          value={p.skipBackSec}
          min={5}
          max={60}
          step={5}
          format={(v) => `${v} sec`}
          onChange={(v) => save({ skipBackSec: v })}
        />
        <StepperRow
          focusKey={k('skip-fwd')}
          icon="forward"
          label="Right skips forward"
          value={p.skipForwardSec}
          min={5}
          max={120}
          step={5}
          format={(v) => `${v} sec`}
          onChange={(v) => save({ skipForwardSec: v })}
        />
        <ToggleRow
          focusKey={k('next')}
          icon="playNext"
          label="Play the next episode automatically"
          on={p.autoPlayNext}
          onChange={(v) => save({ autoPlayNext: v })}
        />
      </Section>
      <Section title="Language and subtitles">
        <ChoiceRow
          focusKey={k('audio')}
          icon="sound"
          label="Preferred audio language"
          detail="Used when a film has more than one."
          value={p.audioLanguage}
          choices={langs("The film's own language")}
          onChange={(v) => save({ audioLanguage: v })}
        />
        <ChoiceRow
          focusKey={k('subs')}
          icon="subtitles"
          label="Subtitles"
          value={p.subtitleMode}
          choices={[
            { value: 'off' as const, label: 'Off' },
            { value: 'forced' as const, label: 'Only for foreign speech', detail: 'For example, an alien language in an English film' },
            { value: 'always' as const, label: 'Always on' },
          ]}
          onChange={(v) => save({ subtitleMode: v })}
        />
        <ChoiceRow
          focusKey={k('subs-lang')}
          icon="globe"
          label="Subtitle language"
          value={p.subtitleLanguage}
          choices={langs('Same as the audio language')}
          onChange={(v) => save({ subtitleLanguage: v })}
        />
        <ChoiceRow
          focusKey={k('subs-size')}
          icon="sliders"
          label="Subtitle size"
          value={p.subtitleSize}
          choices={[
            { value: 'small' as const, label: 'Small' },
            { value: 'medium' as const, label: 'Medium' },
            { value: 'large' as const, label: 'Large' },
          ]}
          onChange={(v) => save({ subtitleSize: v })}
        />
      </Section>
      <Section title="Quality">
        <ToggleRow
          focusKey={k('direct')}
          icon="film"
          label="Play the original file when possible"
          detail="Best picture and less work for your server. Turn off if films stutter."
          on={p.preferDirectPlay}
          onChange={(v) => save({ preferDirectPlay: v })}
        />
      </Section>
    </>
  )
}

// ---------- System ----------

function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}, ${h} hour${h === 1 ? '' : 's'}`
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'}, ${m} min`
  return `${m} min`
}

function zoneLabel(z: string): string {
  return z.replace(/_/g, ' ').replace(/\//g, ' / ')
}

/** "today at 04:12", "yesterday at 21:40" or "3 Nov". */
function whenText(iso: string): string | undefined {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return undefined
  const day = (d: Date): string => d.toDateString()
  const now = new Date()
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (day(t) === day(now)) return `today at ${time}`
  if (day(t) === day(new Date(now.getTime() - 86_400_000))) return `yesterday at ${time}`
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** whenText for the middle of a sentence: "today at 04:12" or "on 3 Nov". */
function whenInSentence(iso: string): string {
  const when = whenText(iso)
  return !when ? 'recently' : /^(today|yesterday) /.test(when) ? when : `on ${when}`
}

/** Release notes short enough for the install question to fit on the screen, cut at a line or word. */
function shortNotes(notes: string, max = 600): string {
  if (notes.length <= max) return notes
  const cut = notes.slice(0, max)
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return `${cut.slice(0, at > max / 2 ? at : max).trimEnd()}…`
}

const RUNNING: Record<UpdateAction, string> = {
  check: 'Checking…',
  apply: 'Installing…',
  auto: 'Updating…',
  rollback: 'Going back…',
}

function UpdateRows({ k }: { k: (n: string) => string }): ReactNode {
  const s = useSettings()
  const status = useCall('updates.status', [])
  // Shows straight away; core's own "running" arrives a moment later with the change event.
  const [asked, setAsked] = useState<UpdateAction>()
  const u = status.data
  const running = asked ?? u?.running
  const busy = running !== undefined

  const check = async (): Promise<void> => {
    setAsked('check')
    const r = await tryCall('updates.check')
    setAsked(undefined)
    status.reload()
    if (r && !r.available) toast('MediaOS is up to date.', 'ok')
  }
  const act = async (action: 'apply' | 'rollback', version: string): Promise<void> => {
    setAsked(action)
    const done = await run(action === 'apply' ? 'updates.apply' : 'updates.rollback')
    setAsked(undefined)
    status.reload()
    if (done) toast(`MediaOS ${version} is installed. The box is restarting to finish.`, 'ok')
  }
  const install = (): void => {
    if (!u?.available) return
    const version = u.available
    const notes = u.notes ? `${shortNotes(u.notes)}\n\n` : ''
    confirm({
      title: `Install MediaOS ${version}?`,
      body: `${notes}The box restarts when it's done, which takes a few minutes. Don't switch it off meanwhile.`,
      confirmLabel: 'Install and restart',
      onConfirm: () => void act('apply', version),
    })
  }
  const goBack = (): void => {
    if (!u?.previous) return
    const version = u.previous
    confirm({
      title: `Go back to MediaOS ${version}?`,
      body: `Use this if something stopped working after the last update. The box restarts when it's done. ` +
        `MediaOS ${u.current} won't be installed overnight again, but you can still install it here.`,
      confirmLabel: 'Go back and restart',
      startOnCancel: true,
      onConfirm: () => void act('rollback', version),
    })
  }

  const checked = u?.checkedAt ? whenText(u.checkedAt) : undefined
  // The last action's failure stays on its own row until another action replaces it (the toast goes after a moment).
  const failed = u?.lastRun && !u.lastRun.ok ? u.lastRun : undefined
  const failedText = (action: UpdateAction): string | undefined => failed?.action === action ? failed.error : undefined
  const checkValue = running === 'check' || running === 'auto'
    ? RUNNING[running]
    : !u ? undefined
    : !u.configured ? 'Not set up'
    : u.available ? `MediaOS ${u.available} is ready`
    : failed?.action === 'check' ? "Couldn't check"
    : checked ? 'Up to date' : undefined
  const checkDetail = !u ? undefined
    : !u.configured ? `Updates aren't set up on this box. It has MediaOS ${u.current}.`
    : `This box has MediaOS ${u.current}.${checked ? ` Last checked ${checked}.` : ''}`
  const overnightFailed = failed?.action === 'auto'
    ? `The overnight update ${whenInSentence(failed.at)} didn't work. ${failed.error ?? ''}`.trimEnd()
    : undefined

  return (
    <Section title="Updates">
      <RowsState loading={status.loading && !u} error={status.error} focusKey={k('updates-retry')} onRetry={status.reload} />
      {u && (
        <>
          <SettingRow
            focusKey={k('updates')}
            icon="download"
            label="Check for updates"
            detail={checkDetail}
            value={checkValue}
            onSelect={busy ? undefined : () => void check()}
            testId="updates-check"
          />
          {u.available && (
            <SettingRow
              focusKey={k('updates-install')}
              icon="download"
              label={`Install MediaOS ${u.available}`}
              detail={failedText('apply') ?? (u.skipped === u.available
                ? "You went back from this version, so it won't install overnight. You can still install it here."
                : "See what's new, then install. The box restarts when it's done.")}
              value={running === 'apply' ? RUNNING.apply : undefined}
              onSelect={busy ? undefined : install}
              opens={!busy}
              testId="updates-install"
            />
          )}
          {u.configured && (
            <ToggleRow
              focusKey={k('updates-auto')}
              icon="clock"
              label="Install updates overnight"
              detail={overnightFailed ?? "Between 4 and 6 in the morning, only when nobody's watching."}
              on={s.updates.auto}
              onChange={(auto) => void updateSettings({ updates: { auto } })}
            />
          )}
          {u.previous && (
            <SettingRow
              focusKey={k('updates-back')}
              icon="refresh"
              label={`Go back to MediaOS ${u.previous}`}
              detail={failedText('rollback') ?? 'If something stopped working after the last update.'}
              value={running === 'rollback' ? RUNNING.rollback : undefined}
              onSelect={busy ? undefined : goBack}
              testId="updates-back"
            />
          )}
        </>
      )}
    </Section>
  )
}

export function SystemPage({ k }: K): ReactNode {
  const s = useSettings()
  const info = useCall('info.get', [])
  const time = useCall('time.get', [])
  const zones = useCall('time.zones', [])

  const rename = (): void =>
    keyboard({
      title: 'Name for this box',
      initial: s.deviceName,
      maxLength: 63,
      hint: 'Shown on your phone and in the Jellyfin and Plex dashboards.',
      onDone: (name) => {
        const clean = name.trim()
        if (clean && clean !== s.deviceName) void updateSettings({ deviceName: clean }).then(info.reload)
      },
    })
  const i = info.data
  const facts: [string, string, string | undefined][] = i
    ? [
        ['version', 'MediaOS version', i.version],
        ['os', 'System', i.os],
        ['kernel', 'Kernel', i.kernel],
        ['cpu', 'Processor', i.cpu],
        ['memory', 'Memory', `${(i.memoryMb / 1024).toFixed(1)} GB`],
        // A size of 0 means the box couldn't read it; leave the row out rather than show "0 GB free of 0 GB".
        ['storage', 'Storage', i.storage.totalGb > 0
          ? `${i.storage.freeGb.toFixed(0)} GB free of ${i.storage.totalGb.toFixed(0)} GB` : undefined],
        ['ip', 'Network address', i.ip],
        ['uptime', 'On for', uptimeText(i.uptimeSec)],
      ]
    : []

  return (
    <>
      <Section title="This box">
        <SettingRow focusKey={k('name')} icon="tv" label="Name" value={s.deviceName} onSelect={rename} opens testId="device-name" />
        <ChoiceRow
          focusKey={k('zone')}
          icon="clock"
          label="Time zone"
          detail={time.data?.ntp === false ? 'The clock is not being set from the internet.' : undefined}
          value={time.data?.timezone}
          choices={(zones.data ?? []).map((z) => ({ value: z, label: zoneLabel(z) }))}
          onChange={(z) => void run('time.setTimezone', z).then(time.reload)}
        />
        <SettingRow
          focusKey={k('setup')}
          icon="refresh"
          label="Run the welcome steps again"
          detail="Set up the network and add libraries step by step. Nothing is erased."
          onSelect={() => void updateSettings({ setupDone: false })}
        />
      </Section>
      <UpdateRows k={k} />
      <Section title="About">
        <RowsState loading={info.loading && !i} error={info.error} focusKey={k('info-retry')} onRetry={info.reload} />
        {facts
          .filter(([, , v]) => v)
          .map(([id, label, value]) => (
            <SettingRow key={id} focusKey={k(`info:${id}`)} label={label} value={value} />
          ))}
      </Section>
      <Section title="Help and power">
        <SettingRow
          focusKey={k('report')}
          icon="info"
          label="Save a problem report"
          detail="Saves a file with recent logs (no passwords) that you can send to whoever helps you."
          onSelect={() => void saveDiagnostics()}
        />
        <SettingRow focusKey={k('power')} icon="power" label="Restart or turn off" onSelect={openPowerMenu} opens />
        <SettingRow
          focusKey={k('erase')}
          icon="trash"
          label="Erase everything"
          detail="Puts MediaOS back to how it was when new."
          danger
          onSelect={factoryReset}
          testId="factory-reset"
        />
      </Section>
    </>
  )
}
