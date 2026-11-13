import type { AudioSink, DisplayMode, DisplayOutput } from '@shared/system-types'

export const fallbackZones = ['Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney']

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function json(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

export function parseAudioOutputs(stdout: string): AudioSink[] {
  const objects = array(json(stdout)).map(record)
  let defaultName = ''
  for (const obj of objects) {
    if (obj.type !== 'PipeWire:Interface:Metadata' || record(obj.props)['metadata.name'] !== 'default') continue
    for (const entry of array(obj.metadata).map(record)) {
      if (entry.key !== 'default.audio.sink') continue
      const value = typeof entry.value === 'string' ? json(entry.value) : entry.value
      defaultName = text(record(value).name)
    }
  }
  const sinks: AudioSink[] = []
  for (const obj of objects) {
    const props = record(record(obj.info).props)
    if (obj.type !== 'PipeWire:Interface:Node' || props['media.class'] !== 'Audio/Sink' ||
        typeof obj.id !== 'number' || !Number.isSafeInteger(obj.id) || obj.id < 0) continue
    const node = text(props['node.name'])
    const name = text(props['node.description']) || text(props['node.nick']) || node
    if (!name) continue
    const lower = node.toLowerCase()
    const kind: AudioSink['kind'] = props['device.api'] === 'bluez5' ? 'bluetooth' : lower.includes('hdmi') ? 'hdmi'
      : lower.includes('usb') || props['device.bus'] === 'usb' ? 'usb' : lower.includes('analog') ? 'analog' : 'other'
    sinks.push({ id: String(obj.id), name, kind, active: !!node && node === defaultName })
  }
  return sinks
}

export function parseVolume(stdout: string): number | undefined {
  const match = /^Volume:\s*(-?\d+(?:\.\d+)?)(?:\s+\[MUTED\])?\s*$/.exec(stdout.trim())
  if (!match) return undefined
  const volume = Number(match[1])
  return Number.isFinite(volume) ? Math.round(Math.max(0, Math.min(1, volume)) * 100) : undefined
}

function mode(value: unknown): DisplayMode | undefined {
  const { width, height, refresh } = record(value)
  if (!positive(width) || !Number.isInteger(width) || !positive(height) || !Number.isInteger(height) || !positive(refresh)) return
  return { id: `${width}x${height}@${refresh}`, width, height, refresh: refresh / 1000 }
}
export const safeOutputName = (name: string): boolean => /^[A-Za-z0-9._-]+$/.test(name)

export function parseDisplayOutputs(stdout: string): DisplayOutput[] {
  const outputs: DisplayOutput[] = []
  for (const obj of array(json(stdout)).map(record)) {
    const id = text(obj.name)
    if (!id || !safeOutputName(id)) continue
    const make = text(obj.make), model = text(obj.model)
    const name = !make || !model || make === 'Unknown' || model === 'Unknown' ? 'TV' : `${make} ${model}`
    const unique = new Map<string, DisplayMode>()
    for (const value of array(obj.modes)) {
      const parsed = mode(value)
      if (parsed) unique.set(parsed.id, parsed)
    }
    const modes = [...unique.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh)
    const current = mode(obj.current_mode)
    outputs.push({ id, name, connected: obj.active === true, modes, current: modes.find((m) => m.id === current?.id),
      scale: positive(obj.scale) ? obj.scale : 1 })
  }
  return outputs
}

export function parseTime(stdout: string): { timezone?: string; ntp: boolean } {
  const fields = new Map(stdout.split(/\r?\n/).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  }))
  const timezone = fields.get('Timezone')
  return { timezone: timezone && validZone(timezone) ? timezone : undefined, ntp: fields.get('NTPSynchronized') === 'yes' }
}
function validZone(zone: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true } catch { return false }
}
export function parseZones(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(validZone))]
}
export function parseOsRelease(stdout: string): string {
  const value = /^PRETTY_NAME=(.*)$/m.exec(stdout)?.[1]?.trim() ?? ''
  return value.replace(/^(["'])(.*)\1$/, '$2') || 'Linux'
}

/** One second of quiet mono PCM, with a short fade to avoid clicks. */
export function testToneWav(): Buffer {
  const rate = 48000, samples = rate, bytes = samples * 2
  const wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40)
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 480, (samples - 1 - i) / 480)
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.2 * 32767 * fade), 44 + i * 2)
  }
  return wav
}
