import { createSocket } from 'node:dgram'
import { randomInt } from 'node:crypto'
import { runtime, type Runtime } from '../core/runtime'

export interface ProbeSocket {
  on(event: 'message', cb: (message: Buffer) => void): this
  on(event: 'error', cb: (error: Error) => void): this
  bind(options: { address: string; port: number }, cb: () => void): void
  send(message: Buffer, port: number, address: string, cb: (error: Error | null) => void): void
  close(): void
}
export interface ProbeOptions { socket?: () => ProbeSocket; id?: () => number; clock?: Runtime }

export function probe(tunIp: string, dns: string | null, timeoutMs: number, opts: ProbeOptions = {}): Promise<boolean> {
  const clock = opts.clock ?? runtime
  return new Promise((resolve) => {
    let socket: ProbeSocket | undefined, finished = false
    const finish = (ok: boolean): void => {
      if (finished) return
      finished = true; clock.clearTimeout(timer)
      try { socket?.close() } catch { /* A failed bind may already have closed the socket. */ }
      resolve(ok)
    }
    const timer = clock.setTimeout(() => finish(false), Math.max(0, timeoutMs))
    try {
      const id = (opts.id ?? (() => randomInt(65536)))()
      const question = Buffer.from('\x07example\x03com\x00\x00\x01\x00\x01', 'binary')
      const header = Buffer.alloc(12)
      header.writeUInt16BE(id, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4)
      socket = (opts.socket ?? (() => createSocket('udp4')))()
      socket.on('error', () => finish(false))
      socket.on('message', (reply) => {
        if (reply.length >= 12 && reply.readUInt16BE(0) === id && (reply[2]! & 0x80)) finish(true)
      })
      socket.bind({ address: tunIp, port: 0 }, () => {
        if (finished) return
        try { socket!.send(Buffer.concat([header, question]), 53, dns ?? '9.9.9.9', (error) => { if (error) finish(false) }) }
        catch { finish(false) }
      })
    } catch { finish(false) }
  })
}
