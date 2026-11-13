import { spawn, type ChildProcess } from 'node:child_process'
import { access, rm } from 'node:fs/promises'
import { delimiter, join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { MpvTransport } from './MpvTransport'
import { delay, runtime, type Runtime } from '../../core/runtime'

export interface MpvProcessOptions {
  mpvPath?: string
  pipe?: string
  platform?: NodeJS.Platform
  spawn?: (file: string, args: string[]) => ChildProcess
  clock?: Runtime
  transport?: (path: string) => MpvTransport
  extraArgs?: string[]
}

export async function findMpv(path?: string, env: NodeJS.ProcessEnv = process.env,
  canAccess: (path: string) => Promise<void> = access): Promise<string | undefined> {
  const requested = path ?? env.MEDIAOS_MPV
  const names = requested ? [requested] : process.platform === 'win32' ? ['mpv.exe', 'mpv'] : ['mpv']
  for (const name of names) {
    const candidates = isAbsolute(name) || /[\\/]/.test(name) ? [name] :
      (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name))
    for (const candidate of candidates) { try { await canAccess(candidate); return candidate } catch { /* Try the next path. */ } }
  }
  return undefined
}

export class MpvProcess {
  pipe: string
  private child?: ChildProcess
  private transport?: MpvTransport
  private clock: Runtime
  private cancelled = false
  private stopping: Promise<void> = Promise.resolve()
  private exited = new WeakSet<ChildProcess>()

  constructor(private opts: MpvProcessOptions = {}) {
    this.pipe = this.newPipe()
    this.clock = opts.clock ?? runtime
  }
  async start(): Promise<MpvTransport> {
    await this.stopping
    if (this.transport) return this.transport
    if (this.child) await this.dispose()
    this.pipe = this.newPipe()
    this.cancelled = false
    const args = ['--idle=yes', '--force-window=yes', `--input-ipc-server=${this.pipe}`, '--fullscreen',
      '--no-terminal', '--keep-open=no', '--osc=no', '--input-default-bindings=no', '--input-vo-keyboard=no',
      '--hwdec=auto-safe', '--ytdl=no', ...(this.opts.extraArgs ?? [])]
    const child = (this.opts.spawn ?? ((file, argv) => spawn(file, argv, { stdio: 'ignore', windowsHide: true })))(
      this.opts.mpvPath ?? 'mpv', args)
    this.child = child
    let failure: Error | undefined
    child.on('error', (error) => { failure = error; this.exited.add(child) })
    child.on('exit', () => {
      this.exited.add(child)
      failure ??= new Error('mpv exited')
      if (this.child === child) this.transport?.close()
    })
    const deadline = this.clock.now() + 5000
    while (!this.cancelled && this.clock.now() < deadline) {
      if (failure) { await this.dispose(); throw failure }
      const transport = (this.opts.transport ?? ((path) => new MpvTransport(path, { clock: this.clock })))(this.pipe)
      try {
        await transport.connect()
        if (this.cancelled) { transport.dispose(); break }
        this.transport = transport
        return transport
      } catch { transport.dispose(); await delay(50, this.clock) }
    }
    await this.dispose()
    throw new Error('mpv did not become ready')
  }
  async dispose(): Promise<void> {
    this.cancelled = true
    this.transport?.dispose()
    this.transport = undefined
    const child = this.child
    const pipe = this.pipe
    this.child = undefined
    const run = this.stopping.then(async () => {
      if (!child) return
      if (!this.exited.has(child) && child.exitCode == null && child.signalCode == null) {
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>
          const cleanup = () => {
            this.clock.clearTimeout(timer)
            child.off('exit', done); child.off('error', done)
          }
          const done = () => { cleanup(); resolve() }
          child.once('exit', done); child.once('error', done)
          timer = this.clock.setTimeout(() => {
            timer = this.clock.setTimeout(() => { cleanup(); reject(new Error('mpv did not exit')) }, 1000)
            child.kill('SIGKILL')
          }, 3000)
          child.kill('SIGTERM')
        })
      }
      if ((this.opts.platform ?? process.platform) !== 'win32' && !this.opts.pipe) {
        await rm(pipe, { force: true })
      }
    })
    this.stopping = run.catch(() => undefined)
    await run
  }
  private newPipe(): string {
    return this.opts.pipe ?? ((this.opts.platform ?? process.platform) === 'win32' ?
      `\\\\.\\pipe\\mediaos-mpv-${randomUUID()}` : join(tmpdir(), `mediaos-mpv-${randomUUID()}.sock`))
  }
}
