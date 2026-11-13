import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'

export type FileSystem = typeof fs

export async function atomicWrite(file: string, text: string, mode?: number, io: FileSystem = fs): Promise<void> {
  await io.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    const handle = await io.open(tmp, 'w', mode)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (mode !== undefined) await io.chmod(tmp, mode).catch(() => undefined)
    await renameWithRetry(io, tmp, file)
  } catch (error) {
    await io.unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function renameWithRetry(io: FileSystem, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await io.rename(from, to); return } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(String(code))) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
