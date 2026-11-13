export type DnsRecord =
  | { name: string; type: 'PTR'; target: string; labels: string[] }
  | { name: string; type: 'SRV'; target: string }
  | { name: string; type: 'A'; ip: string }

export function smbQuery(): Buffer {
  const labels = ['_smb', '_tcp', 'local'].map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]))
  const header = Buffer.alloc(12); header.writeUInt16BE(1, 4)
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0x80, 1])])
}

/** Malformed datagrams are discarded as a whole. No parser exception reaches a socket callback. */
export function parseDns(packet: Buffer): DnsRecord[] {
  try {
    if (packet.length < 12 || packet.length > 65_535) return []
    const need = (at: number, size: number) => { if (at < 0 || at + size > packet.length) throw new Error('Truncated DNS') }
    const name = (start: number): { text: string; labels: string[]; end: number } => {
      const labels: string[] = [], seen = new Set<number>()
      let at = start, end = -1, jumps = 0, bytes = 1
      for (;;) {
        need(at, 1)
        if (seen.has(at)) throw new Error('DNS loop')
        seen.add(at)
        const n = packet[at++]!
        if ((n & 0xc0) === 0xc0) {
          need(at, 1)
          if (++jumps > 20) throw new Error('DNS jumps')
          if (end < 0) end = at + 1
          at = ((n & 0x3f) << 8) | packet[at]!
        } else if (n === 0) return { text: labels.join('.'), labels, end: end < 0 ? at : end }
        else {
          if (n > 63 || (bytes += n + 1) > 255) throw new Error('DNS name length')
          need(at, n); labels.push(packet.toString('utf8', at, at + n)); at += n
        }
      }
    }
    let at = 12
    for (let i = 0; i < packet.readUInt16BE(4); i++) { at = name(at).end; need(at, 4); at += 4 }
    const records: DnsRecord[] = []
    const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10)
    for (let i = 0; i < count; i++) {
      const owner = name(at); at = owner.end; need(at, 10)
      const type = packet.readUInt16BE(at), len = packet.readUInt16BE(at + 8)
      at += 10; need(at, len)
      if (type === 12 || type === 33) {
        const offset = type === 33 ? 6 : 0
        if (len < offset + 1) throw new Error('DNS record length')
        const target = name(at + offset)
        if (target.end > at + len) throw new Error('DNS record overrun')
        if (type === 12) records.push({ name: owner.text, type: 'PTR', target: target.text, labels: target.labels })
        else records.push({ name: owner.text, type: 'SRV', target: target.text })
      } else if (type === 1) {
        if (len !== 4) throw new Error('DNS address length')
        records.push({ name: owner.text, type: 'A', ip: [...packet.subarray(at, at + 4)].join('.') })
      }
      at += len
    }
    return records
  } catch { return [] }
}
