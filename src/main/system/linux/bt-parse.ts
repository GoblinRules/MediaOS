import type { BtDevice } from '@shared/system-types'

type Properties = Record<string, unknown>
export interface BluezState {
  adapter?: { path: string; powered: boolean }
  devices: { path: string; device: BtDevice }[]
}
export const validBtAddress = (address: string): boolean => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(address)
function record(value: unknown): Properties {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Properties : {}
}
function props(value: unknown): Properties {
  return Object.fromEntries(Object.entries(record(value)).map(([key, variant]) => [key, record(variant).data]))
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
function kind(p: Properties, name: string): BtDevice['kind'] {
  const appearance = p.Appearance
  if ((typeof appearance === 'number' && appearance >= 0x180 && appearance <= 0x1bf) || /remote/i.test(name)) return 'remote'
  const icons: Record<string, BtDevice['kind']> = {
    'input-gaming': 'gamepad', 'input-keyboard': 'keyboard', 'input-mouse': 'mouse', 'input-tablet': 'mouse',
    'audio-headphones': 'headphones', 'audio-headset': 'headphones', 'audio-card': 'speaker', 'audio-speakers': 'speaker',
    phone: 'phone',
  }
  const icon = Object.hasOwn(icons, text(p.Icon)) ? icons[text(p.Icon)] : undefined
  if (icon) return icon
  if (typeof p.Class !== 'number' || !Number.isInteger(p.Class)) return 'other'
  const major = (p.Class >> 8) & 0x1f, minor = (p.Class >> 2) & 0x3f
  if (major === 5) {
    const keys = (p.Class >> 6) & 3
    if (keys === 1) return 'keyboard'
    if (keys === 2) return 'mouse'
    if ((minor & 15) === 1 || (minor & 15) === 2) return 'gamepad'
    if ((minor & 15) === 3) return 'remote'
  }
  if (major === 4) return [1, 2, 6].includes(minor) ? 'headphones' : 'speaker'
  return major === 2 ? 'phone' : 'other'
}

export function parseBluez(stdout: string, includeUnnamed = false): BluezState {
  let root: Properties
  try { root = record(JSON.parse(stdout) as unknown) } catch { return { devices: [] } }
  if (root.type !== 'a{oa{sa{sv}}}' || !Array.isArray(root.data)) return { devices: [] }
  const objects = Object.entries(record(root.data[0])).map(([path, interfaces]) => ({ path, interfaces: record(interfaces) }))
  const adapter = objects.filter((o) => /^\/org\/bluez\/hci\d+$/.test(o.path) && 'org.bluez.Adapter1' in o.interfaces)
    .sort((a, b) => Number(a.path.slice(14)) - Number(b.path.slice(14)))[0]
  if (!adapter) return { devices: [] }
  const devices: BluezState['devices'] = []
  for (const { path, interfaces } of objects) {
    const p = props(interfaces['org.bluez.Device1']), address = text(p.Address)
    const paired = p.Paired === true || p.Bonded === true
    if (p.Adapter !== adapter.path || !validBtAddress(address) || (!includeUnnamed && !paired && !text(p.Name))) continue
    if (!path.startsWith(`${adapter.path}/dev_`) || !/^\/org\/bluez\/hci\d+\/dev_[0-9A-F_]+$/.test(path)) continue
    const name = text(p.Alias) || text(p.Name) || address
    const battery = props(interfaces['org.bluez.Battery1']).Percentage
    devices.push({ path, device: { address, name, paired, connected: p.Connected === true, kind: kind(p, name),
      ...(typeof battery === 'number' && battery >= 0 && battery <= 100 ? { battery } : {}) } })
  }
  devices.sort((a, b) => Number(b.device.connected) - Number(a.device.connected) ||
    Number(b.device.paired) - Number(a.device.paired) || a.device.name.localeCompare(b.device.name, undefined, { sensitivity: 'base' }))
  return { adapter: { path: adapter.path, powered: props(adapter.interfaces['org.bluez.Adapter1']).Powered === true }, devices }
}
