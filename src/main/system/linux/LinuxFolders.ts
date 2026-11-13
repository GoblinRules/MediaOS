/* eslint-disable no-control-regex -- Helper fields must refuse control characters. */
import { createConnection, type Socket } from 'node:net'
import { watch as fsWatch } from 'node:fs'
import { z } from 'zod'
import type { FolderAddResult, FolderList, ShareAdd } from '@shared/folder-types'
import type { Result } from '@shared/system-types'
import type { FolderRoot, SystemServices } from '../SystemServices'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import { UserFacingError } from '../net/texts'
import type { CommandRunner } from './CommandRunner'
import { checkAdd, folderText } from '../../folders/texts'
import { listSmbShares } from '../../folders/smb-list'
import { createFolderDiscovery, type DiscoveryDgram } from '../../folders/discovery'

const idSchema = z.string().length(12).regex(/^smb-[a-f0-9]{8}$/)
const text = z.string().max(1024).refine((s) => !/[\x00-\x1f\x7f]/.test(s))
const shareSchema = z.object({ id: idSchema, name: text, server: text, share: text, user: text, domain: text,
  guest: z.boolean(), path: z.string(), mounted: z.boolean(), error: text.nullable(), errorAt: z.string().datetime().nullable(),
}).refine((v) => v.path === `/media/mediaos/${v.id}`)
const driveSchema = z.object({ id: text.regex(/^usb-[^/\\]+$/), name: text,
  path: text.regex(/^\/media\/mediaos\/usb-sd[a-z]{1,2}[0-9]{0,3}$/),
  fs: z.enum(['vfat', 'exfat', 'ntfs3', 'ext2', 'ext3', 'ext4']), sizeBytes: z.number().finite().nonnegative().nullable(),
})
const failureSchema = z.object({ ok: z.literal(false), error: text, detail: z.string().max(1_048_576) })
const listSchema = z.object({ ok: z.literal(true), shares: z.array(z.unknown()), drives: z.array(z.unknown()) })
const timeouts = { list: 10_000, add: 45_000, mount: 40_000, remove: 20_000 }
type Op = keyof typeof timeouts
interface FolderWatcher { close(): void; on(ev: 'error', cb: () => void): unknown }

