// The TV's local control line. On Linux, sway grabs the Home key (so it works even when Chrome or mpv has the keyboard)
// and runs `mediaos-ctl home-down` / `home-up`, which send one line to this socket. Developers can also send
// `press <action>` over SSH to drive the screen. The socket lives in the user's private runtime folder (mode 0600).
import * as net from 'node:net'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ACTIONS, type Action } from '@shared/actions'
import { KeyTiming, type Timers } from '@shared/key-timing'
import { silentLog, type Log } from '../log/Logger'

export type ControlCommand =
  | { kind: 'home-down' } | { kind: 'home-up' } | { kind: 'recover' } | { kind: 'ping' }
  | { kind: 'press'; action: Action }

const MAX_LINE = 128
/** How long a Home release that arrived before its press is remembered. */
const EARLY_UP_MS = 300

/** One line of text to a command, or undefined when it isn't one we know. */
export function parseControl(line: string): ControlCommand | undefined {
  const words = line.trim().split(/\s+/)
  if (words.length === 1) {
    const [word] = words
    if (word === 'home-down' || word === 'home-up' || word === 'recover' || word === 'ping') return { kind: word }
    if (word === 'home' || word === 'back') return { kind: 'press', action: word }
    return undefined
  }
  if (words.length === 2 && words[0] === 'press' && (ACTIONS as readonly string[]).includes(words[1]!)) {
    return { kind: 'press', action: words[1] as Action }
  }
  return undefined
}

/**
 * Turns control commands into routed actions. Home down/up go through the same long-press timing as the remote:
 * a short press is Home, holding it for 1.5 s opens the Recovery menu.
 */
export class ControlCommands {
  private timing: KeyTiming
  private timers: Timers
  private homeHeld = false
  /** sway starts a separate process for the press and the release, so on a quick tap the release can arrive first. */
  private earlyUp: unknown
  constructor(private route: (action: Action, long: boolean) => Promise<void>, private logger: Log = silentLog, timers?: Timers) {
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
    this.timing = new KeyTiming((action, info) => this.send(action, info.long), this.timers)
  }
  handle(command: ControlCommand): void {
    if (command.kind === 'home-down') this.homeDown()
    else if (command.kind === 'home-up') this.homeUp()
    else if (command.kind === 'recover') { this.reset(); this.send('recovery', false) }
    else if (command.kind === 'press') { this.reset(); this.send(command.action, false) }
  }
  dispose(): void { this.reset() }
  private homeDown(): void {
    if (this.earlyUp !== undefined) {
      // The release overtook this press: it was a tap.
      this.timers.clear(this.earlyUp); this.earlyUp = undefined
      this.send('home', false)
      return
    }
    this.homeHeld = true
    this.timing.down('home')
  }
  private homeUp(): void {
    if (this.homeHeld) { this.homeHeld = false; this.timing.up('home'); return }
    if (this.earlyUp !== undefined) this.timers.clear(this.earlyUp)
    this.earlyUp = this.timers.set(() => { this.earlyUp = undefined }, EARLY_UP_MS)
  }
  private reset(): void {
    this.timing.cancel()
    this.homeHeld = false
    if (this.earlyUp !== undefined) this.timers.clear(this.earlyUp)
    this.earlyUp = undefined
  }
  private send(action: Action, long: boolean): void {
    void this.route(action, long).catch((error: unknown) => this.logger.error(`The ${action} key could not be handled`, error))
  }
}

export interface ControlServerOptions {
  path: string
  onCommand: (command: ControlCommand) => void
  logger?: Log
}

/** Listens on a Unix socket (or a Windows named pipe in tests). Each connection sends one line and gets `ok` or `error`. */
export class ControlServer {
  private server?: net.Server
  private logger: Log
  constructor(private opts: ControlServerOptions) { this.logger = opts.logger ?? silentLog }

  async listen(): Promise<void> {
    const pipe = this.opts.path.startsWith('\\\\')
    if (!pipe) {
      await mkdir(dirname(this.opts.path), { recursive: true, mode: 0o700 })
      // A socket left behind by a shell that crashed would stop the new one listening.
      await rm(this.opts.path, { force: true })
    }
    // Half-open: a client that sends its line and then closes its side still gets the reply.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => this.connection(socket))
    server.on('error', (error) => this.logger.error('Control socket failed', error))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.path, () => { server.off('error', reject); resolve() })
    })
    this.server = server
    if (!pipe) await chmod(this.opts.path, 0o600)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!this.opts.path.startsWith('\\\\')) await rm(this.opts.path, { force: true }).catch(() => undefined)
  }

  private connection(socket: net.Socket): void {
    let text = ''
    let done = false
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => undefined)
    const finish = (): void => {
      if (done) return
      done = true
      const command = parseControl(text.split('\n')[0] ?? '')
      let ok = command !== undefined
      if (command) {
        try { this.opts.onCommand(command) } catch (error) { ok = false; this.logger.error('Control command failed', error) }
      }
      socket.end(ok ? 'ok\n' : 'error\n')
    }
    socket.on('data', (chunk: string) => {
      if (done) return
      text += chunk
      if (text.length > MAX_LINE) { done = true; socket.end('error\n'); return }
      if (text.includes('\n')) finish()
    })
    socket.on('end', finish)
  }
}
