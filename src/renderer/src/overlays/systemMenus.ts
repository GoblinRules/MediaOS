// Power, Recovery and the general Menu (when the focused thing has no options of its own).
import { call, errorText, run } from '../lib/api'
import { invalidateData } from '../lib/useCall'
import { confirm, goTab, menu, openOverlay } from '../state/nav'
import { getSettings } from '../state/settings'
import { setupStep } from '../state/setup'
import { toast } from '../state/toasts'
import { resetNetwork } from '../state/netTrial'
import { turnScreenOff } from '../state/screen'

export function openPowerMenu(): void {
  openOverlay({
    kind: 'menu',
    title: 'Power',
    side: true,
    items: [
      { id: 'screen-off', label: 'Turn off the screen', detail: 'Any button wakes it', icon: 'moon', onSelect: screenOffAndTv },
      { id: 'restart-shell', label: 'Restart MediaOS', detail: 'Quick: about 10 seconds', icon: 'refresh', onSelect: () => void run('shell.restart') },
      {
        id: 'reboot',
        label: 'Restart the box',
        icon: 'restart',
        onSelect: () =>
          confirm({ title: 'Restart the box?', body: 'Anything playing will stop.', confirmLabel: 'Restart', onConfirm: () => void run('power.reboot') }),
      },
      {
        id: 'off',
        label: 'Turn off',
        icon: 'power',
        onSelect: () =>
          confirm({
            title: 'Turn off MediaOS?',
            body: 'To turn it back on, press the power button on the box.',
            confirmLabel: 'Turn off',
            onConfirm: () => void run('power.powerOff'),
          }),
      },
    ],
  })
}

/**
 * The Power menu's screen off also puts the TV on standby through the TV remote adapter, when the owner lets
 * MediaOS turn the TV off. Quietly: without an adapter there is nothing to say. Pressing a button wakes both again.
 * (The screen-off timer doesn't do this: the owner may be watching something else on the TV.)
 */
function screenOffAndTv(): void {
  void turnScreenOff().then(() => {
    if (getSettings()?.cec.standbyTvOnPowerOff) void call('cec.standbyTv').catch(() => undefined)
  })
}

export function factoryReset(): void {
  confirm({
    title: 'Erase everything?',
    body: 'This removes your servers, sign-ins, streaming app logins and settings. MediaOS restarts as new.',
    confirmLabel: 'Continue',
    danger: true,
    onConfirm: () =>
      confirm({
        title: 'Are you sure?',
        body: 'This cannot be undone.',
        confirmLabel: 'Erase and restart',
        danger: true,
        onConfirm: () => void run('shell.factoryReset', 'ERASE'),
      }),
  })
}

export async function saveDiagnostics(): Promise<void> {
  try {
    const r = await call('info.diagnostics')
    toast(`Saved a problem report: ${r.path}`, 'ok')
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

/** During first-run setup only the setup screen shows, so go to its own network step instead of Settings. */
function openNetwork(): void {
  if (getSettings()?.setupDone === false) setupStep.set('network')
  else goTab('settings', 'network')
}

export function openRecoveryMenu(): void {
  openOverlay({
    kind: 'menu',
    title: 'Recovery',
    subtitle: 'Use these if something is stuck.',
    side: false,
    items: [
      { id: 'rec-restart-shell', label: 'Restart MediaOS', icon: 'refresh', onSelect: () => void run('shell.restart') },
      { id: 'rec-reboot', label: 'Restart the box', icon: 'restart', onSelect: () => void run('power.reboot') },
      { id: 'rec-network', label: 'Network settings', icon: 'wifi', onSelect: openNetwork },
      {
        id: 'rec-net-reset',
        label: 'Reset network to automatic',
        detail: 'If the box went offline after a network change',
        icon: 'warning',
        onSelect: confirmNetworkReset,
      },
      {
        id: 'rec-vpn-off',
        label: 'Turn off the VPN for all apps',
        detail: "If an app won't open because of the VPN",
        icon: 'shield',
        onSelect: () =>
          void run('vpn.setAllApps', 'direct').then((ok) => {
            if (ok) toast('All apps now connect directly.', 'ok')
          }),
      },
      { id: 'rec-diag', label: 'Save a problem report', icon: 'download', onSelect: () => void saveDiagnostics() },
      { id: 'rec-reset', label: 'Erase everything', icon: 'trash', danger: true, onSelect: factoryReset },
    ],
  })
}

/** Every connection back to Automatic, with automatic DNS (Recovery; also the way out of a failed trial). */
export function confirmNetworkReset(): void {
  confirm({
    title: 'Reset the network to automatic?',
    body: 'The cable and every saved Wi-Fi network go back to Automatic, with automatic DNS. Saved Wi-Fi passwords are kept.',
    confirmLabel: 'Reset network',
    startOnCancel: true,
    onConfirm: () => void resetNetwork(),
  })
}

export function openGeneralMenu(): void {
  menu('Options', [
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      onSelect: () => {
        void call('home.refresh').then(invalidateData, (err: unknown) => toast(errorText(err), 'error'))
      },
    },
    { id: 'settings', label: 'Settings', icon: 'settings', onSelect: () => goTab('settings') },
    { id: 'power', label: 'Power', icon: 'power', onSelect: openPowerMenu },
  ])
}
