import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTLE_MS, SwayWindowKeeper } from '../../src/main/system/linux/sway-windows'
import { silentLog } from '../../src/main/log/Logger'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  kill = vi.fn(() => true)
}

function setup(fail = () => false) {
  const children: FakeChild[] = []
  const calls: string[] = []
  const warn = vi.fn()
  const keeper = new SwayWindowKeeper({
    logger: { ...silentLog, warn },
    exec: async (args) => { calls.push(args.join(' ')); if (fail()) throw new Error('No matching node.') },
    spawn: () => { const child = new FakeChild(); children.push(child); return child as never },
  })
  keeper.start()
  const send = async (event: unknown) => {
    children.at(-1)!.stdout.write(`${JSON.stringify(event)}\n`)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { keeper, children, calls, warn, send }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('sway window keeper', () => {
  it('switches a new window full screen off, then on again once it has opened', async () => {
    const { calls, send } = setup()
    await send({ change: 'new', container: { id: 42 } })
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(calls).toEqual(['[con_id=42] fullscreen disable'])
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['[con_id=42] fullscreen disable', '[con_id=42] fullscreen enable'])
  })

  it('makes the window left in front full screen when one closes, and ignores other events and bad ids', async () => {
    const { calls, send } = setup()
    await send({ change: 'close', container: { id: 42 } })
    await send({ change: 'focus', container: { id: 7 } })
    await send({ change: 'new', container: { id: '7]; exec rm' } })
    await send({ change: 'new', container: { id: -1 } })
    await send(null)
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 3)
    expect(calls).toEqual(['[tiling con_id=__focused__] fullscreen enable'])
  })

  it('still tries the enable half when the window went away meanwhile, and logs nothing for a refused command', async () => {
    const { calls, warn, send } = setup(() => true)
    await send({ change: 'new', container: { id: 9 } })
    await send({ change: 'close', container: { id: 9 } })
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 3)
    expect(calls).toEqual(['[con_id=9] fullscreen disable', '[tiling con_id=__focused__] fullscreen enable',
      '[con_id=9] fullscreen enable'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('stops quietly when sway is missing', async () => {
    const { children, warn } = setup()
    children[0]!.emit('error', Object.assign(new Error('spawn swaymsg ENOENT'), { code: 'ENOENT' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(children).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('listens again with a growing wait when the event stream ends, and resets after an event', async () => {
    const { children, send } = setup()
    children[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(999)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(children).toHaveLength(2)
    children[1]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(children).toHaveLength(3)
    await send({ change: 'focus', container: { id: 1 } })
    children[2]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(4)
  })

  it('warns once while sway keeps refusing, and again only after it has answered in between', async () => {
    const { children, warn, send } = setup()
    for (let i = 0; i < 4; i++) {
      children.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(30_000)
    }
    expect(children).toHaveLength(5)
    expect(warn).toHaveBeenCalledTimes(1)
    await send({ change: 'focus', container: { id: 1 } })
    children.at(-1)!.emit('exit', 1)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('does nothing after dispose: no pending commands, no restart', async () => {
    const { keeper, children, calls, send } = setup()
    await send({ change: 'new', container: { id: 5 } })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    keeper.dispose()
    expect(children[0]!.kill).toHaveBeenCalled()
    children[0]!.emit('exit', null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toEqual(['[con_id=5] fullscreen disable'])
    expect(children).toHaveLength(1)
  })
})
