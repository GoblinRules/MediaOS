// Weather beside the clock: a small animated picture, the temperature and a short description. Drawn for MediaOS
// as inline SVG; the movement is slow and stops entirely when the system asks for reduced motion (weather.css).
import type { CSSProperties, ReactNode } from 'react'
import { formatTemp, type TempUnits, type WeatherKind, type WeatherNow } from '@shared/weather'
import './weather.css'

const CLOUD = 'M15 34a7 7 0 0 1-.6-14A10 10 0 0 1 33.5 19a7.5 7.5 0 0 1 .5 15z'
const delay = (seconds: number): CSSProperties => ({ animationDelay: `${seconds}s` })

function Sun({ x, y, r }: { x: number; y: number; r: number }): ReactNode {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const inner = r + 2.5, outer = r + 5.5
    return <line key={i} x1={x + Math.cos(a) * inner} y1={y + Math.sin(a) * inner} x2={x + Math.cos(a) * outer}
      y2={y + Math.sin(a) * outer} />
  })
  return (
    <g className="wx-sun">
      <g className="wx-rays">{rays}</g>
      <circle cx={x} cy={y} r={r} />
    </g>
  )
}

function Moon({ dx = 0, dy = 0, scale = 1 }: { dx?: number; dy?: number; scale?: number }): ReactNode {
  return (
    <g className="wx-moon" transform={`translate(${dx} ${dy}) scale(${scale})`}>
      <path d="M28 9a14 14 0 1 0 12 21A11.5 11.5 0 0 1 28 9z" />
    </g>
  )
}

function Stars(): ReactNode {
  return (
    <g className="wx-stars">
      <circle className="wx-star" cx="9" cy="10" r="1.1" />
      <circle className="wx-star" cx="15" cy="5" r="0.8" style={delay(1.3)} />
      <circle className="wx-star" cx="6" cy="20" r="0.8" style={delay(2.6)} />
    </g>
  )
}

function Cloud({ dark = false, dx = 0, dy = 0 }: { dark?: boolean; dx?: number; dy?: number }): ReactNode {
  return (
    <g className="wx-cloud-drift">
      <path className={dark ? 'wx-cloud wx-cloud-dark' : 'wx-cloud'} d={CLOUD} transform={`translate(${dx} ${dy})`} />
    </g>
  )
}

function Drops({ small = false }: { small?: boolean }): ReactNode {
  const xs = small ? [18, 28] : [16, 23, 30]
  return (
    <g className={small ? 'wx-drops wx-drizzle' : 'wx-drops'}>
      {xs.map((x, i) => <line key={x} className="wx-drop" x1={x} y1={34} x2={x - 1.5} y2={small ? 37 : 39}
        style={delay(i * (small ? 0.7 : 0.45))} />)}
    </g>
  )
}

function Flakes(): ReactNode {
  return (
    <g className="wx-flakes">
      {[16, 24, 31].map((x, i) => <circle key={x} className="wx-flake" cx={x} cy={37} r={1.6} style={delay(i * 1.1)} />)}
    </g>
  )
}

function Fog(): ReactNode {
  return (
    <g className="wx-fog">
      <line className="wx-fog-line" x1="9" y1="38" x2="33" y2="38" />
      <line className="wx-fog-line" x1="15" y1="43" x2="39" y2="43" style={delay(2)} />
    </g>
  )
}

/** The animated picture for a kind of weather; night skies show the moon instead of the sun. */
export function WeatherIcon({ kind, isDay }: { kind: WeatherKind; isDay: boolean }): ReactNode {
  const sky = isDay ? <Sun x={kind === 'clear' ? 24 : 17} y={kind === 'clear' ? 24 : 16} r={kind === 'clear' ? 8 : 6} />
    : kind === 'clear' ? <><Stars /><Moon /></> : <Moon dx={-4} dy={-4} scale={0.75} />
  const parts: Record<WeatherKind, ReactNode> = {
    clear: sky,
    partly: <>{sky}<Cloud dx={4} dy={3} /></>,
    cloudy: <><Cloud dx={-5} dy={-5} /><Cloud dy={1} /></>,
    fog: <><Cloud dy={-4} /><Fog /></>,
    drizzle: <><Cloud dy={-4} /><Drops small /></>,
    rain: <><Cloud dark dy={-4} /><Drops /></>,
    snow: <><Cloud dy={-4} /><Flakes /></>,
    storm: <><Cloud dark dy={-4} /><path className="wx-bolt" d="M25 30l-5 8h4l-2 7 7-10h-4l2-5z" /></>,
  }
  return (
    <svg className={`wx-icon wx-${kind}`} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {parts[kind]}
    </svg>
  )
}

/** Weather chip for the top bar. It is not focusable, so it never changes how the remote moves around Home. */
export function WeatherChip({ now, units }: { now: WeatherNow; units: TempUnits }): ReactNode {
  const temp = formatTemp(now.tempC, units)
  return (
    <div className={now.stale ? 'weather weather-stale' : 'weather'} data-testid="weather" role="img"
      aria-label={`${now.place}: ${now.label}, ${temp}`}>
      <WeatherIcon kind={now.kind} isDay={now.isDay} />
      <span className="weather-temp">{temp}</span>
      <span className="weather-label">{now.label}</span>
    </div>
  )
}
