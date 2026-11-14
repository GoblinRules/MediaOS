import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string; data?: Buffer; method?: number; size?: number; crc?: number; flags?: number; extra?: Buffer; attributes?: number
}
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], directories: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = entry.data ?? Buffer.from('test'), extra = entry.extra ?? Buffer.alloc(0)
    const method = entry.method ?? 0, packed = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(entry.crc ?? crc32(data), 14); local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(entry.size ?? data.length, 22); local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(entry.crc ?? crc32(data), 16); central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(entry.size ?? data.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(offset, 42)
    central.writeUInt32LE(entry.attributes ?? 0, 38)
    locals.push(local, name, extra, packed); directories.push(central, name, extra)
    offset += local.length + name.length + extra.length + packed.length
  }
  const directory = Buffer.concat(directories), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
