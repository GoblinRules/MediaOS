import { createSocket } from 'node:dgram'
import type { DiscoveredServer } from '@shared/ipc-contract'
import { runtime, type Runtime } from '../../core/runtime'
import { normaliseAddress } from './JellyfinClient'
import { object } from './guards'

export interface DiscoverySocket {
  on(event: 'message', listener: (message: Buffer) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  bind(port: number, callback: () => void): void
  setBroadcast(flag: boolean): void
  send(message: string, port: number, address: string, callback: (error: Error | null) => void): void
  close(): void
}
export interface DiscoveryOptions { socketFactory?: () => DiscoverySocket; timeoutMs?: number; clock?: Runtime; signal?: AbortSignal }

export function discoverJellyfin(opts: DiscoveryOptions = {}): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const clock = opts.clock ?? runtime
    const found = new Map<string, DiscoveredServer>()
    let socket: DiscoverySocket | undefined
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (done) return
      done = true
      if (timer !== undefined) clock.clearTimeout(timer)
      opts.signal?.removeEventListener('abort', finish)
      try { socket?.close() } catch { /* A bind failure can leave a socket already closed. */ }
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)))
    }
    if (opts.signal?.aborted) { finish(); return }
    opts.signal?.addEventListener('abort', finish, { once: true })
    try {
      socket = (opts.socketFactory ?? (() => createSocket('udp4')))()
      socket.on('error', finish)
      socket.on('message', (message) => {
        if (done || message.byteLength > 4096 || found.size >= 32) return
        try {
          const raw = object(JSON.parse(message.toString('utf8')))
          if (!raw || typeof raw.Id !== 'string' || !raw.Id || typeof raw.Name !== 'string' ||
            typeof raw.Address !== 'string' || raw.Address.length > 2048 || !/^https?:\/\//i.test(raw.Address) ||
            found.has(raw.Id)) return
          found.set(raw.Id, { id: raw.Id, name: raw.Name.slice(0, 80), url: normaliseAddress(raw.Address) })
        } catch { /* Ignore unrelated UDP traffic. */ }
      })
      timer = clock.setTimeout(finish, opts.timeoutMs ?? 2500)
      socket.bind(0, () => {
        if (done) return
        try {
          socket!.setBroadcast(true)
          socket!.send('Who is JellyfinServer?', 7359, '255.255.255.255', (error) => { if (error) finish() })
        } catch { finish() }
      })
    } catch { finish() }
  })
}
