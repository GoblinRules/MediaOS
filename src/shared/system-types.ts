// Shapes returned by SystemServices (network, sound, display, Bluetooth, TV remote, power, time, info).

export type Result = { ok: true } | { ok: false; error: string }

export interface NetStatus {
  connected: boolean
  kind: 'ethernet' | 'wifi' | 'none'
  /** Wi-Fi network name when on Wi-Fi. */
  ssid?: string
  ip?: string
  gateway?: string
  dns?: string[]
  mac?: string
  /** 0..100 for Wi-Fi. */
  signal?: number
  internet: boolean
  /** How the active profile gets its address; 'other' = a NetworkManager method MediaOS doesn't offer. */
  method?: 'auto' | 'manual' | 'other'
  /** Subnet size in bits, e.g. 24 for 255.255.255.0. */
  prefix?: number
  /** The active NetProfile's id. */
  profileId?: string
}

export type DnsPreset = 'cloudflare' | 'google' | 'quad9'
export type DnsChoice =
  /** From the router's DHCP offer; only with method 'auto'. */
  | { mode: 'auto' }
  /** The router (gateway) address; only with method 'manual'. */
  | { mode: 'router' }
  | { mode: 'preset'; preset: DnsPreset }
  /** One or two IPv4 servers. */
  | { mode: 'custom'; servers: string[] }
export type IpConfig =
  | { method: 'auto'; dns: DnsChoice }
  | { method: 'manual'; address: string; prefix: number; gateway: string; dns: DnsChoice }

export interface NetProfile {
  /** NetworkManager connection UUID on Linux; 'wired' / 'wifi:<id>' in the mock. */
  id: string
  kind: 'ethernet' | 'wifi'
  /** "Cable" or the Wi-Fi name. */
  name: string
  active: boolean
  editable: boolean
  /** Plain-English reason when not editable. */
  why?: string
  /** undefined when the profile uses a method MediaOS doesn't offer: the UI shows "Other" and offers Automatic. */
  config?: IpConfig
  /** What the profile is using right now (only when active). */
  live?: { address: string; prefix: number; gateway?: string; dns: string[] }
}

export type NetCheck = 'checking' | 'ok' | 'failed'
/** A network change waiting for "Keep these settings?". */
/** Putting the old network settings back failed. The renderer shows the "Reset network" dialog for this answer. */
export const NET_RESTORE_FAILED = "Couldn't put the old network settings back. Hold Home and choose Reset network to automatic."

export interface NetTrial {
  profileId: string
  name: string
  phase: 'applying' | 'checking' | 'ready'
  secondsLeft: number
  address?: string
  router: NetCheck
  dns: NetCheck
  internet: NetCheck
  canKeep: boolean
}

export interface WifiAp {
  id: string
  ssid: string
  signal: number
  secure: boolean
  known: boolean
  active: boolean
}

export interface AudioSink {
  id: string
  name: string
  kind: 'hdmi' | 'analog' | 'bluetooth' | 'usb' | 'other'
  active: boolean
}

export interface DisplayMode {
  id: string
  width: number
  height: number
  refresh: number
}

export interface DisplayOutput {
  id: string
  name: string
  connected: boolean
  current?: DisplayMode
  modes: DisplayMode[]
  scale: number
}

export interface BtDevice {
  address: string
  name: string
  kind: 'remote' | 'gamepad' | 'keyboard' | 'mouse' | 'headphones' | 'speaker' | 'phone' | 'other'
  paired: boolean
  connected: boolean
  battery?: number
}

export interface CecStatus {
  adapter: boolean
  /** e.g. "Pulse-Eight USB-CEC". */
  adapterName?: string
  tvName?: string
  tvPower?: 'on' | 'standby' | 'unknown'
  physicalAddress?: string
}

export interface TimeInfo {
  iso: string
  timezone: string
  ntp: boolean
}

export type UpdateAction = 'check' | 'apply' | 'auto' | 'rollback'
export interface UpdateInfo {
  /** False on boxes built without an update server. */
  configured: boolean
  /** The installed MediaOS version. */
  current: string
  available?: string
  previous?: string
  /** Overnight updates leave this version alone after the owner goes back. */
  skipped?: string
  checkedAt?: string
  /** Plain text, at most 1500 characters. */
  notes?: string
  running?: UpdateAction
  lastRun?: { action: UpdateAction; ok: boolean; at: string; error?: string }
}

export interface SysInfo {
  deviceName: string
  version: string
  os: string
  kernel: string
  cpu: string
  memoryMb: number
  uptimeSec: number
  platform: 'linux' | 'mock'
  ip?: string
  storage: { totalGb: number; freeGb: number }
}

export interface Toast {
  id: string
  text: string
  tone?: 'info' | 'warn' | 'error' | 'ok'
}
