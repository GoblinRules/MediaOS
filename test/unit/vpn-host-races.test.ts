import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { ProxyHost, type ChildLike, type ProxyHostOptions } from '../../src/main/vpn/ProxyHost'
import type { ParentMessage } from '../../src/main/vpn/proxy/messages'
import { silentLog } from '../../src/main/log/Logger'
import { deferred, temporary, until } from './helpers'

class Child extends EventEmitter implements ChildLike {
  live = true
  killed = 0
  messages: ParentMessage[] = []
  constructor(private answer: (child: Child, message: ParentMessage) => void) {
    super(); this.on('exit', () => { this.live = false })
  }
  postMessage(message: ParentMessage): void { this.messages.push(message); this.answer(this, message) }
  kill(): void { this.live = false; this.killed++ } // Exit notification may arrive much later than kill().
  exit(): void { this.emit('exit', 1) }
  listening(port = 41001): void { this.emit('message', { type: 'listening', port }) }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})
function setup(options: Partial<ProxyHostOptions> = {}, answer = (child: Child, message: ParentMessage): void => {
  if (message.type === 'start') queueMicrotask(() => child.listening(message.port || 41001))
  if (message.type === 'stop') queueMicrotask(() => child.exit())
}, deferredFork = false) {
  const children: Child[] = [], pending: ReturnType<typeof deferred<ChildLike>>[] = []
  let maxLive = 0
  const fork = vi.fn(() => {
    if (deferredFork) { const result = deferred<ChildLike>(); pending.push(result); return result.promise }
    return create()
  })
  const create = (): Child => {
    const child = new Child(answer); children.push(child)
    maxLive = Math.max(maxLive, children.filter((item) => item.live).length)
    expect(maxLive).toBeLessThanOrEqual(1)
    return child
  }
  const logger = { ...silentLog, error: vi.fn() }
  const host = new ProxyHost({ scriptPath: 'proxy', runtimeDir: null, uid: null, fork, logger, ...options })
  cleanups.push(async () => { await host.stop(); expect(maxLive).toBeLessThanOrEqual(1) })
  return { host, children, pending, create, fork, logger, maxLive: () => maxLive }
}
describe('proxy host lifecycle races', () => {
  it('waits for a pending fork during stop and kills its stale result', async () => {
    const h = setup({}, undefined, true), start = h.host.start()
    await until(() => h.pending.length === 1)
    let done = false
    const stop = h.host.stop().then(() => { done = true })
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(done).toBe(false)
    const child = h.create(); h.pending[0]!.resolve(child)
    await Promise.all([start, stop])
    expect(child.killed).toBe(1); expect(child.messages).toEqual([])
    expect(h.host.port()).toBeNull(); expect(h.logger.error).not.toHaveBeenCalled()
  })
  it('waits for stop before starting again while an old fork is pending', async () => {
    const h = setup({}, undefined, true), start = h.host.start()
    await until(() => h.pending.length === 1)
    const stop = h.host.stop(), next = h.host.start()
    await new Promise<void>((resolve) => setImmediate(resolve)); expect(h.fork).toHaveBeenCalledTimes(1)
    const old = h.create(); h.pending[0]!.resolve(old)
    await Promise.all([start, stop]); await until(() => h.pending.length === 2)
    expect(old.killed).toBe(1)
    old.listening(49999); old.exit()
    const child = h.create(); h.pending[1]!.resolve(child); await next
    expect(h.host.port()).toBe(41001); expect(h.maxLive()).toBe(1)
  })
  it('waits for an asynchronous child exit during stop before forking again', async () => {
    const h = setup({}, (child, message) => { if (message.type === 'start') queueMicrotask(() => child.listening()) })
    await h.host.start()
    let done = false
    const stop = h.host.stop().then(() => { done = true }), next = h.host.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(done).toBe(false); expect(h.fork).toHaveBeenCalledTimes(1)
    h.children[0]!.exit(); await stop; await next
    expect(h.children).toHaveLength(2); expect(h.children[0]!.killed).toBe(0)
    // Explicitly finish the final stop too: this fake never answers stop automatically.
    const final = h.host.stop(); h.children[1]!.exit(); await final
  })
  it('ignores late listening and exit events from a killed child after restarting', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let attempts = 0
    const h = setup({}, (child, message) => {
      if (message.type === 'stop') { queueMicrotask(() => child.exit()); return }
      if (message.type !== 'start') return
      const attempt = ++attempts
      queueMicrotask(() => {
        if (attempt === 2) child.emit('message', { type: 'error', code: 'EADDRINUSE' })
        else child.listening()
      })
    })
    await h.host.start(); h.children[0]!.exit()
    await until(() => h.children.length === 2 && h.children[1]!.killed === 1)
    await vi.advanceTimersByTimeAsync(500)
    await until(() => h.children.length === 3 && h.children[2]!.messages.length === 2)
    const old = h.children[1]!, changed = vi.fn(); h.host.onPort(changed)
    old.listening(49999); old.exit()
    expect(h.host.port()).toBe(41001); expect(h.fork).toHaveBeenCalledTimes(3); expect(changed).not.toHaveBeenCalled()
  })
  it('keeps the port throughout a restart gap and ignores the old live-cycle handlers', async () => {
    const h = setup({}, undefined, true), changed = vi.fn(); h.host.onPort(changed)
    const start = h.host.start(); await until(() => h.pending.length === 1)
    const old = h.create(); h.pending[0]!.resolve(old); await start
    old.exit(); await until(() => h.pending.length === 2)
    expect(h.host.port()).toBe(41001)
    old.listening(49999); old.exit(); expect(h.fork).toHaveBeenCalledTimes(2)
    h.pending[1]!.resolve(h.create()); await until(() => h.children[1]!.messages.length === 2)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.host.port()).toBe(41001); expect(changed.mock.calls).toEqual([[41001]])
  })
  it('does not persist a stale generation after an awaited directory creation', async () => {
    const gate = deferred<void>(), mkdir = vi.fn(async () => { await gate.promise; return undefined })
    const chmod = vi.fn(), open = vi.fn()
    const h = setup({ runtimeDir: 'runtime', fs: { ...fs, mkdir, chmod, open } })
    const start = h.host.start(); await until(() => mkdir.mock.calls.length === 1)
    const stop = h.host.stop(); gate.resolve(); await Promise.all([start, stop])
    expect(chmod).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(h.host.port()).toBeNull()
  })
  it('kills a child whose port cannot be persisted before retrying the restart', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const temp = await temporary(); cleanups.push(() => temp.dispose())
    let broken = false
    const chmod: typeof fs.chmod = async (path, mode) => {
      if (broken) throw new Error('Cannot persist')
      await fs.chmod(path, mode)
    }
    const h = setup({ runtimeDir: temp.dir, fs: { ...fs, chmod } })
    await h.host.start(); broken = true; h.children[0]!.exit()
    await until(() => h.children.length === 2 && h.children[1]!.killed === 1)
    broken = false; await vi.advanceTimersByTimeAsync(500)
    await until(() => h.children.length === 3 && h.children[2]!.messages.length === 2)
    expect(h.maxLive()).toBe(1); expect(h.logger.error).not.toHaveBeenCalled()
  })
  it('retries failed launches every 500 ms and gives up on the sixth restart, logging once', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let initial = true
    const h = setup({}, (child, message) => {
      if (message.type !== 'start') return
      queueMicrotask(() => {
        if (initial) { initial = false; child.listening() }
        else child.exit()
      })
    })
    await h.host.start(); h.children[0]!.exit()
    await until(() => h.children.length === 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.host.port()).toBe(41001); expect(h.logger.error).not.toHaveBeenCalled()
    for (let n = 0; n < 4; n++) {
      await vi.advanceTimersByTimeAsync(499); expect(h.children).toHaveLength(n + 2)
      await vi.advanceTimersByTimeAsync(1); expect(h.children).toHaveLength(n + 3)
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(h.children).toHaveLength(6); expect(h.host.port()).toBeNull()
    expect(h.logger.error).toHaveBeenCalledExactlyOnceWith('VPN_PROXY_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(60_000); expect(h.children).toHaveLength(6)
  })
})
