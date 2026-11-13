// Weather shown on Home: shared types plus the plain-English reading of Open-Meteo's weather codes (WMO 4677).
// Pure code, used by main (to build WeatherNow) and by the screen (to pick the animated picture).

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'
export type TempUnits = 'c' | 'f'

/** A town the user picked once in Settings. Coordinates come from the place search, never from the network address. */
export interface WeatherPlace {
  name: string
  /** County, state or region, to tell apart towns with the same name. */
  region?: string
  country?: string
  lat: number
  lon: number
}

export interface WeatherNow {
  place: string
  /** Temperatures are always in °C; the screen converts for °F so the units switch is instant. */
  tempC: number
  highC?: number
  lowC?: number
  code: number
  kind: WeatherKind
  label: string
  isDay: boolean
  /** When Open-Meteo last answered (ISO time). */
  updatedAt: string
  /** True when the last refresh failed and this is an older reading. */
  stale: boolean
}

export interface WeatherReading {
  kind: WeatherKind
  label: string
}

const CODES: Record<number, WeatherReading> = {
  0: { kind: 'clear', label: 'Clear' },
  1: { kind: 'partly', label: 'Mostly clear' },
  2: { kind: 'partly', label: 'Partly cloudy' },
  3: { kind: 'cloudy', label: 'Cloudy' },
  45: { kind: 'fog', label: 'Fog' },
  48: { kind: 'fog', label: 'Freezing fog' },
  51: { kind: 'drizzle', label: 'Light drizzle' },
  53: { kind: 'drizzle', label: 'Drizzle' },
  55: { kind: 'drizzle', label: 'Heavy drizzle' },
  56: { kind: 'drizzle', label: 'Freezing drizzle' },
  57: { kind: 'drizzle', label: 'Freezing drizzle' },
  61: { kind: 'rain', label: 'Light rain' },
  63: { kind: 'rain', label: 'Rain' },
  65: { kind: 'rain', label: 'Heavy rain' },
  66: { kind: 'rain', label: 'Freezing rain' },
  67: { kind: 'rain', label: 'Freezing rain' },
  71: { kind: 'snow', label: 'Light snow' },
  73: { kind: 'snow', label: 'Snow' },
  75: { kind: 'snow', label: 'Heavy snow' },
  77: { kind: 'snow', label: 'Snow grains' },
  80: { kind: 'rain', label: 'Showers' },
  81: { kind: 'rain', label: 'Showers' },
  82: { kind: 'rain', label: 'Heavy showers' },
  85: { kind: 'snow', label: 'Snow showers' },
  86: { kind: 'snow', label: 'Heavy snow showers' },
  95: { kind: 'storm', label: 'Thunderstorm' },
  96: { kind: 'storm', label: 'Thunderstorm with hail' },
  99: { kind: 'storm', label: 'Thunderstorm with hail' },
}

/** Plain-English reading of a WMO weather code. "Clear" reads "Sunny" in the daytime. Unknown codes read as cloudy. */
export function describeWeather(code: number, isDay = true): WeatherReading {
  const reading = CODES[code] ?? { kind: 'cloudy', label: 'Cloudy' }
  return code === 0 && isDay ? { kind: 'clear', label: 'Sunny' } : reading
}

/** Rounded temperature with a degree sign, e.g. "12°" (the unit is set once in Settings, so it isn't repeated). */
export function formatTemp(celsius: number, units: TempUnits): string {
  const value = units === 'f' ? celsius * 9 / 5 + 32 : celsius
  const rounded = Math.round(value)
  // Avoid "-0°" for readings just below zero.
  return `${rounded === 0 ? 0 : rounded}°`
}

/** "London, England, United Kingdom" style label for the place search list. */
export function placeLabel(place: WeatherPlace): string {
  return [place.name, place.region, place.country].filter((part, i, all) => part && all.indexOf(part) === i).join(', ')
}

/** The line under a town in the search list: its region and country, without repeating the town's own name. */
export function placeDetail(place: WeatherPlace): string | undefined {
  const rest = [place.region, place.country].filter((part, i, all) => part && part !== place.name && all.indexOf(part) === i)
  return rest.length ? rest.join(', ') : undefined
}
