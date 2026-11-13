// Small helpers for the sway compositor that runs the TV session on Linux.
import { execFile } from 'node:child_process'
import { silentLog, type Log } from '../../log/Logger'

export type Run = (file: string, args: string[]) => Promise<void>

const run: Run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 3000 }, (error) => (error ? reject(error) : resolve()))
})

/**
 * Give the keyboard back to the shell's window (found by its process id) once an app or the player has gone.
 * sway normally does this by itself when the covering window closes; this makes sure of it.
 */
export function focusProcess(pid: number, logger: Log = silentLog, exec: Run = run): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve()
  return exec('swaymsg', [`[pid=${pid}]`, 'focus']).catch((error: unknown) => logger.warn('Could not focus the shell window', error))
}
