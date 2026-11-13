import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from '../../system/linux/CommandRunner'
import { silentLog, type Log } from '../../log/Logger'

export interface DirEntry { name: string; type: 'dir' | 'file'; mtimeMs: number; size: number }
export interface DirLister { list(dir: string): Promise<DirEntry[]>; realpath(p: string): Promise<string> }
const hidden = new Set(['$recycle.bin', 'system volume information', '@eadir', '#recycle', 'lost+found', 'thumbs.db'])
/** Thrown by `realpath` when the path isn't there, as opposed to the folder not answering. */
export class MissingPath extends Error {}
// A backslash or a line break can't travel in an item id, so such a name could be listed but never opened.
const unusable = /[\\\n\r\u2028\u2029]/
export const visibleName = (name: string): boolean =>
  !name.startsWith('.') && !hidden.has(name.toLowerCase()) && !unusable.test(name)
function capped(entries: DirEntry[], logger: Log): DirEntry[] {
  if (entries.length > 5000) logger.info('Folder listing limited to 5000 entries', entries.length - 5000)
  return entries.slice(0, 5000)
}
export class FindLister implements DirLister {
  constructor(private runner: CommandRunner, private logger: Log = silentLog) {}
  async list(dir: string): Promise<DirEntry[]> {
    // find turns the two characters `\0` into a NUL itself: a real NUL can't be passed as an argument (Node refuses it).
    const result = await this.runner.run('find', ['-P', dir, '-mindepth', '1', '-maxdepth', '1',
      '(', '-type', 'd', '-o', '-type', 'f', ')', '-printf', '%y\\t%T@\\t%s\\t%f\\0'],
    { timeoutMs: 6000, maxBytes: 4 * 1024 * 1024 })
    if ('fail' in result || (result.code !== 0 && !result.truncated)) throw new Error('Folder listing unavailable')
    const records = result.stdout.split('\0')
    // A folder with tens of thousands of entries passes the output cap: keep what arrived, less the cut-off record.
    if (result.truncated) { records.pop(); this.logger.info('Folder listing cut short at the output limit') }
    const entries = records.flatMap((record): DirEntry[] => {
      const match = /^([df])\t([^\t]+)\t(\d+)\t([\s\S]+)$/.exec(record)
      if (!match || !visibleName(match[4]!)) return []
      const mtimeMs = Number(match[2]) * 1000, size = Number(match[3])
      if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return []
      return [{ type: match[1] === 'd' ? 'dir' : 'file', name: match[4]!, mtimeMs, size }]
    })
    return capped(entries, this.logger)
  }
  async realpath(p: string): Promise<string> {
    const result = await this.runner.run('realpath', ['-e', '--', p], { timeoutMs: 5000 })
    if (!('fail' in result) && result.code !== 0 && /No such file or directory|Not a directory/.test(result.stderr)) {
      throw new MissingPath('Folder path missing')
    }
    if ('fail' in result || result.code !== 0 || !result.stdout.endsWith('\n')) throw new Error('Folder path unavailable')
    return result.stdout.slice(0, -1)
  }
}
export class FsLister implements DirLister {
  constructor(private logger: Log = silentLog) {}
  async list(dir: string): Promise<DirEntry[]> {
    const entries: DirEntry[] = []
    for (const name of await fs.readdir(dir, 'utf8')) {
      if (!visibleName(name)) continue
      const stat = await fs.lstat(join(dir, name)).catch(() => undefined)
      if (stat?.isDirectory() || stat?.isFile()) entries.push({ name, type: stat.isDirectory() ? 'dir' : 'file',
        mtimeMs: stat.mtimeMs, size: stat.size })
    }
    return capped(entries, this.logger)
  }
  async realpath(p: string): Promise<string> {
    try { return await fs.realpath(p) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw code === 'ENOENT' || code === 'ENOTDIR' ? new MissingPath('Folder path missing') : error
    }
  }
}
