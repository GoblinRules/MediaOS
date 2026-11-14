// Settings: a list of pages on the left; moving onto one shows it on the right. Back from a page returns to the list.
import { useCallback, useState, type ReactNode } from 'react'
import { Focusable, FocusGroup, cx } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { currentFocus, focus } from '../../input/focus'
import { LAYER, useInputLayer } from '../../input/input'
import { useScreenFocus, type Entry, type SettingsPage } from '../../state/nav'
import { AppsPage, HomePage, LibrariesPage, PlaybackPage, SystemPage } from './contentPages'
import { DisplayPage, NetworkPage, RemotesPage, SoundPage } from './devicePages'
import { VpnPage } from './vpnPages'

type PageProps = { k: (n: string) => string; prefix: string }

const PAGES: { id: SettingsPage; label: string; icon: string; hint: string; View: (p: PageProps) => ReactNode }[] = [
  { id: 'network', label: 'Network', icon: 'wifi', hint: 'Wi-Fi and cable', View: NetworkPage },
  { id: 'vpn', label: 'VPN', icon: 'shield', hint: 'Choose which apps use a VPN', View: VpnPage },
  { id: 'display', label: 'Display', icon: 'display', hint: 'Picture size, text size, screensaver', View: DisplayPage },
  { id: 'sound', label: 'Sound', icon: 'sound', hint: 'Speakers and volume', View: SoundPage },
  { id: 'remotes', label: 'Remotes', icon: 'remote', hint: 'TV remote, Bluetooth, phone', View: RemotesPage },
  { id: 'libraries', label: 'Libraries', icon: 'server', hint: 'Servers, network folders and drives', View: LibrariesPage },
  { id: 'home', label: 'Home screen', icon: 'home', hint: 'Rows and layout', View: HomePage },
  { id: 'apps', label: 'Apps', icon: 'apps', hint: 'Streaming apps', View: AppsPage },
  { id: 'playback', label: 'Playback', icon: 'play', hint: 'Subtitles, languages, skipping', View: PlaybackPage },
  { id: 'system', label: 'System', icon: 'settings', hint: 'Name, time, updates, power', View: SystemPage },
]

const NAV = 'set:nav'

export function SettingsScreen({ entry, page }: { entry: Entry; page?: SettingsPage }): ReactNode {
  const [current, setCurrent] = useState<SettingsPage>(page ?? 'network')
  // Opened on a page: that page while it is the one showing; otherwise the page list's entry for the page shown.
  const fallback = useCallback(() => (page && page === current ? `set:${page}` : `${NAV}:${current}`), [page, current])
  useScreenFocus(entry, true, fallback)

  // Back inside a page goes to the page list; Back on the list is handled by the app (goes to the top bar).
  useInputLayer(LAYER.screen, (action) => {
    if (action !== 'back') return false
    const f = currentFocus() ?? ''
    if (!f.startsWith('set:') || f.startsWith(`${NAV}:`)) return false
    return focus(`${NAV}:${current}`)
  })

  const info = PAGES.find((p) => p.id === current) ?? PAGES[0]
  if (!info) return null
  const prefix = `set:${info.id}`
  const k = (n: string): string => `${prefix}:${n}`

  return (
    <div className="settings" data-testid="settings">
      <FocusGroup focusKey={NAV} className="set-nav" scroll="y" testId="settings-nav">
        <h1 className="page-title">Settings</h1>
        {PAGES.map((p) => (
          <Focusable
            key={p.id}
            focusKey={`${NAV}:${p.id}`}
            label={p.label}
            className={cx('set-nav-item', p.id === current && 'is-current')}
            testId={`settings-nav-${p.id}`}
            onFocused={() => setCurrent(p.id)}
            onSelect={() => focus(`set:${p.id}`)}
          >
            <Icon name={p.icon} size="1.6rem" />
            <span className="set-nav-text">
              <span className="set-nav-label">{p.label}</span>
              <span className="set-nav-hint">{p.hint}</span>
            </span>
          </Focusable>
        ))}
      </FocusGroup>
      <FocusGroup key={info.id} focusKey={prefix} className="set-page" scroll="y" testId={`settings-page-${info.id}`}>
        <h2 className="set-page-title">{info.label}</h2>
        <info.View k={k} prefix={prefix} />
      </FocusGroup>
    </div>
  )
}
