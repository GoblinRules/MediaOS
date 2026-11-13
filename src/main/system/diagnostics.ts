import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { redact } from '../log/redact'
import type { SysInfo } from '@shared/system-types'

export interface DiagnosticsIo {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string | Uint8Array, options: 'utf8' | { flag: string; mode: number }): Promise<void>
  readdir(path: string): Promise<string[]>
  rm(path: string, options: { force: true }): Promise<void>
}

/** Shared bundle format and retention for the mock and the TV box. */
export async function collectDiagnostics(opts: {
  logDir?: string; now(): number; info(): Promise<SysInfo>; screenOn?: boolean; fs?: DiagnosticsIo
}): Promise<string> {
  const io = opts.fs ?? fs
  const dir = opts.logDir ?? join(process.cwd(), 'logs')
  await io.mkdir(dir, { recursive: true })
  const path = join(dir, `diagnostics-${opts.now()}.txt`)
  let logs = ''
  for (const name of ['mediaos.log.3', 'mediaos.log.2', 'mediaos.log.1', 'mediaos.log']) {
    logs += await io.readFile(join(dir, name), 'utf8').catch(() => '')
  }
  const info = await opts.info()
  const screen = opts.screenOn === undefined ? '' : `Screen on: ${opts.screenOn}\n`
  await io.writeFile(path, redact(`MediaOS diagnostics\n${JSON.stringify(info)}\n${screen}${logs}`), 'utf8')
  const bundles = (await io.readdir(dir)).filter((name) => /^diagnostics-\d+\.txt$/.test(name))
    .sort((a, b) => Number(b.slice(12, -4)) - Number(a.slice(12, -4)))
  await Promise.all(bundles.slice(3).map((name) => io.rm(join(dir, name), { force: true }).catch(() => undefined)))
  return path
}
