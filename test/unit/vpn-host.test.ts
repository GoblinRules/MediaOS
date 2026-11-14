import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProxyHost, type ChildLike, type ProxyHostOptions } from '../../src/main/vpn/ProxyHost'
import { silentLog } from '../../src/main/log/Logger'
import type { ParentMessage } from '../../src/main/vpn/proxy/messages'
import { temporary, until } from './helpers'

class Child extends EventEmitter implements ChildLike {
  messages: ParentMessage[] = []
  killed = 0
  stubborn = false
  constructor(private answer: (child: Child, message: ParentMessage) => void) { super() }
  postMessage(message: ParentMessage): void {
    this.messages.push(message)
    queueMicrotask(() => {
      if (message.type === 'stop' && !this.stubborn) this.emit('exit', 0)
      else this.answer(this, message)
    })
  }
  kill(): void { this.killed++; this.emit('exit', 1) }
  crash(): void { this.emit('exit', 1) }
}
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})
function setup(options: Partial<ProxyHostOptions> = {}, answer?: (child: Child, message: ParentMessage) => void) {
  const children: Child[] = []
  const logger = { ...silentLog, error: vi.fn() }
  const fork = vi.fn(() => {
    const child = new Child(answer ?? ((child, message) => {
      if (message.type === 'start') child.emit('message', { type: 'listening', port: message.port || 41001 })
    }))
    children.push(child); return child
  })
  const host = new ProxyHost({ scriptPath: 'vpn-proxy.js', runtimeDir: null, uid: 1000, fork, logger, ...options })
  disposals.push(() => host.stop())
  return { host, children, fork, logger }
}
describe('proxy process host', () => {
  it('starts once, validates child messages and announces port changes', async () => {
    const h = setup({}, () => {}), changed = vi.fn()
    h.host.onPort(changed)
    const start = h.host.start()
    expect(h.host.start()).toBe(start)
    await until(() => h.children.length === 1)
    const child = h.children[0]!
    child.emit('message', { type: 'listening', port: -1 }); child.emit('message', { type: 'error', code: 'unsafe message' })
    expect(h.host.port()).toBeNull()
    child.emit('message', { type: 'listening', port: 41001 })
    await start
    expect(h.host.port()).toBe(41001); expect(changed).toHaveBeenCalledExactlyOnceWith(41001)
    await h.host.start(); expect(h.fork).toHaveBeenCalledTimes(1)
  })
  it('restarts on the same port and re-sends the tunnel', async () => {
    const h = setup(), changed = vi.fn(); h.host.onPort(changed)
    h.host.setTunnel('10.14.0.2', '1.1.1.1'); await h.host.start()
    h.children[0]!.crash(); await until(() => h.children.length === 2 && h.children[1]!.messages.length === 2)
    expect(h.children[1]!.messages).toEqual([{ type: 'start', port: 41001, uid: 1000 },
      { type: 'tunnel', tunIp: '10.14.0.2', dns: '1.1.1.1' }])
    expect(changed).toHaveBeenCalledTimes(1)
    h.host.setTunnel(null, null)
    expect(h.children[1]!.messages.at(-1)).toEqual({ type: 'tunnel', tunIp: null, dns: null })
  })
  it('retains a reported port even if the child crashes before the start promise settles', async () => {
    let first = true
    const h = setup({}, (child, message) => {
      if (message.type !== 'start') return
      child.emit('message', { type: 'listening', port: message.port || 41001 })
      if (first) { first = false; child.crash() }
    })
    await h.host.start(); await until(() => h.host.port() === 41001)
    expect(h.children).toHaveLength(2)
    expect(h.children[1]!.messages[0]).toMatchObject({ port: 41001 })
  })
  it('retries a busy restart port every 500 ms for 5 seconds then falls back', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let initial = true
    const h = setup({}, (child, message) => {
      if (message.type !== 'start') return
      if (!initial && message.port) child.emit('message', { type: 'error', code: 'EADDRINUSE' })
      else { child.emit('message', { type: 'listening', port: initial ? 41001 : 41002 }); initial = false }
    })
    const changed = vi.fn(); h.host.onPort(changed); await h.host.start()
    h.children[0]!.crash()
    await until(() => h.children.length === 2 && h.children[1]!.killed === 1)
    for (let n = 0; n < 10; n++) await vi.advanceTimersByTimeAsync(500)
    await until(() => h.host.port() === 41002)
    expect(h.children).toHaveLength(13)
    for (const child of h.children.slice(1, -1)) expect(child.messages[0]).toMatchObject({ port: 41001 })
    expect(h.children.at(-1)!.messages[0]).toMatchObject({ port: 0 })
    expect(changed.mock.calls).toEqual([[41001], [41002]])
  })
  it('gives up after five restarts in a minute, logging once', async () => {
    const h = setup(); await h.host.start()
    for (let n = 0; n < 5; n++) {
      h.children.at(-1)!.crash(); await until(() => h.children.length === n + 2)
      await until(() => h.children.at(-1)!.messages.length === 2)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    h.children.at(-1)!.crash(); await until(() => h.host.port() === null)
    expect(h.children).toHaveLength(6); expect(h.logger.error).toHaveBeenCalledExactlyOnceWith('VPN_PROXY_UNAVAILABLE')
  })
  it('expires old restart counts after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = setup(); await h.host.start()
    for (let n = 0; n < 7; n++) {
      await vi.advanceTimersByTimeAsync(60_001)
      h.children.at(-1)!.crash(); await until(() => h.children.length === n + 2)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(h.host.port()).toBe(41001); expect(h.logger.error).not.toHaveBeenCalled()
  })
  it('limits start to five seconds and stops a child which does not answer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = setup({}, () => {}), pending = h.host.start()
    const failed = expect(pending).rejects.toThrow('START_TIMEOUT')
    await until(() => h.children.length === 1)
    await vi.advanceTimersByTimeAsync(5000); await failed
    expect(h.children[0]!.killed).toBe(1); expect(h.host.port()).toBeNull()
  })
  it('sends stop then kills an unresponsive child after two seconds without restarting', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const h = setup(); await h.host.start(); h.children[0]!.stubborn = true
    const stopped = h.host.stop()
    expect(h.children[0]!.messages.at(-1)).toEqual({ type: 'stop' })
    await vi.advanceTimersByTimeAsync(1999); expect(h.children[0]!.killed).toBe(0)
    await vi.advanceTimersByTimeAsync(1); await stopped
    expect(h.children[0]!.killed).toBe(1); expect(h.children).toHaveLength(1); expect(h.host.port()).toBeNull()
  })
  it('does not restart a child after a clean stop', async () => {
    const h = setup(); await h.host.start(); await h.host.stop()
    expect(h.children[0]!.killed).toBe(0); expect(h.children).toHaveLength(1)
  })
  it('gives up on other startup errors and on fork errors', async () => {
    const h = setup({}, (child, message) => {
      if (message.type === 'start') child.emit('message', { type: 'error', code: 'EACCES' })
    })
    await expect(h.host.start()).rejects.toThrow('EACCES')
    expect(h.host.port()).toBeNull(); expect(h.children[0]!.killed).toBe(1)
    expect(h.logger.error).toHaveBeenCalledTimes(1)
    const rejected = setup({ fork: () => { throw new Error('Cannot fork') } })
    await expect(rejected.host.start()).rejects.toThrow('Cannot fork')
    expect(rejected.host.port()).toBeNull()
  })
  it('removes pending restart delays on stop', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let ready = false
    const h = setup({}, (child, message) => {
      if (message.type !== 'start') return
      child.emit('message', ready ? { type: 'error', code: 'EADDRINUSE' } : { type: 'listening', port: 41001 })
      ready = true
    })
    await h.host.start(); h.children[0]!.crash()
    await until(() => h.children.length === 2 && h.children[1]!.killed === 1)
    await h.host.stop(); await vi.advanceTimersByTimeAsync(10_000)
    expect(h.children).toHaveLength(2)
  })
  it('rejects invalid parent tunnel data before sending', async () => {
    const h = setup(); await h.host.start()
    expect(() => h.host.setTunnel('hostname', null)).toThrow()
    expect(h.children[0]!.messages).toHaveLength(2)
  })
  it('reuses a valid persisted port and writes the selected port atomically', async () => {
    const temp = await temporary(); disposals.push(() => temp.dispose())
    const folder = join(temp.dir, 'mediaos'), file = join(folder, 'vpn-proxy.port')
    await mkdir(folder); await chmod(folder, 0o755); await writeFile(file, '42000\n', 'utf8')
    const h = setup({ runtimeDir: temp.dir }); await h.host.start()
    expect(h.children[0]!.messages[0]).toEqual({ type: 'start', port: 42000, uid: 1000 })
    expect(await readFile(file, 'utf8')).toBe('42000\n')
    await expect(stat(`${file}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      expect((await stat(folder)).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })
  it.each(['garbage', '0', '-1', '65536', '1.5'])('ignores invalid port file %s', async (content) => {
    const temp = await temporary(); disposals.push(() => temp.dispose())
    await mkdir(join(temp.dir, 'mediaos')); await writeFile(join(temp.dir, 'mediaos', 'vpn-proxy.port'), content, 'utf8')
    const h = setup({ runtimeDir: temp.dir }); await h.host.start()
    expect(h.children[0]!.messages[0]).toMatchObject({ port: 0 })
  })
})
