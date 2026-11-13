// Finds and stops Chrome browsers that use a MediaOS app profile but that this shell didn't start (Linux only).
//
// Chrome moves its main process into its own systemd scope (app-com.google.Chrome-<pid>.scope), so when the shell
// crashes and systemd restarts it, Chrome keeps running in front of the new shell. Stopping that one browser process
// (the one holding --user-data-dir) makes Chrome close its helpers too.
import * as fs from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { delay, runtime, type Runtime } from '../core/runtime'
import { silentLog, type Log } from '../log/Logger'

export interface ProcessTable {
  /** Every process this user can see, with its command line. */
  list(): Promise<{ pid: number; args: string[] }[]>
  /** Send a signal; false when the process has gone or isn't ours. */
  signal(pid: number, signal: NodeJS.Signals | 0): boolean
}

/**
 * Splits /proc/<pid>/cmdline into arguments. Chrome rewrites its process title, which joins its arguments with
 * spaces into one string (checked on Chrome 157), so a single field is split again before each " --".
 */
export function parseCmdline(text: string): string[] {
  const args = text.split('\0').filter(Boolean)
  const [only] = args
  return args.length === 1 && only !== undefined ? only.split(/ (?=--)/) : args
}

/** The real table, from /proc. */
export const procTable: ProcessTable = {
  async list() {
    const names = await fs.readdir('/proc').catch(() => [] as string[])
    const out: { pid: number; args: string[] }[] = []
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      const text = await fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')
      if (text) out.push({ pid: Number(name), args: parseCmdline(text) })
    }
    return out
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); return true } catch { return false }
  },
}

/** Ids of Chrome browser processes whose profile is inside `profileDir` (or is exactly `only`, when given). */
export async function findProfileBrowsers(table: ProcessTable, profileDir: string, only?: string): Promise<number[]> {
  const root = resolve(profileDir)
  const pids: number[] = []
  for (const proc of await table.list()) {
    if (proc.pid === process.pid || proc.args.some((a) => a.startsWith('--type='))) continue
    const flag = proc.args.find((a) => a.startsWith('--user-data-dir='))
    if (!flag) continue
    const dir = resolve(flag.slice('--user-data-dir='.length))
    const rel = relative(root, dir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    if (only !== undefined && dir !== resolve(only)) continue
    pids.push(proc.pid)
  }
  return pids
}

/** Ask each matching browser to quit, then force any still running after `graceMs`. Returns how many were found. */
export async function stopProfileBrowsers(opts: { table: ProcessTable; profileDir: string; only?: string; graceMs?: number
  clock?: Runtime; logger?: Log }): Promise<number> {
  const { table, clock = runtime, logger = silentLog } = opts
  const pids = await findProfileBrowsers(table, opts.profileDir, opts.only)
  if (pids.length === 0) return 0
  logger.warn(`Closing ${pids.length} app window(s) left over from before`)
  for (const pid of pids) table.signal(pid, 'SIGTERM')
  const deadline = clock.now() + (opts.graceMs ?? 3000)
  let left = pids
  while (left.length > 0 && clock.now() < deadline) {
    await delay(100, clock)
    left = left.filter((pid) => table.signal(pid, 0))
  }
  if (left.length > 0) {
    // Only force a process that is still one of these browsers, in case its id has been reused since.
    const still = new Set(await findProfileBrowsers(table, opts.profileDir, opts.only))
    for (const pid of left) if (still.has(pid)) table.signal(pid, 'SIGKILL')
  }
  return pids.length
}
