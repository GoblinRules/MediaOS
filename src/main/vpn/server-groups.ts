export function groupServers(names: string[]): { country: string; entries: { id: string; name: string }[] }[] {
  if (names.length > 10_000) throw new RangeError('Too many VPN servers')
  const groups = new Map<string, { id: string; name: string }[]>()
  names.forEach((name, index) => {
    let country = /^([a-z]{2})(?=[-_#\d])/i.exec(name)?.[1]?.toUpperCase() ?? ''
    if (country === 'UK') country = 'GB'
    const entries = groups.get(country) ?? []
    entries.push({ id: `e${index}`, name }); groups.set(country, entries)
  })
  return [...groups].sort(([a], [b]) => a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)).map(([country, entries]) =>
    ({ country, entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })) }))
}

export function suggestLabel(name: string): string {
  return [...stripDisplayControls(name).trim()].slice(0, VPN_LABEL_MAX).join('') || 'VPN'
}
import { VPN_LABEL_MAX } from '../../shared/vpn-types'
import { stripDisplayControls } from './display-text'

