// Weather for the Home screen from Open-Meteo (free, no account or key). The user types their town once; the
// coordinates come from Open-Meteo's place search, never from the network address. Requests carry no identifying
// headers, and coordinates are rounded to about a kilometre before they leave the box.
import { z } from 'zod'
import { describeWeather, type WeatherNow, type WeatherPlace } from '@shared/weather'
import { silentLog, type Log } from '../log/Logger'
import { SourceError } from '../sources/MediaSource'

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
/** A reading is refreshed after this long. */
export const REFRESH_MS = 30 * 60 * 1000
/** After a failed refresh, wait this long before asking again (the screen asks every few minutes). */
export const RETRY_MS = 5 * 60 * 1000
/** Older readings are hidden rather than shown as current weather. */
export const MAX_AGE_MS = 3 * 60 * 60 * 1000
const TIMEOUT_MS = 15_000
const BODY_CAP = 256 * 1024

export const SEARCH_OFFLINE = "Can't reach the weather service. Check this TV is online."
export const SEARCH_FAILED = "The weather service didn't answer properly. Try again in a few minutes."

const Forecast = z.object({
  current: z.object({
    time: z.string().optional(),
    temperature_2m: z.number(),
    weather_code: z.number().int(),
    is_day: z.number().optional(),
  }),
  daily: z.object({
    temperature_2m_max: z.array(z.number().nullable()).optional(),
    temperature_2m_min: z.array(z.number().nullable()).optional(),
  }).optional(),
})

const Geocode = z.object({
  results: z.array(z.object({
    name: z.string(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    country: z.string().optional(),
    admin1: z.string().optional(),
  }).loose()).optional(),
})

export interface WeatherServiceOptions {
  fetch?: typeof fetch
  now?: () => number
  logger?: Log
}

interface Entry { key: string; value?: WeatherNow; fetchedAt?: number; failedAt?: number }

export class WeatherService {
  private fetch: typeof fetch
  private now: () => number
  private logger: Log
  private entry?: Entry
  private pending?: { key: string; job: Promise<void> }
  private stop = new AbortController()

  constructor(opts: WeatherServiceOptions = {}) {
    this.fetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.logger = opts.logger ?? silentLog
  }

  /** Towns matching what the user typed, best match first. Throws a plain-English SourceError when the service can't be used. */
  async search(text: string): Promise<WeatherPlace[]> {
    const name = text.trim()
    if (name.length < 2) return []
    const url = new URL(GEOCODE_URL)
    url.searchParams.set('name', name.slice(0, 100))
    url.searchParams.set('count', '8')
    url.searchParams.set('language', 'en')
    url.searchParams.set('format', 'json')
    const parsed = Geocode.safeParse(await this.get(url, SEARCH_OFFLINE))
    if (!parsed.success) throw new SourceError(SEARCH_FAILED, 'server')
    // Settings keep at most 120 characters per field, so a longer name from the service must not make the save fail.
    const clip = (value?: string) => value?.trim().slice(0, 120) || undefined
    return (parsed.data.results ?? []).filter((r) => clip(r.name)).map((r) => ({
      name: clip(r.name)!,
      ...(clip(r.admin1) && r.admin1 !== r.name ? { region: clip(r.admin1) } : {}),
      ...(clip(r.country) ? { country: clip(r.country) } : {}),
      lat: round(r.latitude), lon: round(r.longitude),
    }))
  }

  /**
   * Weather for a place, refreshed every 30 minutes. Never throws: when the service can't be reached the last reading
   * is returned marked stale, and after 3 hours (or with no reading at all) the answer is null so the screen hides it.
   */
  async current(place: WeatherPlace | undefined): Promise<WeatherNow | null> {
    if (!place || this.stop.signal.aborted) return null
    const key = `${round(place.lat)},${round(place.lon)}|${place.name}`
    if (this.entry?.key !== key) this.entry = { key }
    const entry = this.entry
    const now = this.now()
    const fresh = entry.fetchedAt !== undefined && now - entry.fetchedAt < REFRESH_MS
    const waiting = entry.failedAt !== undefined && now - entry.failedAt < RETRY_MS
    if (!fresh && !waiting) await this.refresh(place, entry)
    return this.view(entry)
  }

  dispose(): void { this.stop.abort() }

  private view(entry: Entry): WeatherNow | null {
    if (!entry.value || entry.fetchedAt === undefined) return null
    const age = this.now() - entry.fetchedAt
    if (age >= MAX_AGE_MS) return null
    return { ...entry.value, stale: age >= REFRESH_MS }
  }

  private refresh(place: WeatherPlace, entry: Entry): Promise<void> {
    if (this.pending?.key === entry.key) return this.pending.job
    const job = this.load(place, entry).finally(() => { if (this.pending?.job === job) this.pending = undefined })
    this.pending = { key: entry.key, job }
    return job
  }

  private async load(place: WeatherPlace, entry: Entry): Promise<void> {
    const url = new URL(FORECAST_URL)
    url.searchParams.set('latitude', String(round(place.lat)))
    url.searchParams.set('longitude', String(round(place.lon)))
    url.searchParams.set('current', 'temperature_2m,weather_code,is_day')
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min')
    url.searchParams.set('forecast_days', '1')
    url.searchParams.set('timezone', 'auto')
    try {
      const parsed = Forecast.safeParse(await this.get(url, SEARCH_OFFLINE))
      if (!parsed.success) throw new Error('Unexpected weather reply')
      const { current, daily } = parsed.data
      const isDay = current.is_day !== 0
      const reading = describeWeather(current.weather_code, isDay)
      const high = daily?.temperature_2m_max?.[0]
      const low = daily?.temperature_2m_min?.[0]
      entry.value = {
        place: place.name, tempC: current.temperature_2m, code: current.weather_code, kind: reading.kind,
        label: reading.label, isDay, updatedAt: new Date(this.now()).toISOString(), stale: false,
        ...(typeof high === 'number' ? { highC: high } : {}), ...(typeof low === 'number' ? { lowC: low } : {}),
      }
      entry.fetchedAt = this.now()
      entry.failedAt = undefined
    } catch (error) {
      entry.failedAt = this.now()
      if (!this.stop.signal.aborted) this.logger.warn('Weather could not be updated', error instanceof Error ? error.message : error)
    }
  }

  private async get(url: URL, offline: string): Promise<unknown> {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.stop.signal])
    let response: Response
    try {
      response = await this.fetch(url, { signal, headers: { Accept: 'application/json' }, redirect: 'error' })
    } catch {
      throw new SourceError(offline, 'offline')
    }
    if (!response.ok || Number(response.headers.get('content-length')) > BODY_CAP) throw new SourceError(SEARCH_FAILED, 'server')
    const text = await response.text()
    if (text.length > BODY_CAP) throw new SourceError(SEARCH_FAILED, 'server')
    try { return JSON.parse(text) as unknown } catch { throw new SourceError(SEARCH_FAILED, 'server') }
  }
}

/** Two decimal places is about a kilometre: plenty for weather, and no more precise than it needs to be. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
