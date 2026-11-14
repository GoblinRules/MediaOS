// Streaming app catalogue shapes. Apps run in Google Chrome on the box (one profile per app).

export type AppNav = 'dpad' | 'pointer'

export interface AppEntry {
  id: string
  name: string
  url: string
  /** Optional direct site icon URL, used instead of discovering icons on the app's website. */
  iconUrl?: string
  /** Optional page to look for icons on, when the app's own page offers only a poor one. */
  iconPage?: string
  /** 'dpad' = works with arrow keys; 'pointer' = needs the remote's pointer mode. */
  nav: AppNav
  /** Honest playback quality on Linux Chrome, e.g. "Up to 1080p", "720p", "SD". */
  quality: string
  /** Shown on the tile when the app is limited or blocked on Linux. */
  note?: string
  /** Not available on Linux at all (kept so the user sees why). */
  blocked?: boolean
  /** Tile background and fallback colour; site icons are fetched and cached, never shipped. */
  colour: string
  accent?: string
  vpn?: { lock?: 'direct'; mayNotWork?: boolean }
  ua?: string
}

export interface AppState {
  running?: { appId: string; since: string }
}

export function appIconUrl(appId: string): string {
  return `mediaos-img://app/${encodeURIComponent(appId)}`
}
