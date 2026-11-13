// Shapes for the per-app VPN (docs/design/vpn.md). Shared by main and the renderer.
// Nothing here carries a key, a NetworkManager UUID or the tunnel address: those never leave the main process.

/** What the tunnel is doing. Only a passing DNS check through the tunnel counts as 'connected'. */
export type VpnState =
  /** No location saved yet. */
  | 'not-set-up'
  /** A location exists but "Use the VPN" is off. */
  | 'off'
  | 'connecting'
  | 'connected'
  /** The tunnel is up but two checks in a row failed. */
  | 'not-working'
  /** The tunnel device or its address is missing. */
  | 'down'

/** How one app connects. Apps with no entry are 'direct'. */
export type AppVpnChoice = 'direct' | 'vpn-only' | 'vpn-or-direct'
export const APP_VPN_CHOICES = ['direct', 'vpn-only', 'vpn-or-direct'] as const satisfies readonly AppVpnChoice[]

export const MAX_VPN_LOCATIONS = 5
export const VPN_LABEL_MAX = 24
/** Location ids are made by main: 'loc-' and 8 hex digits. */
export const VPN_LOCATION_ID = /^loc-[a-f0-9]{8}$/

export interface VpnLocationInfo {
  id: string
  /** The name the user gave it, e.g. "UK". */
  label: string
  /** ISO time it was added. */
  addedAt: string
}

/** Why an import failed; each maps to one plain-English message in the renderer (vpn.md 7.3). */
export type VpnImportError =
  | 'not-wireguard'
  | 'several-peers'
  | 'not-full-tunnel'
  | 'no-private-key'
  | 'too-large'
  | 'expired'
  | 'too-many-locations'
  | 'save-failed'

export interface VpnImportEntry {
  /** Opaque id made by main for this import only. */
  id: string
  /** Server name from the file name, e.g. "uk-lon-wg-001". */
  name: string
}

/** One step of "Add a VPN location". Main owns the flow; the renderer only draws the current step. */
export type VpnImportStage =
  /** Waiting for a file. url and code are null on the dev path (MEDIAOS_VPN_IMPORT), which needs no phone. */
  | { stage: 'waiting'; url: string | null; code: string | null; expiresAt: string | null }
  | { stage: 'checking' }
  /** The upload held several servers; country is a short code such as "GB", or "" when unknown. */
  | { stage: 'choose'; groups: { country: string; entries: VpnImportEntry[] }[] }
  /** removed lists setting names the sanitiser dropped (e.g. "PostUp", "Table"), shown as a notice. */
  | { stage: 'name'; suggested: string; removed: string[] }
  | { stage: 'saving' }
  | { stage: 'done'; label: string }
  | { stage: 'error'; error: VpnImportError }

export interface VpnStatus {
  state: VpnState
  enabled: boolean
  activeLocationId: string | null
  locations: VpnLocationInfo[]
  /** Only apps whose choice isn't 'direct'. */
  apps: Record<string, AppVpnChoice>
  /** The "Check the VPN" row. */
  check: 'idle' | 'checking' | 'ok' | 'failed'
  /** Still connecting after 15 s with no answer from the provider (vpn.md review L6: the file may have expired). */
  slow: boolean
  /** An app window open right now that uses the VPN (for "BBC iPlayer will close"), or null. */
  appOnVpn: string | null
  /** The add-a-location flow, or null when none is running. */
  import: VpnImportStage | null
}

/** How a Chrome app is launched. Main-process only in practice, but kept here beside the other VPN shapes. */
export type AppRoute = { kind: 'direct' } | { kind: 'vpn'; port: number; label: string }

/** apps.launch's reply. vpnBlocked asks the renderer for the "can't open right now" dialog (vpn.md 7.6). */
export type AppLaunchResult = { ok: true } | { ok: false; error: string; vpnBlocked?: true }
