// The ONLY bridge between the renderer (UI) and the main process (core).
// Every call's arguments are validated with zod in the preload (before sending) and again in main (on receipt),
// because the renderer is treated as untrusted. Results come from main (trusted) and are typed, not re-validated.
import { z } from 'zod'
import type { HomeData, Library, MediaItem, MediaItemDetail, Page, SourceInfo } from './media-types'
import type { AppEntry } from './apps'
import type { PlayerState } from './player-types'
import type { WeatherNow, WeatherPlace } from './weather'
import type {
  AudioSink, BtDevice, CecStatus, DisplayOutput, IpConfig as IpConfigType, NetProfile, NetStatus, NetTrial, Result, SysInfo,
  TimeInfo, Toast, UpdateInfo, WifiAp,
} from './system-types'
import { Settings, SettingsPatch } from './settings-schema'
import { ACTIONS, type Action } from './actions'
import { MAX_SOURCES } from './limits'

export const CALL_CHANNEL = 'mediaos:call'
export const EVENT_CHANNEL = 'mediaos:event'

const Key = z.string().min(3).max(300).regex(/^[^~]+~.+$/, 'item key')
const Id = z.string().min(1).max(200)
const Url = z.string().min(1).max(500)
const Text = z.string().max(200)

const BrowseQuery = z.object({
  sort: z.enum(['title', 'added', 'year', 'rating']),
  descending: z.boolean().optional(),
  filter: z.enum(['all', 'unwatched', 'favourites']).optional(),
  offset: z.number().int().min(0).max(1_000_000),
  limit: z.number().int().min(1).max(200),
})

const PlayOpts = z.object({
  resume: z.boolean(),
  audioIdx: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  subIdx: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
})

const PlayerCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('togglePause') }),
  z.object({ kind: z.literal('seekRelative'), seconds: z.number().min(-36000).max(36000) }),
  z.object({ kind: z.literal('seekTo'), seconds: z.number().min(0).max(360000) }),
  z.object({ kind: z.literal('stop') }),
  z.object({ kind: z.literal('setAudio'), index: z.number().int().min(0).max(999) }),
  z.object({ kind: z.literal('setSubtitle'), index: z.number().int().min(0).max(999).nullable() }),
  z.object({ kind: z.literal('playNext') }),
  z.object({ kind: z.literal('cancelUpNext') }),
])

// Network IP settings. Main runs checkIpConfig (src/shared/ipv4.ts) again after these.
const Octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const Ipv4 = z.string().min(7).max(15).regex(new RegExp(`^${Octet}(?:\\.${Octet}){3}$`), 'IPv4 address')
const ProfileId = z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'profile id')
const DnsChoice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('router') }).strict(),
  z.object({ mode: z.literal('preset'), preset: z.enum(['cloudflare', 'google', 'quad9']) }).strict(),
  z.object({ mode: z.literal('custom'), servers: z.array(Ipv4).min(1).max(2) }).strict(),
])
const IpConfig = z.discriminatedUnion('method', [
  z.object({ method: z.literal('auto'), dns: DnsChoice }).strict(),
  z.object({
    method: z.literal('manual'), address: Ipv4, prefix: z.number().int().min(8).max(30), gateway: Ipv4, dns: DnsChoice,
  }).strict(),
])
// Compile-time check: what zod lets through is a valid IpConfig.
const _ipConfigFits: IpConfigType = undefined as unknown as z.infer<typeof IpConfig>
void _ipConfigFits
const NetCheck = z.enum(['checking', 'ok', 'failed'])
const NetTrialSchema = z.object({
  profileId: z.string(), name: z.string().max(200), phase: z.enum(['applying', 'checking', 'ready']),
  secondsLeft: z.number(), address: z.string().optional(), router: NetCheck, dns: NetCheck, internet: NetCheck,
  canKeep: z.boolean(),
}).strict()

