import { connect, type Socket } from 'node:net'
import { runtime, type Runtime } from '../../core/runtime'

export interface MpvEvent { event: string; name?: string; data?: unknown; reason?: string; [key: string]: unknown }
export interface TransportOptions { timeoutMs?: number; clock?: Runtime; connect?: (path: string) => Socket }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class MpvTransport {
  private socket?: Socket
  private opening?: Promise<void>
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(event: MpvEvent) => void>()
  private buffer = ''
  private clock: Runtime

  constructor(readonly path: string, private opts: TransportOptions = {}) { this.clock = opts.clock ?? runtime }
  connect(): Promise<void> {
    if (this.opening) return this.opening
    if (this.socket && !this.socket.destroyed) return Promise.resolve()
    this.buffer = ''
    const socket = (this.opts.connect ?? connect)(this.path)
    this.socket = socket
    socket.setEncoding('utf8')
    const opening = new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        reject(new Error('mpv connection timed out')); socket.destroy()
      }, this.opts.timeoutMs ?? 5000)
      const failed = (error: Error) => { this.clock.clearTimeout(timer); reject(error) }
      socket.once('error', failed)
      socket.once('close', () => failed(new Error('mpv connection closed')))
      socket.once('connect', () => { this.clock.clearTimeout(timer); resolve() })
    })
    socket.on('error', () => this.rejectPending(new Error('mpv connection failed')))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.rejectPending(new Error('mpv connection closed'))
      for (const cb of this.listeners) cb({ event: 'disconnected' })
    })
    socket.on('data', (data: string) => this.receive(data))
    this.opening = opening.finally(() => { this.opening = undefined })
    return this.opening
  }
  async request(command: readonly unknown[]): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed || socket.connecting) throw new Error('mpv is not connected')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pending.delete(id); reject(new Error('mpv request timed out'))
      }, this.opts.timeoutMs ?? 5000)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ command, request_id: id })}\n`, (error) => {
        if (error) this.finish(id, undefined, error)
      })
    })
  }
  observe(name: string, id: number): Promise<unknown> { return this.request(['observe_property', id, name]) }
  onEvent(cb: (event: MpvEvent) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private receive(data: string): void {
    this.buffer += data
    if (this.buffer.length > 8 * 1024 * 1024) { this.close(); return }
    let end: number
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let msg: Record<string, unknown>
      try {
        const raw: unknown = JSON.parse(line)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        msg = raw as Record<string, unknown>
      } catch { continue }
      if (typeof msg.request_id === 'number') this.finish(msg.request_id, msg.data,
        msg.error !== 'success' && msg.error !== undefined ? new Error(`mpv: ${String(msg.error)}`) : undefined)
      else if (typeof msg.event === 'string') for (const cb of this.listeners) cb(msg as MpvEvent)
    }
  }
  private finish(id: number, value: unknown, error?: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    this.clock.clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }
  private rejectPending(error: Error): void { for (const id of this.pending.keys()) this.finish(id, undefined, error) }
  close(): void {
    const socket = this.socket
    this.socket = undefined
    this.rejectPending(new Error('mpv connection closed'))
    socket?.destroy()
    if (socket) for (const cb of this.listeners) cb({ event: 'disconnected' })
  }
  dispose(): void { this.close(); this.listeners.clear() }
}
