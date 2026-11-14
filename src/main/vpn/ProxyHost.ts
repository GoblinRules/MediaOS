import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { runtime, type Runtime } from '../core/runtime'
import { atomicWrite, type FileSystem } from '../settings/atomic'
import { silentLog, type Log } from '../log/Logger'
import { childMessage, parentMessage, type ParentMessage } from './proxy/messages'

export interface ChildLike {
  postMessage(message: ParentMessage): void
  on(event: 'message', cb: (message: unknown) => void): this
  on(event: 'exit', cb: (code: number) => void): this
  kill(): void
}
export interface ProxyHostOptions {
  scriptPath: string; runtimeDir: string | null; uid: number | null
  fork?: (path: string) => ChildLike | Promise<ChildLike>
  clock?: Runtime; fs?: FileSystem; logger?: Log
}
const defaultFork = async (path: string): Promise<ChildLike> => {
  const { utilityProcess } = await import('electron')
  return utilityProcess.fork(path, [], { serviceName: 'MediaOS VPN proxy', stdio: 'ignore' })
}
const failure = (code: string): Error => Object.assign(new Error(code), { code })

export class ProxyHost {
  private readonly clock: Runtime
  private readonly io: FileSystem
  private readonly logger: Log
  private child: ChildLike | null = null
  private currentPort: number | null = null
  private restartPort = 0
  private writes: Promise<void> = Promise.resolve()
  private tunnel: ParentMessage = { type: 'tunnel', tunIp: null, dns: null }
  private callbacks = new Set<(port: number | null) => void>()
  private restarts: number[] = []
  private running = false
  private starting: Promise<void> | null = null
  private generation = 0
  private work: Promise<void> = Promise.resolve()
  private stopping: Promise<void> | null = null
  private cancelAttempt?: () => void
  private cancelDelay?: () => void

  constructor(private options: ProxyHostOptions) {
    this.clock = options.clock ?? runtime; this.io = options.fs ?? fs; this.logger = options.logger ?? silentLog
  }
  port(): number | null { return this.currentPort }
  onPort(cb: (port: number | null) => void): () => void { this.callbacks.add(cb); return () => this.callbacks.delete(cb) }
  setTunnel(tunIp: string | null, dns: string | null): void {
    const parsed = parentMessage.parse({ type: 'tunnel', tunIp, dns })
    this.tunnel = parsed
    if (this.child) this.send(this.child, parsed)
  }

  start(): Promise<void> {
    if (this.running) return this.starting ?? Promise.resolve()
    const generation = ++this.generation
    this.running = true; this.restarts = []
    const stopping = this.stopping, previous = this.work
    const job = (async () => {
      await stopping
      await previous
      if (!this.active(generation)) return
      let port = 0
      const file = this.file()
      if (file) {
        const text = await this.io.readFile(file, 'utf8').catch(() => '')
        if (!this.active(generation)) return
        if (/^\d+\n?$/.test(text) && Number(text) > 0 && Number(text) <= 65535) port = Number(text)
      }
      try { await this.launch(port, false, generation) }
      catch (error) {
        if (!this.active(generation)) return
        this.giveUp(generation); throw error
      }
    })()
    const starting = job.finally(() => { if (this.starting === starting) this.starting = null })
    this.starting = starting
    this.work = starting.catch(() => undefined)
    return starting
  }

  stop(): Promise<void> {
    ++this.generation
    this.running = false; this.cancelDelay?.(); this.cancelAttempt?.()
    const child = this.child, previous = this.work, stopping = this.stopping
    this.child = null; this.updatePort(null)
    const ended = child ? this.stopChild(child) : Promise.resolve()
    // A pending fork is part of work: its stale result is killed before stop can finish.
    const job = Promise.all([previous, stopping, ended, this.writes]).then(() => undefined)
    const stopped = job.finally(() => { if (this.stopping === stopped) this.stopping = null })
    this.stopping = stopped
    return stopped
  }

