import type { FileSystem } from '../../settings/atomic'

/** Only the atomic journal operations are implemented; no files escape this private map. */
export function memoryJournal(): FileSystem {
  const files = new Map<string, string>()
  const absent = () => Object.assign(new Error('Missing journal'), { code: 'ENOENT' })
  return {
    mkdir: async () => undefined,
    open: async (path: string) => ({
      writeFile: async (text: string) => { files.set(path, text) },
      sync: async () => undefined,
      close: async () => undefined,
    }),
    rename: async (from: string, to: string) => {
      const text = files.get(from)
      if (text === undefined) throw absent()
      files.set(to, text); files.delete(from)
    },
    readFile: async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw absent()
      return text
    },
    unlink: async (path: string) => { if (!files.delete(path)) throw absent() },
  } as unknown as FileSystem
}
