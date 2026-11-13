import { describe, expect, it } from 'vitest'
import { describeWeather, formatTemp, placeDetail, placeLabel } from '@shared/weather'
import {
  MAX_AGE_MS, REFRESH_MS, RETRY_MS, SEARCH_FAILED, SEARCH_OFFLINE, WeatherService,
} from '../../src/main/weather/WeatherService'

const london = { name: 'London', region: 'England', country: 'United Kingdom', lat: 51.50853, lon: -0.12574 }

function forecast(temp = 11.6, code = 61, isDay = 1): unknown {
  return {
    current: { time: '2026-11-13T10:00', temperature_2m: temp, weather_code: code, is_day: isDay },
    daily: { temperature_2m_max: [13.2], temperature_2m_min: [6.1] },
  }
}

function harness(reply: (url: URL) => unknown) {
  let clock = 1_000_000
  const urls: URL[] = []
  const inits: RequestInit[] = []
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input)); urls.push(url); inits.push(init ?? {})
    const body = reply(url)
    if (body instanceof Error) throw body
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  const service = new WeatherService({ fetch: fake, now: () => clock })
  return { service, urls, inits, advance: (ms: number) => { clock += ms } }
}

describe('weather codes', () => {
  it('reads codes in plain English, with Sunny only in the daytime', () => {
    expect(describeWeather(0, true)).toEqual({ kind: 'clear', label: 'Sunny' })
    expect(describeWeather(0, false)).toEqual({ kind: 'clear', label: 'Clear' })
    expect(describeWeather(63)).toEqual({ kind: 'rain', label: 'Rain' })
    expect(describeWeather(75).kind).toBe('snow')
    expect(describeWeather(99).kind).toBe('storm')
    expect(describeWeather(45).kind).toBe('fog')
    expect(describeWeather(1234)).toEqual({ kind: 'cloudy', label: 'Cloudy' })
  })
  it('formats temperatures in either unit without a minus zero', () => {
    expect(formatTemp(11.6, 'c')).toBe('12°')
    expect(formatTemp(11.6, 'f')).toBe('53°')
    expect(formatTemp(-0.3, 'c')).toBe('0°')
    expect(formatTemp(-12.5, 'c')).toBe('-12°')
  })
  it('labels places without repeating parts', () => {
    expect(placeLabel(london)).toBe('London, England, United Kingdom')
    expect(placeLabel({ name: 'Singapore', country: 'Singapore', lat: 1, lon: 1 })).toBe('Singapore')
    expect(placeDetail(london)).toBe('England, United Kingdom')
    expect(placeDetail({ name: 'Singapore', country: 'Singapore', lat: 1, lon: 1 })).toBeUndefined()
    expect(placeDetail({ name: 'Monaco', region: 'Monaco', country: 'Monaco', lat: 1, lon: 1 })).toBeUndefined()
  })
})