  private active(generation: number): boolean { return this.running && generation === this.generation }
  private stopChild(child: ChildLike): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { this.clock.clearTimeout(timer); resolve() }
      const timer = this.clock.setTimeout(() => { child.kill(); done() }, 2000)
      child.on('exit', done)
      try { this.send(child, { type: 'stop' }) } catch { child.kill(); done() }
    })
  }

  private file(): string | null {
    return this.options.runtimeDir === null ? null : join(this.options.runtimeDir, 'mediaos', 'vpn-proxy.port')
  }
  private send(child: ChildLike, message: ParentMessage): void {
    const parsed = parentMessage.safeParse(message)
    if (parsed.success) child.postMessage(parsed.data)
  }
  private updatePort(port: number | null): void {
    if (port === this.currentPort) return
    this.currentPort = port
    for (const cb of this.callbacks) cb(port)
  }
  private giveUp(generation: number): void {
    if (!this.active(generation)) return
    this.running = false
    const child = this.child; this.child = null; child?.kill()
    this.updatePort(null); this.logger.error('VPN_PROXY_UNAVAILABLE')
  }
  private restart(generation: number, delay = 0): void {
    if (!this.active(generation)) return
    const previous = this.work
    this.work = previous.then(async () => {
      if (!this.active(generation)) return
      if (delay) await this.wait(delay, generation)
      if (!this.active(generation)) return
      const now = this.clock.now()
      this.restarts = this.restarts.filter((time) => now - time < 60_000)
      this.restarts.push(now)
      if (this.restarts.length > 5) { this.giveUp(generation); return }
      try { await this.launch(this.restartPort, true, generation) }
      catch { this.restart(generation, 500) }
    }).catch(() => { this.giveUp(generation) })
  }
  private wait(ms: number, generation: number): Promise<void> {
    if (!this.active(generation)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.cancelDelay === cancel) this.cancelDelay = undefined
        resolve()
      }
      const timer = this.clock.setTimeout(done, ms)
      const cancel = (): void => { this.clock.clearTimeout(timer); done() }
      this.cancelDelay = cancel
    })
  }
  private async launch(preferred: number, restarting: boolean, generation: number): Promise<void> {
    const deadline = this.clock.now() + 5000
    let requested = preferred
    while (this.active(generation)) {
      let active: ChildLike | undefined
      try {
        const result = await this.attempt(requested, generation)
        active = result.child
        await this.persist(result.port, active, generation)
        return
      } catch (error) {
        if (!this.active(generation) || (active && this.child !== active)) return
        if (active) { this.child = null; active.kill() }
        const code = error instanceof Error && 'code' in error ? error.code : ''
        if (code !== 'EADDRINUSE' || !requested) throw error
        if (!restarting || this.clock.now() >= deadline) { requested = 0; continue }
        await this.wait(Math.min(500, deadline - this.clock.now()), generation)
      }
    }
  }

  private persist(port: number, child: ChildLike, generation: number): Promise<void> {
    const job = this.writes.then(async () => {
      if (!this.active(generation) || this.child !== child) return
      const file = this.file()
      if (file) {
        const folder = join(this.options.runtimeDir!, 'mediaos')
        await this.io.mkdir(folder, { recursive: true, mode: 0o700 })
        if (!this.active(generation) || this.child !== child) return
        await this.io.chmod(folder, 0o700)
        if (!this.active(generation) || this.child !== child) return
        await atomicWrite(file, `${port}\n`, 0o600, this.io)
      }
      if (this.active(generation) && this.child === child) this.updatePort(port)
    })
    this.writes = job.catch(() => undefined)
    return job
  }

  private async attempt(port: number, generation: number): Promise<{ port: number; child: ChildLike }> {
    const child = await (this.options.fork ?? defaultFork)(this.options.scriptPath)
    if (!this.active(generation)) { child.kill(); throw failure('STOPPED') }
    this.child = child
    return new Promise((resolve, reject) => {
      let ready = false, settled = false, exited = false
      const finish = (error?: Error, value?: number): void => {
        if (settled) return
        settled = true; this.clock.clearTimeout(timer)
        if (this.cancelAttempt === cancel) this.cancelAttempt = undefined
        if (error) {
          if (this.child === child) this.child = null
          if (!exited) child.kill()
          reject(error)
        } else { ready = true; this.restartPort = value!; resolve({ port: value!, child }) }
      }
      const timer = this.clock.setTimeout(() => finish(failure('START_TIMEOUT')), 5000)
      const cancel = (): void => finish(failure('STOPPED'))
      this.cancelAttempt = cancel
      child.on('message', (raw) => {
        const parsed = childMessage.safeParse(raw)
        if (!parsed.success || !this.active(generation) || this.child !== child) return
        if (parsed.data.type === 'listening') finish(undefined, parsed.data.port)
        else if (!ready) finish(failure(parsed.data.code))
      })
      child.on('exit', () => {
        exited = true
        if (!this.active(generation) || this.child !== child) return
        this.child = null
        if (!ready) finish(failure('CHILD_EXIT'))
        // Keep the port during a same-port restart so open apps recover; connections fail closed in the gap.
        else this.restart(generation)
      })
      try {
        this.send(child, { type: 'start', port, uid: this.options.uid })
        if (this.active(generation) && this.child === child) this.send(child, this.tunnel)
      } catch { finish(failure('SEND_FAILED')) }
    })
  }
}