/** Argument schemas for every call, as tuples. */
export const CALLS = {
  // Home and browsing
  'home.get': z.tuple([]),
  'home.refresh': z.tuple([]),
  'sources.list': z.tuple([]),
  'sources.remove': z.tuple([Id]),
  'sources.rename': z.tuple([Id, z.string().min(1).max(80)]),
  'libraries.list': z.tuple([]),
  'libraries.browse': z.tuple([Key, BrowseQuery]),
  'items.get': z.tuple([Key]),
  'items.children': z.tuple([Key]),
  'items.setWatched': z.tuple([Key, z.boolean()]),
  'items.setFavourite': z.tuple([Key, z.boolean()]),
  'search.query': z.tuple([Text]),

  // Weather beside the clock (the town is saved in settings.weather)
  'weather.search': z.tuple([Text]),
  'weather.get': z.tuple([]),

  // Signing in to servers
  'jellyfin.discover': z.tuple([]),
  'jellyfin.probe': z.tuple([Url]),
  'jellyfin.quickConnect': z.tuple([Url]),
  'jellyfin.password': z.tuple([Url, z.string().min(1).max(200), z.string().max(500)]),
  'plex.pin': z.tuple([]),
  'signin.poll': z.tuple([Id]),
  'signin.cancel': z.tuple([Id]),
  'plex.addServers': z.tuple([Id, z.array(Id).min(1).max(MAX_SOURCES)]),

  // Playback
  'player.play': z.tuple([Key, PlayOpts]),
  'player.command': z.tuple([PlayerCommand]),
  'player.state': z.tuple([]),

  // Streaming apps
  'apps.list': z.tuple([]),
  'apps.launch': z.tuple([Id]),
  'apps.close': z.tuple([]),
  'apps.resetProfile': z.tuple([Id]),

  // Settings
  'settings.get': z.tuple([]),
  'settings.update': z.tuple([SettingsPatch]),

  // System (network, sound, display, Bluetooth, TV remote, power, time, info)
  'network.status': z.tuple([]),
  'network.scan': z.tuple([]),
  // A Wi-Fi password is 8-63 characters, or the 64-hex-digit key some routers print instead.
  'network.connect': z.tuple([z.string().min(1).max(32),
    z.string().max(64).refine((k) => k.length <= 63 || /^[0-9a-fA-F]{64}$/.test(k)).optional()]),
  'network.forget': z.tuple([Id]),
  'network.profiles': z.tuple([]),
  /** Starts a "Keep these settings?" trial; the old settings come back unless network.keep is called in time. */
  'network.applyIp': z.tuple([ProfileId, IpConfig]),
  'network.trial': z.tuple([]),
  'network.keep': z.tuple([]),
  'network.revert': z.tuple([]),
  'network.resetAll': z.tuple([z.literal('AUTOMATIC')]),
  'audio.outputs': z.tuple([]),
  'audio.setOutput': z.tuple([Id]),
  'audio.volume': z.tuple([]),
  'audio.setVolume': z.tuple([z.number().int().min(0).max(100)]),
  'audio.setChannels': z.tuple([z.enum(['stereo', '5.1', '7.1'])]),
  'audio.testTone': z.tuple([]),
  'display.outputs': z.tuple([]),
  'display.setMode': z.tuple([Id, Id]),
  'display.setScale': z.tuple([Id, z.number().min(0.5).max(3)]),
  'bluetooth.devices': z.tuple([]),
  'bluetooth.scan': z.tuple([z.boolean()]),
  'bluetooth.pair': z.tuple([Id]),
  'bluetooth.remove': z.tuple([Id]),
  'cec.status': z.tuple([]),
  'cec.wakeTv': z.tuple([]),
  'cec.standbyTv': z.tuple([]),
  'power.reboot': z.tuple([]),
  'power.powerOff': z.tuple([]),
  'power.screenOff': z.tuple([]),
  'power.screenOn': z.tuple([]),
  'time.get': z.tuple([]),
  'time.zones': z.tuple([]),
  'time.setTimezone': z.tuple([z.string().min(1).max(64)]),
  'updates.check': z.tuple([]),
  'info.get': z.tuple([]),
  'info.diagnostics': z.tuple([]),
  'shell.restart': z.tuple([]),
  'shell.factoryReset': z.tuple([z.literal('ERASE')]),
  /** Renderer tells core what is in the foreground of the shell (for routing and the screensaver). */
  'shell.reportIdle': z.tuple([z.boolean()]),
  /** Warnings from startup (e.g. damaged settings), handed over once the screen is listening. */
  'shell.notices': z.tuple([]),
} as const

export type CallName = keyof typeof CALLS
export type CallArgs<N extends CallName> = z.infer<(typeof CALLS)[N]>

export interface DiscoveredServer {
  id: string
  name: string
  url: string
}

export interface JellyfinProbe {
  serverName: string
  version: string
  quickConnect: boolean
  /** Normalised URL to use from now on. */
  url: string
}

export interface SignInStart {
  flowId: string
  /** Code the user types on another device (Jellyfin Quick Connect code, or the plex.tv/link code). */
  code: string
  /** Where to enter it, e.g. "plex.tv/link" or "Jellyfin > Quick Connect". */
  where: string
  /** URL for a QR code on the TV (Plex only). */
  qrUrl?: string
  expiresAt: string
}

export interface PlexServerChoice {
  id: string
  name: string
  owned: boolean
  /** Plain-English reachability, e.g. "On this network", "Remote (needs Plex Pass to stream)". */
  reach: string
}

export type SignInPoll =
  | { state: 'waiting' }
  | { state: 'done'; source: SourceInfo }
  | { state: 'chooseServers'; servers: PlexServerChoice[] }
  | { state: 'expired' }
  | { state: 'error'; message: string }

