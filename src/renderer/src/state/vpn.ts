// The per-app VPN as the screen sees it (docs/design/vpn.md section 7). Main owns everything; this keeps the latest
// status it sent, and holds the dialogs that open from an app (blocked at launch, closed by a drop).
import type { AppEntry } from '@shared/apps'
import type { AppVpnChoice, VpnStatus } from '@shared/vpn-types'
import { createStore, useStore } from '../lib/store'
import { call, onEvent, run } from '../lib/api'
import { closeAllOverlays, goTab, openOverlay } from './nav'
import { dismissToast, toastStore } from './toasts'

export const vpnStore = createStore<VpnStatus | null>(null)

export function useVpn(): VpnStatus | null {
  return useStore(vpnStore)
}

let events = 0

/** Pull the status and follow its changes. Returns the unsubscribe. */
export function watchVpn(): () => void {
  const pulledAt = events
  const off = onEvent('vpn', ({ status }) => {
    events += 1
    vpnStore.set(status)
  })
  call('vpn.status').then(
    (status) => {
      // An event that came in meanwhile is newer than this answer.
      if (events === pulledAt) vpnStore.set(status)
    },
    () => undefined,
  )
  return off
}

/** How an app connects now. Locked apps (Jellyfin, Plex) are always direct. */
export function appChoice(app: AppEntry, status: VpnStatus | null = vpnStore.get()): AppVpnChoice {
  if (app.vpn?.lock === 'direct') return 'direct'
  return status?.apps[app.id] ?? 'direct'
}

/** Whether the app menu offers "Use the VPN" (only once a location exists, vpn.md 7.5). */
export function vpnOffered(app: AppEntry, status: VpnStatus | null = vpnStore.get()): boolean {
  return Boolean(status && status.locations.length > 0 && !app.blocked && app.vpn?.lock !== 'direct')
}

/** The tile's shield: the app is set to use the VPN. */
export function usesVpn(app: AppEntry, status: VpnStatus | null): boolean {
  return vpnOffered(app, status) && appChoice(app, status) !== 'direct'
}

export async function setAppVpn(app: AppEntry, choice: AppVpnChoice): Promise<boolean> {
  return run('vpn.setAppVpn', app.id, choice)
}

const DISCONNECTED = 'The VPN has disconnected.'

/** "The app was closed" says it better than the general disconnect message, so that one goes. */
function dropDisconnectToast(): void {
  for (const t of toastStore.get()) if (t.text.startsWith(DISCONNECTED)) dismissToast(t.id)
}

/** vpn.md 7.6: an app set to "don't open" was stopped because the VPN isn't working. */
export function openVpnBlocked(app: AppEntry, retry: () => void): void {
  openOverlay({
    kind: 'menu',
    title: `${app.name} can't open right now`,
    subtitle:
      'This app is set to use the VPN, and the VPN isn\'t working. It won\'t open without it, so your normal connection is ' +
      'never used by mistake.',
    side: false,
    items: [
      { id: 'vpn-retry', label: 'Try again', icon: 'refresh', onSelect: retry },
      { id: 'vpn-settings', label: 'VPN settings', icon: 'shield', onSelect: () => goTab('settings', 'vpn') },
      {
        id: 'vpn-direct',
        label: `Stop using the VPN for ${app.name}`,
        detail: 'It opens with your normal connection',
        icon: 'globe',
        onSelect: () => {
          void setAppVpn(app, 'direct').then((ok) => {
            if (ok) retry()
          })
        },
      },
      { id: 'vpn-back', label: 'Back', icon: 'back', onSelect: () => undefined },
    ],
  })
}

/** vpn.md review M9: the tunnel dropped while an app used it, so main closed the app. */
export function openVpnDropped(app: AppEntry | undefined, retry: (() => void) | undefined): void {
  dropDisconnectToast()
  closeAllOverlays()
  const name = app?.name ?? 'the app'
  const items = [
    { id: 'vpn-settings', label: 'VPN settings', icon: 'shield', onSelect: () => goTab('settings', 'vpn') },
    { id: 'vpn-back', label: 'Back', icon: 'back', onSelect: () => undefined },
  ]
  if (retry) items.unshift({ id: 'vpn-retry', label: 'Try again', icon: 'refresh', onSelect: retry })
  openOverlay({
    kind: 'menu',
    title: 'The VPN disconnected',
    subtitle: `The VPN connection dropped, so ${name} was closed to keep your location private.`,
    side: false,
    items,
  })
}