export function createLinuxFolders(opts: {
  runner: CommandRunner; logger?: Log; socketPath?: string; mediaRoot?: string
  connect?: (path: string) => Socket
  watch?: (path: string, cb: () => void) => FolderWatcher
  timers?: Runtime; dgram?: DiscoveryDgram; fetch?: typeof fetch
}): SystemServices['folders'] & { dispose(): void } {
  const timers = opts.timers ?? runtime, logger = opts.logger ?? silentLog
  const listeners = new Set<() => void>(), pending = new Set<() => void>()
  const discovery = createFolderDiscovery(opts)
  let disposed = false, watcher: FolderWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined, watchRetry: ReturnType<typeof setTimeout> | undefined
  let saved: z.infer<typeof shareSchema>[] = []
  const changed = () => {
    if (disposed) return
    for (const cb of listeners) { try { cb() } catch { logger.warn('Folder listener failed') } }
  }
  const startWatch = () => {
    if (disposed || watcher) return
    const retryWatch = () => {
      watcher?.close(); watcher = undefined
      if (!disposed && watchRetry === undefined) watchRetry = timers.setTimeout(() => {
        watchRetry = undefined; startWatch()
      }, 60_000)
    }
    try {
      watcher = (opts.watch ?? ((path, cb) => fsWatch(path, cb)))(opts.mediaRoot ?? '/media/mediaos', () => {
        if (debounce !== undefined) timers.clearTimeout(debounce)
        debounce = timers.setTimeout(() => { debounce = undefined; changed() }, 1000)
      })
      watcher.on('error', retryWatch)
    } catch { retryWatch() }
  }
  startWatch()
  const request = (op: Op, fields: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve, reject) => {
    let socket: Socket | undefined, bytes = 0, finished = false
    const chunks: Buffer[] = []
    const finish = (value?: unknown, word?: string) => {
      if (finished) return
      finished = true; timers.clearTimeout(timer); pending.delete(cancel); socket?.destroy()
      if (word) reject(new UserFacingError(folderText(word)))
      else resolve(value)
    }
    const cancel = () => finish(undefined, 'unavailable')
    const timer = timers.setTimeout(cancel, timeouts[op])
    pending.add(cancel)
    if (disposed) { cancel(); return }
    try {
      socket = (opts.connect ?? createConnection)(opts.socketPath ?? '/run/mediaos/shares.sock')
      socket.once('connect', () => {
        if (finished) return
        try { socket?.write(JSON.stringify({ op, ...fields }) + '\n') } catch { cancel() }
      })
      socket.on('data', (data: Buffer) => {
        bytes += data.length
        if (bytes > 1_048_576) { cancel(); return }
        chunks.push(data)
        if (!data.includes(10)) return
        try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]!)) }
        catch { finish(undefined, 'failed') }
      })
      socket.on('error', cancel)
      socket.on('close', () => { if (!finished) cancel() })
    } catch { cancel() }
  })
  const reply = async (op: Op, fields: Record<string, unknown> = {}, server = '', share = '') => {
    const raw = await request(op, fields)
    const failure = failureSchema.safeParse(raw)
    if (failure.success) {
      logger.warn('Network folder helper failed', failure.data.detail)
      throw new UserFacingError(folderText(failure.data.error, server, share))
    }
    return raw
  }
  const read = async () => {
    const parsed = listSchema.safeParse(await reply('list'))
    if (!parsed.success) throw new UserFacingError(folderText('failed'))
    const shares = parsed.data.shares.flatMap((entry) => {
      const v = shareSchema.safeParse(entry)
      if (!v.success) { logger.warn('Ignoring invalid network folder entry'); return [] }
      return [v.data]
    })
    const drives = parsed.data.drives.flatMap((entry) => {
      const v = driveSchema.safeParse(entry)
      if (!v.success) { logger.warn('Ignoring invalid USB drive entry'); return [] }
      return [v.data]
    })
    saved = shares
    return { shares, drives }
  }
  const mutate = async (op: 'mount' | 'remove', id: string): Promise<Result> => {
    if (!idSchema.safeParse(id).success) return { ok: false, error: folderText('invalid') }
    try {
      const share = saved.find((s) => s.id === id)
      const raw = await reply(op, { id }, share?.server, share?.share)
      const schema = op === 'remove' ? z.object({ ok: z.literal(true) }) :
        z.object({ ok: z.literal(true), path: z.literal(`/media/mediaos/${id}`) })
      if (!schema.safeParse(raw).success) throw new UserFacingError(folderText('failed'))
      changed(); return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof UserFacingError ? error.message : folderText('failed') } }
  }
  return {
    list: async (): Promise<FolderList> => {
      const { shares, drives } = await read()
      return {
        shares: shares.map(({ path: _path, mounted, error, errorAt: _at, ...s }) => ({ ...s, available: mounted,
          ...(!mounted ? { problem: error ? folderText(error, s.server, s.share) : 'Not connected yet.' } : {}) })),
        drives: drives.map(({ path: _path, sizeBytes, ...d }) => ({ ...d, ...(sizeBytes === null ? {} : { sizeBytes }) })),
      }
    },
    roots: async (): Promise<FolderRoot[]> => {
      const { shares, drives } = await read()
      return [...shares.map((s): FolderRoot => ({ id: s.id, name: s.name, kind: 'share', path: s.path,
        available: s.mounted, server: s.server })),
      ...drives.map((d): FolderRoot => ({ id: d.id, name: d.name, kind: 'usb', path: d.path, available: true }))]
    },
    discover: () => discovery.discover(),
    listShares: (login) => listSmbShares(opts.runner, login),
    add: async (req: ShareAdd): Promise<FolderAddResult> => {
      try {
        const v = checkAdd(req)
        const fields = { name: v.name?.trim() ?? '', server: v.server, share: v.share, user: v.guest ? '' : v.user!.trim(),
          password: v.guest ? '' : v.password ?? '', domain: v.guest ? '' : v.domain?.trim() ?? '', guest: v.guest,
          ...(v.ip ? { ip: v.ip } : {}) }
        const raw = await reply('add', fields, v.server, v.share)
        const result = z.object({ ok: z.literal(true), id: idSchema, path: z.string() })
          .refine((s) => s.path === `/media/mediaos/${s.id}`).safeParse(raw)
        if (!result.success) throw new UserFacingError(folderText('failed'))
        saved.push({ id: result.data.id, name: fields.name || fields.share, server: fields.server,
          share: fields.share, user: fields.user, domain: fields.domain, guest: fields.guest,
          path: result.data.path, mounted: true, error: null, errorAt: null })
        changed(); return { ok: true, id: result.data.id }
      } catch (error) { return { ok: false, error: error instanceof UserFacingError ? error.message : folderText('failed') } }
    },
    remove: (id) => mutate('remove', id), retry: (id) => mutate('mount', id),
    on: (_ev, cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    dispose: () => {
      disposed = true; watcher?.close(); discovery.dispose(); listeners.clear()
      if (debounce !== undefined) timers.clearTimeout(debounce)
      if (watchRetry !== undefined) timers.clearTimeout(watchRetry)
      for (const cancel of pending) cancel()
    },
  }
}
