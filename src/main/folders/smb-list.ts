/* eslint-disable no-control-regex -- Share names must refuse control characters. */
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShareLogin } from '@shared/folder-types'
import type { CommandRunner } from '../system/linux/CommandRunner'
import { UserFacingError } from '../system/net/texts'
import { checkLogin, folderText } from './texts'

export function smbError(text: string): string {
  if (/NT_STATUS_(?:LOGON_FAILURE|ACCESS_DENIED|ACCOUNT_\w+|WRONG_PASSWORD)/i.test(text)) return 'auth'
  if (/NT_STATUS_(?:HOST_UNREACHABLE|IO_TIMEOUT|CONNECTION_REFUSED|UNSUCCESSFUL|BAD_NETWORK_NAME)|Connection to [^\r\n]* failed|not resolve/i
    .test(text)) return 'unreachable'
  return 'failed'
}
export function parseShares(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).flatMap((line) => {
    const [type, name] = line.split('|')
    return type === 'Disk' && name && !name.endsWith('$') && !/[\x00-\x1f\x7f]/.test(name) ? [name] : []
  }))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })).slice(0, 200)
}
export async function listSmbShares(runner: CommandRunner, input: ShareLogin): Promise<string[]> {
  const login = checkLogin(input)
  const args = ['-g', '-L', `//${login.server}`, ...(login.ip ? ['-I', login.ip] : [])]
  let dir: string | undefined
  try {
    if (login.guest) args.push('-N')
    else {
      dir = await fs.mkdtemp(join(tmpdir(), 'mediaos-smb-'))
      await fs.chmod(dir, 0o700)
      const file = join(dir, 'auth')
      await fs.writeFile(file, `username = ${login.user!.trim()}\npassword = ${login.password ?? ''}\n` +
        (login.domain ? `domain = ${login.domain}\n` : ''), { mode: 0o600, flag: 'wx' })
      args.push('-A', file)
    }
    const result = await runner.run('smbclient', args, { timeoutMs: 15_000 })
    if ('fail' in result) throw new UserFacingError(folderText(result.fail === 'timeout' ? 'unreachable' : 'unavailable', login.server))
    const word = smbError(`${result.stderr}\n${result.stdout}`)
    if (result.code !== 0 || word !== 'failed') throw new UserFacingError(folderText(word, login.server))
    return parseShares(result.stdout)
  } catch (error) {
    if (error instanceof UserFacingError) throw error
    throw new UserFacingError(folderText('failed'))
  } finally {
    // Only these two known paths in the fresh private directory are removed.
    if (dir) { await fs.unlink(join(dir, 'auth')).catch(() => undefined); await fs.rmdir(dir).catch(() => undefined) }
  }
}
