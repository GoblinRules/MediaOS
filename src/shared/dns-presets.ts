// Public DNS services offered in Settings > Network > DNS. Used by main (to write them) and the UI (to describe them).
import type { DnsPreset } from './system-types'

export interface DnsPresetInfo {
  id: DnsPreset
  label: string
  ipv4: readonly [string, string]
  ipv6: readonly [string, string]
}

export const DNS_PRESETS: readonly DnsPresetInfo[] = [
  { id: 'cloudflare', label: 'Cloudflare', ipv4: ['1.1.1.1', '1.0.0.1'], ipv6: ['2606:4700:4700::1111', '2606:4700:4700::1001'] },
  { id: 'google', label: 'Google', ipv4: ['8.8.8.8', '8.8.4.4'], ipv6: ['2001:4860:4860::8888', '2001:4860:4860::8844'] },
  { id: 'quad9', label: 'Quad9', ipv4: ['9.9.9.9', '149.112.112.112'], ipv6: ['2620:fe::fe', '2620:fe::9'] },
]

export function dnsPreset(id: DnsPreset): DnsPresetInfo {
  const found = DNS_PRESETS.find((p) => p.id === id)
  if (!found) throw new Error(`Unknown DNS preset ${id}`)
  return found
}