describe('WeatherService', () => {
  it('asks Open-Meteo with rounded coordinates and builds a reading', async () => {
    const h = harness(() => forecast())
    const now = await h.service.current(london)
    expect(now).toMatchObject({ place: 'London', tempC: 11.6, highC: 13.2, lowC: 6.1, kind: 'rain', label: 'Light rain',
      isDay: true, stale: false })
    const url = h.urls[0]!
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(url.searchParams.get('latitude')).toBe('51.51')
    expect(url.searchParams.get('longitude')).toBe('-0.13')
    expect(url.searchParams.get('current')).toBe('temperature_2m,weather_code,is_day')
    expect(h.inits[0]!.redirect).toBe('error')
  })
  it('keeps a reading for 30 minutes, then refreshes it', async () => {
    let temp = 10
    const h = harness(() => forecast(temp))
    await h.service.current(london)
    temp = 15
    h.advance(REFRESH_MS - 1)
    expect((await h.service.current(london))?.tempC).toBe(10)
    expect(h.urls).toHaveLength(1)
    h.advance(1)
    expect((await h.service.current(london))?.tempC).toBe(15)
    expect(h.urls).toHaveLength(2)
  })
  it('shares one request between screens asking at once', async () => {
    const h = harness(() => forecast())
    const [a, b] = await Promise.all([h.service.current(london), h.service.current(london)])
    expect(a?.tempC).toBe(b?.tempC)
    expect(h.urls).toHaveLength(1)
  })
  it('shows an older reading as stale when offline, waits before retrying, and hides it after 3 hours', async () => {
    let offline = false
    const h = harness(() => (offline ? new TypeError('fetch failed') : forecast()))
    await h.service.current(london)
    offline = true
    h.advance(REFRESH_MS)
    expect(await h.service.current(london)).toMatchObject({ tempC: 11.6, stale: true })
    expect(h.urls).toHaveLength(2)
    h.advance(RETRY_MS - 1)
    await h.service.current(london)
    expect(h.urls).toHaveLength(2)
    h.advance(MAX_AGE_MS)
    expect(await h.service.current(london)).toBeNull()
  })
  it('hides the weather when there is no place, no reading yet, or a bad reply', async () => {
    const h = harness(() => ({ current: { temperature_2m: 'warm' } }))
    expect(await h.service.current(undefined)).toBeNull()
    expect(await h.service.current(london)).toBeNull()
    const h2 = harness(() => new Response('busy', { status: 503 }))
    expect(await h2.service.current(london)).toBeNull()
  })
  it('starts again when the place changes', async () => {
    const h = harness((url) => forecast(url.searchParams.get('latitude') === '51.51' ? 11 : 20))
    await h.service.current(london)
    const now = await h.service.current({ name: 'Madrid', lat: 40.4165, lon: -3.70256 })
    expect(now).toMatchObject({ place: 'Madrid', tempC: 20 })
    expect(h.urls).toHaveLength(2)
  })
  it('finds towns by name with region and country', async () => {
    const h = harness(() => ({ results: [
      { id: 1, name: 'London', latitude: 51.50853, longitude: -0.12574, country: 'United Kingdom', admin1: 'England' },
      { id: 2, name: 'London', latitude: 42.98339, longitude: -81.23304, country: 'Canada', admin1: 'Ontario' },
    ] }))
    const places = await h.service.search('  London ')
    expect(places).toEqual([{ ...london, lat: 51.51, lon: -0.13 },
      { name: 'London', region: 'Ontario', country: 'Canada', lat: 42.98, lon: -81.23 }])
    const url = h.urls[0]!
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search')
    expect(url.searchParams.get('name')).toBe('London')
  })
  it('shortens over-long names to what settings can keep and skips blank ones', async () => {
    const long = 'x'.repeat(300)
    const h = harness(() => ({ results: [{ name: ' ', latitude: 1, longitude: 1 },
      { name: long, latitude: 1, longitude: 1, admin1: 'y'.repeat(300), country: long }] }))
    expect(await h.service.search('Long')).toEqual([
      { name: 'x'.repeat(120), region: 'y'.repeat(120), country: 'x'.repeat(120), lat: 1, lon: 1 }])
  })
  it('returns no towns for short text or no matches, and plain errors when the search fails', async () => {
    const empty = harness(() => ({ generationtime_ms: 0.2 }))
    expect(await empty.service.search('x')).toEqual([])
    expect(empty.urls).toHaveLength(0)
    expect(await empty.service.search('Nowhereville')).toEqual([])
    await expect(harness(() => new TypeError('fetch failed')).service.search('London')).rejects.toThrow(SEARCH_OFFLINE)
    await expect(harness(() => new Response('{', { status: 200 })).service.search('London')).rejects.toThrow(SEARCH_FAILED)
    await expect(harness(() => ({ results: [{ name: 'Bad', latitude: 500, longitude: 0 }] })).service.search('Bad'))
      .rejects.toThrow(SEARCH_FAILED)
  })
  it('stops answering after dispose', async () => {
    const h = harness(() => forecast())
    h.service.dispose()
    expect(await h.service.current(london)).toBeNull()
    expect(h.urls).toHaveLength(0)
  })
})
