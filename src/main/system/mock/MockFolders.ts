import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { FolderShare, ShareLogin } from '@shared/folder-types'
import type { SystemServices } from '../SystemServices'
import { atomicWrite } from '../../settings/atomic'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import { checkAdd, checkLogin, folderText } from '../../folders/texts'
import { UserFacingError } from '../net/texts'

const savedSchema = z.array(z.object({ id: z.string().length(12).regex(/^smb-[a-f0-9]{8}$/), name: z.string(), server: z.string(),
  share: z.string(), user: z.string(), domain: z.string(), guest: z.boolean(), available: z.boolean() })).max(20)
const seed = ['Films/Some Film (2019)/Some.Film.2019.1080p.mkv',
  'Films/Some Film (2019)/Some.Film.2019.1080p.en.srt', 'Films/Another Film 2021.mp4',
  'Shows/Show Name/Season 1/Show.Name.S01E01.mkv', 'Shows/Show Name/Season 1/Show.Name.S01E02.mkv', 'notes.txt']

export function createMockFolders(opts: { foldersDir?: string; delayMs?: number; timers?: Runtime; logger?: Log } = {}):
SystemServices['folders'] & { dispose(): void } {
  const dir = opts.foldersDir ?? join(tmpdir(), `mediaos-mock-folders-${randomBytes(8).toString('hex')}`)
  const timers = opts.timers ?? runtime, logger = opts.logger ?? silentLog
  const listeners = new Set<() => void>(), waits = new Map<ReturnType<typeof setTimeout>, () => void>()
  let shares: FolderShare[] = [], ready: Promise<void> | undefined, disposed = false
  let queue = Promise.resolve()
  const wait = () => (opts.delayMs ?? 350) <= 0 || disposed ? Promise.resolve() : new Promise<void>((resolve) => {
    const timer = timers.setTimeout(() => { waits.delete(timer); resolve() }, opts.delayMs ?? 350)
    waits.set(timer, resolve)
  })
  const file = join(dir, 'shares.json')
  const fill = async (id: string, names: string[]) => {
    for (const name of names) {
      const path = join(dir, id, name)
      await fs.mkdir(join(path, '..'), { recursive: true })
      await fs.writeFile(path, name.endsWith('.srt') ? '1\n00:00:00,000 --> 00:00:01,000\nHello\n' : 'Mock media\n',
        { flag: 'wx', encoding: 'utf8' }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      })
    }
  }
  const init = () => ready ??= (async () => {
    await fs.mkdir(dir, { recursive: true })
    try { shares = savedSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) logger.warn('Mock network folders could not be read')
    }
    await fill('usb-mock', ['clip.mp4'])
  })()
  const changed = () => { if (!disposed) for (const cb of listeners) cb() }
  const failure = (v: ShareLogin & { share?: string }) => v.server === 'offline' ? 'unreachable' :
    v.password === 'wrong' ? 'auth' : v.share === 'missing' ? 'no-share' : undefined
  const save = () => atomicWrite(file, JSON.stringify(shares) + '\n', 0o600)
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const work = queue.then(fn); queue = work.then(() => undefined, () => undefined); return work
  }
  return {
    list: async () => { await init(); return { shares: structuredClone(shares),
      drives: [{ id: 'usb-mock', name: 'HOLIDAY', fs: 'vfat' }] } },
    roots: async () => {
      await init()
      return [...shares.map((s) => ({ id: s.id, name: s.name, path: join(dir, s.id), kind: 'share' as const,
        available: s.available, server: s.server })),
      { id: 'usb-mock', name: 'HOLIDAY', path: join(dir, 'usb-mock'), kind: 'usb' as const, available: true }]
    },
    discover: async () => {
      await wait()
      return [{ name: 'NAS', host: 'nas.local', ip: '192.168.1.20' },
        { name: 'OFFICE-PC', host: 'OFFICE-PC', ip: '192.168.1.31' }]
    },
    listShares: async (input) => {
      const v = checkLogin(input); await wait()
      const word = failure(v)
      if (word) throw new UserFacingError(folderText(word, v.server))
      return ['Films', 'Music', 'Public']
    },
    add: (input) => serial(async () => {
      try {
        const v = checkAdd(input); await init(); await wait()
        const word = failure(v)
        if (word) return { ok: false, error: folderText(word, v.server, v.share) }
        if (shares.length >= 20) return { ok: false, error: folderText('too-many') }
        if (shares.some((s) => s.server.toLowerCase() === v.server.toLowerCase() && s.share.toLowerCase() === v.share.toLowerCase())) {
          return { ok: false, error: folderText('exists') }
        }
        const id = `smb-${randomBytes(4).toString('hex')}`
        await fill(id, seed)
        shares.push({ id, name: v.name?.trim() || v.share, server: v.server, share: v.share, guest: v.guest,
          user: v.guest ? '' : v.user!.trim(), domain: v.guest ? '' : v.domain ?? '', available: true })
        await save(); changed(); return { ok: true, id }
      } catch (error) { return { ok: false, error: error instanceof UserFacingError ? error.message : folderText('failed') } }
    }),
    remove: (id) => serial(async () => {
      await init(); await wait()
      if (!shares.some((s) => s.id === id)) return { ok: false, error: folderText('not-found') }
      shares = shares.filter((s) => s.id !== id)
      await save(); changed(); return { ok: true }
    }),
    retry: async (id) => {
      await init(); await wait()
      const share = shares.find((s) => s.id === id)
      if (!share) return { ok: false, error: folderText('not-found') }
      const word = failure(share)
      if (word) return { ok: false, error: folderText(word, share.server, share.share) }
      share.available = true; changed(); return { ok: true }
    },
    on: (_ev, cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    dispose: () => {
      disposed = true; listeners.clear()
      for (const [timer, resolve] of waits) { timers.clearTimeout(timer); resolve() }
      waits.clear()
    },
  }
}