export interface CallResults {
  'home.get': HomeData
  'home.refresh': HomeData
  'sources.list': SourceInfo[]
  'sources.remove': Result
  'sources.rename': Result
  'libraries.list': Library[]
  'libraries.browse': Page<MediaItem>
  'items.get': MediaItemDetail
  'items.children': MediaItem[]
  'items.setWatched': Result
  'items.setFavourite': Result
  'search.query': MediaItem[]
  'weather.search': WeatherPlace[]
  /** Null when the weather is off, no town is chosen, or there is no recent reading (the chip hides). */
  'weather.get': WeatherNow | null
  'jellyfin.discover': DiscoveredServer[]
  'jellyfin.probe': JellyfinProbe
  'jellyfin.quickConnect': SignInStart
  'jellyfin.password': SourceInfo
  'plex.pin': SignInStart
  'signin.poll': SignInPoll
  'signin.cancel': Result
  'plex.addServers': SourceInfo[]
  'player.play': Result
  'player.command': Result
  'player.state': PlayerState
  'apps.list': AppEntry[]
  'apps.launch': Result
  'apps.close': Result
  'apps.resetProfile': Result
  'settings.get': Settings
  'settings.update': Settings
  'network.status': NetStatus
  'network.scan': WifiAp[]
  'network.connect': Result
  'network.forget': Result
  'network.profiles': NetProfile[]
  'network.applyIp': Result
  'network.trial': NetTrial | null
  'network.keep': Result
  'network.revert': Result
  'network.resetAll': Result
  'audio.outputs': AudioSink[]
  'audio.setOutput': Result
  'audio.volume': number
  'audio.setVolume': Result
  'audio.setChannels': Result
  'audio.testTone': Result
  'display.outputs': DisplayOutput[]
  'display.setMode': Result
  'display.setScale': Result
  'bluetooth.devices': BtDevice[]
  'bluetooth.scan': Result
  'bluetooth.pair': Result
  'bluetooth.remove': Result
  'cec.status': CecStatus
  'cec.wakeTv': Result
  'cec.standbyTv': Result
  'power.reboot': Result
  'power.powerOff': Result
  'power.screenOff': Result
  'power.screenOn': Result
  'time.get': TimeInfo
  'time.zones': string[]
  'time.setTimezone': Result
  'updates.check': UpdateInfo
  'info.get': SysInfo
  'info.diagnostics': { path: string }
  'shell.restart': Result
  'shell.factoryReset': Result
  'shell.reportIdle': Result
  'shell.notices': Toast[]
}

// Compile-time check: every call has a result type and vice versa.
type _Missing = Exclude<CallName, keyof CallResults> | Exclude<keyof CallResults, CallName>
const _exhaustive: [_Missing] extends [never] ? true : never = true
void _exhaustive

/** Events pushed from core to the renderer. */
export type Foreground = { kind: 'shell' } | { kind: 'player' } | { kind: 'app'; appId: string }

export interface EventPayloads {
  /** An action from a source the DOM can't see (gamepad via inputd, phone remote, CEC daemon, control socket). */
  action: { action: Action; long?: boolean }
  player: PlayerState
  /** Library data changed (new sign-in, watched state from another device...). */
  homeChanged: Record<string, never>
  toast: Toast
  foreground: Foreground
  /** Something in Settings > Network / Bluetooth changed. */
  system: { what: 'network' | 'bluetooth' | 'audio' | 'display' }
  /** Core asks the UI to open the Recovery menu (long Home, Ctrl+Alt+Backspace, crash loop). */
  recovery: Record<string, never>
  /** A network trial started, ticked, changed its checks or ended (null). */
  netTrial: { trial: NetTrial | null }
}
export type EventName = keyof EventPayloads

export const EVENT_SCHEMAS: { [K in EventName]: z.ZodType } = {
  action: z.object({ action: z.enum(ACTIONS), long: z.boolean().optional() }),
  player: z.object({ status: z.string(), backend: z.enum(['mpv', 'mock']), positionSec: z.number() }).loose(),
  homeChanged: z.object({}).loose(),
  toast: z.object({ id: z.string(), text: z.string().max(500), tone: z.enum(['info', 'warn', 'error', 'ok']).optional() }),
  foreground: z.object({ kind: z.enum(['shell', 'player', 'app']), appId: z.string().optional() }),
  system: z.object({ what: z.enum(['network', 'bluetooth', 'audio', 'display']) }),
  recovery: z.object({}).loose(),
  netTrial: z.object({ trial: NetTrialSchema.nullable() }).strict(),
}

/** Wire format of a call's reply (Electron mangles thrown errors, so errors travel as data). */
export type CallReply<T> = { ok: true; value: T } | { ok: false; error: string }

/** What the preload exposes as `window.mediaos`. */
export interface MediaosApi {
  readonly platform: 'linux' | 'mock'
  call<N extends CallName>(name: N, ...args: CallArgs<N>): Promise<CallResults[N]>
  on<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void): () => void
}

/** Validate a call's arguments; returns a plain-English error or undefined. */
export function validateCall(name: unknown, args: unknown): { name: CallName; args: unknown[] } | { error: string } {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(CALLS, name)) return { error: `Unknown call ${String(name)}` }
  const schema = CALLS[name as CallName]
  const parsed = schema.safeParse(args)
  if (!parsed.success) return { error: `Bad arguments for ${name}: ${parsed.error.issues[0]?.message ?? 'invalid'}` }
  return { name: name as CallName, args: parsed.data as unknown[] }
}

export type { Settings, SettingsPatch }
