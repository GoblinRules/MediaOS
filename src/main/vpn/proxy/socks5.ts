import { refusedDomain } from './target-policy'
import { isIPv4 } from 'node:net'

export interface Request { kind: 'ipv4' | 'domain'; host: string; port: number }
export type ParseResult = { type: 'more' } | { type: 'close' } | { type: 'reply'; data: Buffer } |
  { type: 'greeting'; data: Buffer } | { type: 'request'; request: Request; extra: Buffer }
export const reply = (code: number): Buffer => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])

export class Socks5Parser {
  private buffer: Buffer = Buffer.alloc(0)
  private greeted = false
  private done = false
  private consumed = 0

  feed(chunk: Buffer): ParseResult {
    if (this.done) return { type: 'close' }
    this.buffer = Buffer.concat([this.buffer, chunk])
    const b = this.buffer
    const fail = (code: number): ParseResult => {
      this.done = true
      return b.length + this.consumed > 600 ? { type: 'close' } : { type: 'reply', data: reply(code) }
    }
    if (!b.length) return { type: 'more' }
    if (b[0] !== 5) { this.done = true; return { type: 'close' } }
    if (!this.greeted) {
      if (b.length < 2 || b.length < 2 + b[1]!) return this.more()
      const end = 2 + b[1]!
      if (!b.subarray(2, end).includes(0)) {
        this.done = true
        return b.length > 600 ? { type: 'close' } : { type: 'reply', data: Buffer.from([5, 255]) }
      }
      this.consumed += end; this.buffer = b.subarray(end); this.greeted = true
      return { type: 'greeting', data: Buffer.from([5, 0]) }
    }
    if (b.length < 4) return this.more()
    if (b[1] !== 1) return fail(7)
    if (b[2] !== 0) return fail(1)
    if (b[3] === 4) return fail(2)
    if (b[3] !== 1 && b[3] !== 3) return fail(8)
    if (b[3] === 3 && b.length < 5) return this.more()
    const length = b[3] === 1 ? 4 : b[4]!
    if (length < 1 || length > 253) return fail(4)
    const start = b[3] === 1 ? 4 : 5, end = start + length + 2
    if (b.length < end) return this.more()
    if (this.consumed + end > 600) { this.done = true; return { type: 'close' } }
    const host = b[3] === 1 ? [...b.subarray(start, start + length)].join('.') :
      b.toString('latin1', start, start + length)
    if (b[3] === 3 && !/^[A-Za-z0-9.-]+$/.test(host)) return fail(4)
    if (b[3] === 3 && !isIPv4(host) && refusedDomain(host)) return fail(2)
    const port = b.readUInt16BE(end - 2)
    if (!port) return fail(2)
    this.done = true
    return { type: 'request', request: { kind: b[3] === 1 || isIPv4(host) ? 'ipv4' : 'domain', host, port },
      extra: b.subarray(end) }
  }

  private more(): ParseResult {
    if (this.buffer.length + this.consumed > 600) { this.done = true; return { type: 'close' } }
    return { type: 'more' }
  }
}
