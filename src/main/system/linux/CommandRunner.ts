import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { silentLog, type Log } from '../../log/Logger'
import { redact } from '../../log/redact'

/** `truncated` means the output passed `maxBytes`, so the command was stopped and `stdout` holds only the start. */
export type CommandResult = { code: number; stdout: string; stderr: string; truncated?: true } | { fail: 'timeout' | 'notFound' }
export interface CommandRunner {
  run(file: string, args: readonly string[], opts: { timeoutMs: number; maxBytes?: number }): Promise<CommandResult>
  /** onExit also fires on spawn failure. It lets the monitor owner restart with its injected clock. */
  spawnLines(file: string, args: readonly string[], onLine: (line: string) => void, onExit?: () => void): { kill(): void }
}
const env = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C' })

export class NodeCommandRunner implements CommandRunner {
  constructor(private logger: Log = silentLog) {}
  run(file: string, args: readonly string[], opts: { timeoutMs: number; maxBytes?: number }): Promise<CommandResult> {
    if (opts.timeoutMs <= 0) return Promise.resolve({ fail: 'timeout' })
    return new Promise((resolve) => {
      try {
        execFile(file, [...args], { shell: false, maxBuffer: opts.maxBytes ?? 1024 * 1024, env: env(),
          timeout: opts.timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => {
          if (stderr) this.logger.warn('Network command diagnostic', redact(stderr))
          if (error && 'code' in error && error.code === 'ENOENT') resolve({ fail: 'notFound' })
          else if (error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({ code: 1, stdout, stderr, truncated: true })
          }
          else if (error?.killed) resolve({ fail: 'timeout' })
          else resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr })
        })
      } catch (error) {
        // Node refuses some arguments (a NUL, say) before starting anything: say so rather than fail silently.
        this.logger.warn('Command could not start', file, error instanceof Error ? error.message : String(error))
        resolve({ fail: 'notFound' })
      }
    })
  }
  spawnLines(file: string, args: readonly string[], onLine: (line: string) => void, onExit?: () => void): { kill(): void } {
    try {
      const child = spawn(file, [...args], { shell: false, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
      const lines = createInterface({ input: child.stdout })
      const errors = createInterface({ input: child.stderr })
      lines.on('line', onLine)
      errors.on('line', (line) => this.logger.warn('Network monitor diagnostic', redact(line)))
      let ended = false
      const end = () => {
        if (ended) return
        ended = true; lines.close(); errors.close(); onExit?.()
      }
      child.once('error', end); child.once('close', end)
      return { kill() { child.kill('SIGKILL'); lines.close(); errors.close() } }
    } catch { queueMicrotask(() => onExit?.()); return { kill() {} } }
  }
}
