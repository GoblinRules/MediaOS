import type { AppRoute } from '../shared/vpn-types'
import { VPN_SCENARIOS, type VpnScenario } from './vpn/mock/MockVpnBackend'
// Reads how MediaOS was started (environment and command line). Plain function so tests can run it without Electron.

export interface LaunchOptions {
  platform: 'linux' | 'mock'
  realSystem: string[]
  /** Overrides Electron's userData folder (tests use a throwaway folder). */
  dataDir?: string
  /** A fixed window size instead of fullscreen, e.g. for 1280x720 screenshots. */
  window?: { width: number; height: number }
  forceMockPlayer: boolean
  mpvPath?: string
  /** Open DevTools in a separate window (development only). */
  devTools: boolean
  /**
   * Automated tests: open windows off the visible screen and never take focus, so a test run does not cover what
   * the person at the PC is working on.
   */
  background: boolean
  /** Site icon downloads are disabled for automated runs or MEDIAOS_APP_ICONS=off. */
  appIcons: 'fetch' | 'off'
  /** Linux: Chrome's path (MEDIAOS_CHROME), for testing another build. */
  chromePath?: string
  /** Linux: the control socket for sway's Home key, in the user's private runtime folder. */
  controlSocket?: string
  /** Linux: no hardware video decoding (MEDIAOS_SOFTWARE_VIDEO=1, set by the session inside a virtual machine). */
  softwareVideo: boolean
  /** Tests only: shorten the network trial countdown (3..45 seconds). */
  netTrialSec?: number
  vpnImport?: string
  vpnScenario?: VpnScenario
}

const SIZE = /^(\d{3,4})x(\d{3,4})$/

export function readLaunchOptions(env: Record<string, string | undefined>, argv: readonly string[]): LaunchOptions {
  const flag = (name: string): boolean => argv.includes(`--${name}`)
  const size = SIZE.exec(env.MEDIAOS_WINDOW ?? '')
  const width = size ? Number(size[1]) : 0
  const height = size ? Number(size[2]) : 0
  const seconds = /^\d+$/.test(env.MEDIAOS_NET_TRIAL_SEC ?? '') ? Number(env.MEDIAOS_NET_TRIAL_SEC) : NaN
  return {
    vpnImport: env.MEDIAOS_VPN_IMPORT?.trim() || undefined,
    vpnScenario: VPN_SCENARIOS.find((s) => s === env.MEDIAOS_VPN_SCENARIO),
    platform: env.MEDIAOS_PLATFORM === 'linux' ? 'linux' : 'mock',
    realSystem: (env.MEDIAOS_REAL_SYSTEM ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    dataDir: env.MEDIAOS_DATA_DIR?.trim() || undefined,
    window: width >= 640 && height >= 360 ? { width, height } : undefined,
    forceMockPlayer: env.MEDIAOS_MOCK_PLAYER === '1' || flag('mock-player'),
    mpvPath: env.MEDIAOS_MPV?.trim() || undefined,
    devTools: env.MEDIAOS_DEVTOOLS === '1',
    background: env.MEDIAOS_BACKGROUND === '1',
    appIcons: env.MEDIAOS_BACKGROUND === '1' || env.MEDIAOS_APP_ICONS === 'off' || env.MEDIAOS_E2E_VISIBLE === '1' ? 'off' : 'fetch',
    chromePath: env.MEDIAOS_CHROME?.trim() || undefined,
    controlSocket: env.MEDIAOS_CONTROL_SOCKET?.trim() ||
      (env.XDG_RUNTIME_DIR?.startsWith('/') ? `${env.XDG_RUNTIME_DIR.replace(/\/+$/, '')}/mediaos/ctl.sock` : undefined),
    softwareVideo: env.MEDIAOS_SOFTWARE_VIDEO === '1',
    netTrialSec: Number.isInteger(seconds) && seconds >= 3 && seconds <= 45 ? seconds : undefined,
  }
}

/** The mock "streaming app" window shows a local page instead of the real site, so nothing is fetched from the internet. */
export function mockAppPage(name: string, colour: string, route: AppRoute = { kind: 'direct' }): string {
  const safeName = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const network = (route.kind === 'vpn' ? `VPN (${route.label})` : 'direct')
    .replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const safeColour = /^#[0-9a-fA-F]{3,8}$/.test(colour) ? colour : '#222'
  const html =
    '<!doctype html><meta charset="utf-8"><title>' + safeName + '</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    `<body style="margin:0;height:100vh;display:grid;place-items:center;background:${safeColour};color:#fff;` +
    'font:600 4vw system-ui,sans-serif;text-align:center">' +
    `<div>${safeName}<div style="font-size:1.4vw;font-weight:400;opacity:.8;margin-top:2vw">` +
    'Test app window. Press Escape, Backspace or F1 to go back to MediaOS.</div>' +
    `<div data-testid="app-network" style="font-size:1.4vw">Network: ${network}</div></div>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
