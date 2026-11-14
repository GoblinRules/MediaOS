// QR Model 2, byte mode, level M. Tables are ISO/IEC 18004's M blocks and alignment centres (versions 1-10).
export interface QrCode { version: number; mask: number; size: number; modules: boolean[][] }
const BLOCKS = [
  [[1, 26, 16]], [[1, 44, 28]], [[1, 70, 44]], [[2, 50, 32]], [[2, 67, 43]],
  [[4, 43, 27]], [[4, 49, 31]], [[2, 60, 38], [2, 61, 39]], [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
]
const CENTRES = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
const MASKS = [
  (r: number, c: number) => (r + c) % 2 === 0, (r: number) => r % 2 === 0,
  (_r: number, c: number) => c % 3 === 0, (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => r * c % 2 + r * c % 3 === 0,
  (r: number, c: number) => (r * c % 2 + r * c % 3) % 2 === 0,
  (r: number, c: number) => (r * c % 3 + (r + c) % 2) % 2 === 0,
]

function multiply(a: number, b: number): number {
  let result = 0
  for (; b; b >>>= 1) {
    if (b & 1) result ^= a
    a <<= 1
    if (a & 256) a ^= 0x11d
  }
  return result
}
function parity(data: number[], count: number): number[] {
  let generator = [1], root = 1
  for (let i = 0; i < count; i++) {
    const next = Array<number>(generator.length + 1).fill(0)
    generator.forEach((v, j) => { next[j] = next[j]! ^ v; next[j + 1] = next[j + 1]! ^ multiply(v, root) })
    generator = next; root = multiply(root, 2)
  }
  const work = [...data, ...Array<number>(count).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = work[i]!
    generator.forEach((v, j) => { work[i + j] = work[i + j]! ^ multiply(v, factor) })
  }
  return work.slice(data.length)
}
function codewords(bytes: Uint8Array, version: number): number[] {
  const groups = BLOCKS[version - 1]!, bits: number[] = []
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push(value >>> i & 1)
  }
  const capacity = groups.reduce((sum, [count, _total, data]) => sum + count! * data!, 0)
  put(4, 4); put(bytes.length, version < 10 ? 8 : 16)
  bytes.forEach((b) => put(b, 8))
  put(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, bit) => v * 2 + bit, 0))
  for (let i = 0; data.length < capacity; i++) data.push(i % 2 ? 0x11 : 0xec)
  const blocks: number[][] = [], checks: number[][] = []
  let offset = 0
  for (const [count, total, length] of groups) for (let i = 0; i < count!; i++) {
    const block = data.slice(offset, offset + length!)
    offset += length!; blocks.push(block); checks.push(parity(block, total! - length!))
  }
  const interleave = (parts: number[][]): number[] => {
    const result: number[] = []
    for (let i = 0; i < Math.max(...parts.map((p) => p.length)); i++) {
      for (const part of parts) if (i < part.length) result.push(part[i]!)
    }
    return result
  }
  return [...interleave(blocks), ...interleave(checks)]
}
function bch(value: number, polynomial: number): number {
  const degree = (v: number): number => 31 - Math.clz32(v)
  while (degree(value) >= degree(polynomial)) value ^= polynomial << (degree(value) - degree(polynomial))
  return value
}
function matrix(version: number, mask: number, data: number[], trial = false): boolean[][] {
  const size = version * 4 + 17
  const cells: (boolean | null)[][] = Array.from({ length: size }, () => Array<boolean | null>(size).fill(null))
  const set = (r: number, c: number, dark: boolean): void => { cells[r]![c] = dark }
  for (const [r, c] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      if (r! + y < 0 || r! + y >= size || c! + x < 0 || c! + x >= size) continue
      set(r! + y, c! + x, (y >= 0 && y <= 6 && (x === 0 || x === 6)) ||
        (x >= 0 && x <= 6 && (y === 0 || y === 6)) || (y >= 2 && y <= 4 && x >= 2 && x <= 4))
    }
  }
  for (const r of CENTRES[version - 1]!) for (const c of CENTRES[version - 1]!) {
    if (cells[r]![c] !== null) continue
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      set(r + y, c + x, Math.abs(y) === 2 || Math.abs(x) === 2 || (x === 0 && y === 0))
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (cells[i]![6] === null) set(i, 6, i % 2 === 0)
    if (cells[6]![i] === null) set(6, i, i % 2 === 0)
  }
  const format = ((mask << 10) | bch(mask << 10, 0x537)) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const dark = !trial && (format >>> i & 1) !== 0
    set(i < 6 ? i : i < 8 ? i + 1 : size - 15 + i, 8, dark)
    set(8, i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i, dark)
  }
  set(size - 8, 8, !trial)
  if (version >= 7) {
    const info = version << 12 | bch(version << 12, 0x1f25)
    for (let i = 0; i < 18; i++) {
      const dark = !trial && (info >>> i & 1) !== 0
      set(Math.floor(i / 3), i % 3 + size - 11, dark)
      set(i % 3 + size - 11, Math.floor(i / 3), dark)
    }
  }
  let row = size - 1, direction = -1, bit = 0
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (;;) {
      for (let x = 0; x < 2; x++) if (cells[row]![col - x] === null) {
        const dark = ((data[bit >>> 3] ?? 0) >>> (7 - bit % 8) & 1) !== 0
        set(row, col - x, dark !== MASKS[mask]!(row, col - x)); bit++
      }
      row += direction
      if (row < 0 || row >= size) { row -= direction; direction = -direction; break }
    }
  }
  return cells.map((r) => r.map((v) => v === true))
}

/** All four mask penalties: runs, 2x2 blocks, finder-like sequences, and dark balance. */
function penalty(cells: boolean[][]): number {
  const size = cells.length
  let score = 0, dark = 0
  const line = (values: boolean[]): void => {
    let run = 0, last = false
    for (const value of values) {
      if (value === last) run++; else { if (run >= 5) score += run - 2; last = value; run = 1 }
    }
    if (run >= 5) score += run - 2
    for (let i = 0; i <= values.length - 11; i++) {
      const pattern = values.slice(i, i + 11).map(Number).join('')
      if (pattern === '10111010000' || pattern === '00001011101') score += 40
    }
  }
  for (let r = 0; r < size; r++) {
    line(cells[r]!); line(cells.map((row) => row[r]!))
    for (let c = 0; c < size; c++) {
      if (cells[r]![c]) dark++
      if (r && c && cells[r]![c] === cells[r - 1]![c] && cells[r]![c] === cells[r]![c - 1] &&
        cells[r]![c] === cells[r - 1]![c - 1]) score += 3
    }
  }
  return score + Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10
}

export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  if (opts.mask !== undefined && (!Number.isInteger(opts.mask) || opts.mask < 0 || opts.mask > 7)) throw new Error('Bad QR mask')
  const bytes = new TextEncoder().encode(text)
  const index = BLOCKS.findIndex((groups, i) =>
    4 + (i < 9 ? 8 : 16) + bytes.length * 8 <= groups.reduce((n, [count, _total, data]) => n + count! * data! * 8, 0))
  if (index < 0) throw new Error('Text is too long for a QR code')
  const version = index + 1, data = codewords(bytes, version)
  let mask = opts.mask ?? 0
  if (opts.mask === undefined) {
    let best = Infinity
    for (let candidate = 0; candidate < 8; candidate++) {
      const score = penalty(matrix(version, candidate, data, true))
      if (score < best) { best = score; mask = candidate }
    }
  }
  return { version, mask, size: version * 4 + 17, modules: matrix(version, mask, data) }
}
