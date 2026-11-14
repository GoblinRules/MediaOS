import { crc32, inflateRawSync } from 'node:zlib'
import { stripDisplayControls } from './display-text'

type Result = { ok: true; entries: { name: string; data: Buffer }[] } |
  { ok: false; error: 'too-large' | 'not-wireguard' }
const invalid = (): Result => ({ ok: false, error: 'not-wireguard' })
const large = (): Result => ({ ok: false, error: 'too-large' })
const CAP = 16 * 1024

function invalidExtra(input: Buffer, start: number, end: number): boolean {
  while (start < end) {
    if (start + 4 > end || input.readUInt16LE(start) === 1) return true
    start += 4 + input.readUInt16LE(start + 2)
    if (start > end) return true
  }
  return false
}

export function readZipConfs(input: Buffer): Result {
  let end = -1
  for (let i = input.length - 22; i >= Math.max(0, input.length - 65_557); i--) {
    if (input.readUInt32LE(i) === 0x06054b50 && i + 22 + input.readUInt16LE(i + 20) === input.length) { end = i; break }
  }
  if (end < 0) return invalid()
  const count = input.readUInt16LE(end + 10), size = input.readUInt32LE(end + 12), offset = input.readUInt32LE(end + 16)
  if (input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6) || input.readUInt16LE(end + 8) !== count ||
    count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size !== end ||
    (end >= 20 && input.readUInt32LE(end - 20) === 0x07064b50)) return invalid()
  if (count > 1000) return large()
  let at = offset, total = 0
  const entries: { name: string; data: Buffer }[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || input.readUInt32LE(at) !== 0x02014b50) return invalid()
    const flags = input.readUInt16LE(at + 8), method = input.readUInt16LE(at + 10), crc = input.readUInt32LE(at + 16)
    const compressed = input.readUInt32LE(at + 20), expanded = input.readUInt32LE(at + 24)
    const nameSize = input.readUInt16LE(at + 28), extraSize = input.readUInt16LE(at + 30), comment = input.readUInt16LE(at + 32)
    const local = input.readUInt32LE(at + 42), next = at + 46 + nameSize + extraSize + comment
    if (next > end || flags & 0x2041 || input.readUInt16LE(at + 34) ||
      [compressed, expanded, local].includes(0xffffffff)) return invalid()
    if (invalidExtra(input, at + 46 + nameSize, at + 46 + nameSize + extraSize)) return invalid()
    const attributes = input.readUInt32LE(at + 38)
    const name = input.toString('utf8', at + 46, at + 46 + nameSize).replace(/\\/g, '/')
    at = next
    // Validate all offsets, even for files we will not extract. Sizes always come from the directory.
    if (local + 30 > offset || input.readUInt32LE(local) !== 0x04034b50) return invalid()
    const dataAt = local + 30 + input.readUInt16LE(local + 26) + input.readUInt16LE(local + 28)
    if (dataAt + compressed > offset || input.readUInt16LE(local + 8) !== method ||
      input.readUInt16LE(local + 6) !== flags) return invalid()
    if (invalidExtra(input, local + 30 + input.readUInt16LE(local + 26), dataAt)) return invalid()
    const parts = name.split('/'), base = parts.at(-1)!
    if ((attributes & 0x10) || ((attributes >>> 16) & 0xf000) === 0x4000 ||
      !/\.conf$/i.test(base) || parts.some((part) => part.startsWith('.') || part === '__MACOSX') ||
      ![0, 8].includes(method)) continue
    const displayName = [...stripDisplayControls(base.slice(0, -5))].slice(0, 64).join('')
    if (!displayName) continue
    if (expanded > CAP || (method === 0 && compressed > CAP)) return large()
    let data: Buffer
    try {
      const bytes = input.subarray(dataAt, dataAt + compressed)
      data = method === 0 ? Buffer.from(bytes) : inflateRawSync(bytes, { maxOutputLength: CAP + 1 })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') return large()
      return invalid()
    }
    if (data.length > CAP || (total += data.length) > 1024 * 1024) return large()
    if (data.length !== expanded || crc32(data) !== crc) return invalid()
    entries.push({ name: displayName, data })
  }
  if (at !== offset + size || !entries.length) return invalid()
  return { ok: true, entries }
}
