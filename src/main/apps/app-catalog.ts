// Streaming apps shown in the Apps tab. Quality labels are the honest Linux-Chrome limits from
// docs/design/research-streaming.md (Widevine L3). No logos are shipped: tiles use brand-neutral colours.
import type { AppEntry } from '@shared/apps'

/** TV user agent so youtube.com/tv serves its 10-foot layout. [B] Needs re-testing on the box. */
const YOUTUBE_TV_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36'

export const APP_CATALOG: readonly AppEntry[] = [
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/tv', iconPage: 'https://www.youtube.com/', nav: 'dpad',
    quality: 'Up to 4K', colour: '#3a0d0d', accent: '#ff4e45', ua: YOUTUBE_TV_UA },
  { id: 'netflix', vpn: { mayNotWork: true }, name: 'Netflix', url: 'https://www.netflix.com/browse', nav: 'pointer',
    quality: 'Up to 1080p', colour: '#1c0607', accent: '#e50914' },
  { id: 'iplayer', vpn: { mayNotWork: true }, name: 'BBC iPlayer', url: 'https://www.bbc.co.uk/iplayer', nav: 'pointer', quality: 'HD',
    colour: '#1a0b26', accent: '#f54997', note: 'TV Licence needed' },
  { id: 'itvx', vpn: { mayNotWork: true }, name: 'ITVX', url: 'https://www.itv.com/',
    // itv.com stalls requests that don't come from a full browser, but its icon file downloads normally.
    iconUrl: 'https://assets.fe.itv.com/images/brands/itvx/apple-touch-icon.png', nav: 'pointer', quality: 'About 720p',
    colour: '#0e1a2b', accent: '#8be2c0', note: 'Not officially supported on Linux' },
  { id: 'channel4', vpn: { mayNotWork: true }, name: 'Channel 4', url: 'https://www.channel4.com/', nav: 'pointer',
    quality: 'About 720p', colour: '#111827', accent: '#a3e635' },
  { id: 'my5', name: 'My5', url: 'https://www.channel5.com/', nav: 'pointer', quality: 'About 720p', colour: '#1b1030', accent: '#c084fc' },
  { id: 'disney', vpn: { mayNotWork: true }, name: 'Disney+', url: 'https://www.disneyplus.com/', nav: 'pointer', quality: '720p max',
    colour: '#071a3d', accent: '#38bdf8' },
  { id: 'prime', vpn: { mayNotWork: true }, name: 'Prime Video', url: 'https://www.primevideo.com/', nav: 'pointer',
    quality: 'SD only', colour: '#06202c', accent: '#22d3ee', note: 'Amazon limits Linux to SD' },
  { id: 'hbomax', name: 'HBO Max', url: 'https://play.hbomax.com/', nav: 'pointer', quality: 'About 720p', colour: '#120a2e',
    accent: '#818cf8' },
  { id: 'appletv', name: 'Apple TV', url: 'https://tv.apple.com/', nav: 'pointer', quality: 'About 720p', colour: '#161616',
    accent: '#e5e7eb', note: 'Apple TV+ only; no purchases' },
  { id: 'paramount', name: 'Paramount+', url: 'https://www.paramountplus.com/gb/', nav: 'pointer', quality: 'About 720p',
    colour: '#071633', accent: '#60a5fa' },
  { id: 'crunchyroll', name: 'Crunchyroll', url: 'https://www.crunchyroll.com/', nav: 'pointer', quality: 'Up to 1080p',
    colour: '#2a1405', accent: '#fb923c' },
  { id: 'twitch', name: 'Twitch', url: 'https://www.twitch.tv/', nav: 'pointer', quality: 'Up to 1080p', colour: '#1a0f2e',
    accent: '#a78bfa' },
  {
    id: 'now', name: 'NOW', url: 'https://www.nowtv.com/', nav: 'pointer', quality: 'Not available', colour: '#141414', accent: '#9ca3af',
    blocked: true, note: 'NOW blocks Linux. Use a Google TV / Fire TV stick on another HDMI input.',
  },
]

export function findApp(id: string): AppEntry | undefined {
  return APP_CATALOG.find((a) => a.id === id)
}
