import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeQr } from '../../src/shared/qr'

interface Fixture { text: string; version: number; mask: number; forcedMask: boolean; rows: string[] }
const fixtures = JSON.parse(readFileSync('test/fixtures/qr/qr-byte-m.json', 'utf8')) as Fixture[]
describe('QR byte mode, level M', () => {
  it.each(fixtures)('matches version $version mask $mask (forced=$forcedMask)', (fixture) => {
    const result = encodeQr(fixture.text, fixture.forcedMask ? { mask: fixture.mask } : undefined)
    expect(result.version).toBe(fixture.version)
    expect(result.mask).toBe(fixture.mask)
    expect(result.size).toBe(fixture.version * 4 + 17)
    expect(result.modules.map((row) => row.map(Number).join(''))).toEqual(fixture.rows)
  })
  it('uses UTF-8 bytes and enforces the version 10 capacity and mask bounds', () => {
    expect(encodeQr('é'.repeat(8)).version).toBe(2)
    expect(encodeQr('a'.repeat(213)).version).toBe(10)
    expect(() => encodeQr('a'.repeat(214))).toThrow(Error)
    for (const mask of [-1, 8, 0.5, NaN]) expect(() => encodeQr('test', { mask })).toThrow(Error)
  })
})
