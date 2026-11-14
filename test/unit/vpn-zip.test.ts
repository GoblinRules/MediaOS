import { describe, expect, it } from 'vitest'
import { readZipConfs } from '../../src/main/vpn/zip-reader'
import { zip } from '../fixtures/vpn/zip'

const bad = { ok: false, error: 'not-wireguard' }, large = { ok: false, error: 'too-large' }
describe('bounded zip reader', () => {
  it.each([0, 8])('reads method %i and uses only the base name', (method) => {
    const data = Buffer.from('config')
    expect(readZipConfs(zip([{ name: 'folder/GB#12.CONF', data, method }]))).toEqual({ ok: true,
      entries: [{ name: 'GB#12', data }] })
  })
  it('ignores non-configs, directories, dot files, mac metadata and unsupported methods', () => {
    const input = zip([...['readme', 'folder.conf/', '._x.conf', '__MACOSX/x.conf', '.hidden/x.conf'].map((name) => ({ name })),
      { name: 'bad.conf', method: 99 }, { name: 'dir.conf', attributes: 0x10 },
      { name: 'unix-dir.conf', attributes: 0x40000000 }, { name: 'good.conf' }])
    const result = readZipConfs(input)
    expect(result).toEqual({ ok: true, entries: [{ name: 'good', data: Buffer.from('test') }] })
  })
  it('counts all directory entries, accepting 1000 but refusing 1001', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ name: `${i}.txt` }))
    entries[0]!.name = 'good.conf'
    expect(readZipConfs(zip(entries)).ok).toBe(true)
    expect(readZipConfs(zip([...entries, { name: 'one-more.txt' }]))).toEqual(large)
  })
  it.each([0, 8])('limits actual entry sizes with method %i', (method) => {
    expect(readZipConfs(zip([{ name: 'x.conf', data: Buffer.alloc(16385), method }]))).toEqual(large)
    expect(readZipConfs(zip([{ name: 'x.conf', data: Buffer.alloc(500_000), size: 1, method }]))).toEqual(large)
  })
  it('limits total output to 1 MB', () => {
    expect(readZipConfs(zip(Array.from({ length: 65 }, (_, i) =>
      ({ name: `${i}.conf`, data: Buffer.alloc(16384), method: 8 }))))).toEqual(large)
  })
  it.each([{ crc: 0 }, { size: 1 }, { flags: 1 }, { extra: Buffer.from([1, 0, 0, 0]) }])(
    'refuses invalid entry %#', (options) => expect(readZipConfs(zip([{ name: 'x.conf', ...options }]))).toEqual(bad))
  it('refuses truncated archives and directories, bad offsets, multi-disk and ZIP64', () => {
    const input = zip([{ name: 'x.conf' }]), end = input.length - 22
    expect(readZipConfs(input.subarray(0, -1))).toEqual(bad)
    for (const mutate of [
      (b: Buffer) => b.writeUInt32LE(0xffffffff, end + 16),
      (b: Buffer) => b.writeUInt16LE(0xffff, end + 10),
      (b: Buffer) => b.writeUInt16LE(1, end + 4),
      (b: Buffer) => b.writeUInt32LE(0xffffffff, b.readUInt32LE(end + 16) + 42),
      (b: Buffer) => b.writeUInt16LE(60000, b.readUInt32LE(end + 16) + 28),
      (b: Buffer) => b.writeUInt32LE(0, b.readUInt32LE(end + 16)),
    ]) {
      const b = Buffer.from(input); mutate(b); expect(readZipConfs(b)).toEqual(bad)
    }
  })
  it('does not trust local sizes', () => {
    const input = zip([{ name: 'x.conf' }]); input.writeUInt32LE(999999, 18); input.writeUInt32LE(999999, 22)
    expect(readZipConfs(input).ok).toBe(true)
  })
  it('rejects ZIP64 extras confined to the local header and overlapping data', () => {
    const input = zip([{ name: 'x.conf', extra: Buffer.from([2, 0, 0, 0]) }])
    input.writeUInt16LE(1, 30 + Buffer.byteLength('x.conf'))
    expect(readZipConfs(input)).toEqual(bad)
    const overlap = zip([{ name: 'x.conf' }])
    const directory = overlap.readUInt32LE(overlap.length - 6)
    overlap.writeUInt32LE(overlap.length, directory + 20)
    expect(readZipConfs(overlap)).toEqual(bad)
  })
  it('finds an EOCD followed by its comment and refuses empty input or no configs', () => {
    const input = zip([{ name: 'x.conf' }]); input.writeUInt16LE(7, input.length - 2)
    expect(readZipConfs(Buffer.concat([input, Buffer.from('comment')])).ok).toBe(true)
    expect(readZipConfs(Buffer.alloc(0))).toEqual(bad)
    expect(readZipConfs(zip([{ name: 'readme' }]))).toEqual(bad)
  })
})
