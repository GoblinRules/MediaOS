import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { MpvEvent } from '../../src/main/player/mpv/MpvTransport'

export interface RecordedCommand { command: unknown[]; request_id: number }
export class FakeMpv {
  readonly path = process.platform === 'win32' ? `\\\\.\\pipe\\mediaos-test-${randomUUID()}` : join(tmpdir(), `mpv-${randomUUID()}.sock`)
  readonly commands: RecordedCommand[] = []
  readonly properties = new Map<string, unknown>([
    ['time-pos', 0], ['duration', 120], ['pause', false], ['paused-for-cache', false],
    ['track-list', [
      { id: 1, type: 'audio', title: 'English', codec: 'aac', selected: true },
      { id: 2, type: 'audio', lang: 'fra', selected: false },
      { id: 3, type: 'sub', title: 'English SDH', selected: false },
    ]],
  ])
  failLoads = 0
  autoReply = true
  private server?: Server
  private clients = new Set<Socket>()
  private observers = new Set<string>()

  async start(): Promise<void> {
    const server = createServer((socket) => {
      this.clients.add(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (text: string) => {
        buffer += text
        let end: number
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          const msg = JSON.parse(line) as RecordedCommand
          this.commands.push(msg)
          this.command(socket, msg)
        }
      })
      socket.on('error', () => undefined)
      socket.on('close', () => this.clients.delete(socket))
    })
    this.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve) })
  }
  private command(socket: Socket, msg: RecordedCommand): void {
    if (!this.autoReply || msg.command[0] === 'silence') return
    // Drop mpv's on-screen-display prefixes (osd-msg-bar seek ...) so the command itself is handled.
    const words = msg.command[0] === 'osd-msg-bar' || msg.command[0] === 'osd-msg' ? msg.command.slice(1) : msg.command
    const [name, ...args] = words
    let data: unknown = null
    if (name === 'get_property') data = this.properties.get(String(args[0]))
    this.reply(msg.request_id, data, socket)
    if (name === 'observe_property') {
      const prop = String(args[1]); this.observers.add(prop)
      this.send({ event: 'property-change', name: prop, data: this.properties.get(prop) })
    }
    if (name === 'set_property') this.property(String(args[0]), args[1])
    if (name === 'cycle' && args[0] === 'pause') this.property('pause', !this.properties.get('pause'))
    if (name === 'loadfile') {
      if (this.failLoads-- > 0) { this.send({ event: 'end-file', reason: 'error' }); return }
      const options = String(args[3] ?? '')
      this.property('time-pos', Number(options.split('start=')[1]) || 0)
      this.send({ event: 'file-loaded' })
      this.property('track-list', this.properties.get('track-list'))
    }
    if (name === 'seek') {
      const position = String(args[1]).startsWith('absolute') ? Number(args[0]) :
        Number(this.properties.get('time-pos')) + Number(args[0])
      this.property('time-pos', position)
    }
    if (name === 'stop') this.send({ event: 'end-file', reason: 'stop' })
    if (name === 'quit') socket.end()
  }
  reply(id: number, data: unknown, socket?: Socket): void {
    const text = `${JSON.stringify({ request_id: id, error: 'success', data })}\n`
    if (socket) socket.write(text)
    else for (const client of this.clients) client.write(text)
  }
  property(name: string, data: unknown): void {
    this.properties.set(name, data)
    if (this.observers.has(name)) this.send({ event: 'property-change', name, data })
  }
  send(event: MpvEvent): void { for (const client of this.clients) client.write(`${JSON.stringify(event)}\n`) }
  disconnect(): void { for (const client of this.clients) client.destroy() }
  async dispose(): Promise<void> {
    this.disconnect()
    await new Promise<void>((resolve) => { if (this.server?.listening) this.server.close(() => resolve()); else resolve() })
  }
}
