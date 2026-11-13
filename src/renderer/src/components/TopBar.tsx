// The bar across the top: logo and tabs on the left, the weather and clock on the right.
import { useEffect, useState, type ReactNode } from 'react'
import { Focusable, FocusGroup, cx } from './Focusable'
import { Icon } from './Icon'
import { LogoMark, Wordmark } from './Logo'
import { WeatherChip } from './Weather'
import type { WeatherNow } from '@shared/weather'
import { call } from '../lib/api'
import { useSettings } from '../state/settings'
import { TABS, goTab, type Tab } from '../state/nav'

const TAB_ICON: Record<Tab, string> = {
  home: 'home',
  libraries: 'libraries',
  apps: 'apps',
  search: 'search',
  settings: 'settings',
}

export function Clock(): ReactNode {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="clock" data-testid="clock">
      {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
    </div>
  )
}

/** How often the screen asks main for the weather; main only goes to the internet every 30 minutes. */
const WEATHER_POLL_MS = 10 * 60 * 1000

/** The weather beside the clock, or nothing when it is off, no town is chosen, or there is no recent reading. */
function TopWeather(): ReactNode {
  const { enabled, place, units } = useSettings().weather
  // Each reading remembers which town it was for, so a town change never shows the old town's weather.
  const [reading, setReading] = useState<{ where: string; now: WeatherNow | null }>()
  const where = enabled && place ? `${place.lat},${place.lon},${place.name}` : ''
  useEffect(() => {
    if (!where) return
    let live = true
    const load = (): void => {
      call('weather.get').then((now) => { if (live) setReading({ where, now }) }, () => { if (live) setReading({ where, now: null }) })
    }
    load()
    const t = setInterval(load, WEATHER_POLL_MS)
    return () => { live = false; clearInterval(t) }
  }, [where])
  const now = where && reading?.where === where ? reading.now : null
  return now ? <WeatherChip now={now} units={units} /> : null
}

export function TopBar({ active }: { active: Tab | undefined }): ReactNode {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" aria-label="MediaOS">
          <LogoMark size="2.6rem" />
          <Wordmark />
        </div>
        {/* Not remembering the last tab means moving up always lands on the tab you are on, not the one you last passed. */}
        <FocusGroup
          focusKey="topbar"
          className="tabs"
          role="tablist"
          remember={false}
          preferredChild={active ? `tab:${active}` : undefined}
        >
          {TABS.map((t) => (
            <Focusable
              key={t.id}
              focusKey={`tab:${t.id}`}
              role="tab"
              label={t.label}
              className={cx('tab', active === t.id && 'is-active')}
              onSelect={() => goTab(t.id)}
              testId={`tab-${t.id}`}
            >
              <Icon name={TAB_ICON[t.id]} size="1.35rem" />
              <span>{t.label}</span>
            </Focusable>
          ))}
        </FocusGroup>
      </div>
      <div className="topbar-right">
        <TopWeather />
        <Clock />
      </div>
    </header>
  )
}
