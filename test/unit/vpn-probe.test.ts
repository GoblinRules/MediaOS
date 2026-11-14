import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { probe, type ProbeSocket } from '../../src/main/vpn/probe'

function socket() {
  const emitter = new EventEmitter()
  const bind = vi.fn((_opts: { address: string; port: number }, cb: () => void) => cb())
  const send = vi.fn((_data: Buffer, _port: number, _address: string, cb: (error: Error | null) => void) => cb(null))
  const close = vi.fn()
  return { emitter, bind, send, close, socket: Object.assign(emitter, { bind, send, close }) as ProbeSocket }
}
afterEach(() => vi.useRealTimers())
describe('VPN DNS probe', () => {
  it.each([0, 3, 5])('accepts a matching response with RCODE %i and binds/sends the exact query', async (rcode) => {
    const f = socket(), result = probe('10.64.0.2', '10.64.0.1', 3000, { socket: () => f.socket, id: () => 0x1234 })
    expect(f.bind).toHaveBeenCalledWith({ address: '10.64.0.2', port: 0 }, expect.any(Function))
    expect(f.send.mock.calls[0]?.slice(1, 3)).toEqual([53, '10.64.0.1'])
    const query = f.send.mock.calls[0]![0]
    expect(query.toString('hex')).toBe('123401000001000000000000076578616d706c6503636f6d0000010001')
    const reply = Buffer.from(query); reply[2] = 0x81; reply[3] = 0x80 | rcode
    f.emitter.emit('message', reply); expect(await result).toBe(true); expect(f.close).toHaveBeenCalledOnce()
  })
  it('ignores wrong ids, queries and short packets, then times out and closes', async () => {
    vi.useFakeTimers()
    const f = socket(), result = probe('10.64.0.2', null, 3000, { socket: () => f.socket, id: () => 0x1234 })
    const query = f.send.mock.calls[0]![0], wrong = Buffer.from(query); wrong[2] = 0x81; wrong[0] = 0
    f.emitter.emit('message', wrong); f.emitter.emit('message', query); f.emitter.emit('message', Buffer.from([1, 2]))
    await vi.advanceTimersByTimeAsync(2999); expect(f.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(false); expect(f.close).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]![2]).toBe('9.9.9.9')
  })
  it.each(['bind', 'send', 'socket'] as const)('closes on %s error', async (step) => {
    const f = socket()
    if (step === 'bind') f.bind.mockImplementation(() => { throw new Error('bind failed') })
    if (step === 'send') f.send.mockImplementation((_data, _port, _address, cb) => cb(new Error('send failed')))
    const result = probe('10.64.0.2', null, 3000, { socket: () => f.socket })
    if (step === 'socket') f.emitter.emit('error', new Error('socket failed'))
    expect(await result).toBe(false); expect(f.close).toHaveBeenCalledOnce()
  })
  it('handles factory failure', async () => {
    expect(await probe('10.64.0.2', null, 3000, { socket: () => { throw new Error('failed') } })).toBe(false)
  })
})
