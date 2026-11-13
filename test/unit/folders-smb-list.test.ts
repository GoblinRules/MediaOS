import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandRunner, CommandResult } from '../../src/main/system/linux/CommandRunner'
import { listSmbShares, parseShares } from '../../src/main/folders/smb-list'
import { folderText } from '../../src/main/folders/texts'

function runner(result: CommandResult) {
  const run = vi.fn<CommandRunner['run']>().mockResolvedValue(result)
  return { run, spawnLines: () => ({ kill() {} }) }
}
describe('smbclient share listing', () => {
  it('uses guest and IP arguments without a shell and parses only visible disk shares', async () => {
    const r = runner({ code: 0, stdout: 'Disk|Films|Stuff\nIPC|IPC$|IPC\nDisk|Admin$|hidden\nDisk|Music|\nPrinter|HP|\n', stderr: '' })
    expect(await listSmbShares(r, { server: '\\\\NAS', ip: '192.168.1.20', guest: true })).toEqual(['Films', 'Music'])
    expect(r.run).toHaveBeenCalledWith('smbclient', ['-g', '-L', '//nas', '-I', '192.168.1.20', '-N'], { timeoutMs: 15000 })
    expect(parseShares(Array.from({ length: 250 }, (_, i) => `Disk|Folder ${i}|`).join('\n'))).toHaveLength(200)
  })
  it.each([true, false])('uses a private authfile and deletes it after success or failure (%s)', async (success) => {
    const r = runner({ code: 0, stdout: '', stderr: '' })
    let auth = ''
    r.run.mockImplementation(async (_file, args) => {
      expect(args.slice(0, -1)).toEqual(['-g', '-L', '//nas', '-A'])
      auth = args.at(-1)!
      expect(await fs.readFile(auth, 'utf8')).toBe('username = bob\npassword = private\ndomain = WORK\n')
      if (process.platform !== 'win32') {
        expect((await fs.stat(auth)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(dirname(auth))).mode & 0o777).toBe(0o700)
      }
      if (!success) throw new Error('run failed')
      return { code: 0, stdout: 'Disk|Public|\n', stderr: '' }
    })
    const p = listSmbShares(r, { server: 'nas', guest: false, user: 'WORK\\bob', password: 'private' })
    if (success) expect(await p).toEqual(['Public'])
    else await expect(p).rejects.toThrow(folderText('failed'))
    await expect(fs.stat(auth)).rejects.toThrow()
    await expect(fs.stat(auth.replace(/[\\/]auth$/, ''))).rejects.toThrow()
  })
  it.each(['LOGON_FAILURE', 'ACCESS_DENIED', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED_OUT', 'WRONG_PASSWORD'])(
    'maps authentication error %s in stdout', async (status) => {
      const r = runner({ code: 1, stdout: `nt_status_${status.toLowerCase()}`, stderr: '' })
      await expect(listSmbShares(r, { server: 'nas', guest: true })).rejects.toThrow(folderText('auth', 'nas'))
    })
  it.each(['NT_STATUS_HOST_UNREACHABLE', 'NT_STATUS_IO_TIMEOUT', 'NT_STATUS_CONNECTION_REFUSED', 'NT_STATUS_UNSUCCESSFUL',
    'NT_STATUS_BAD_NETWORK_NAME', 'Connection to NAS failed', 'could not resolve nas'])(
    'maps network failure %s', async (stderr) => {
      await expect(listSmbShares(runner({ code: 1, stdout: '', stderr }), { server: 'nas', guest: true }))
        .rejects.toThrow(folderText('unreachable', 'nas'))
    })
  it.each([['timeout', 'unreachable'], ['notFound', 'unavailable']] as const)('maps runner %s', async (fail, word) => {
    await expect(listSmbShares(runner({ fail }), { server: 'nas', guest: true })).rejects.toThrow(folderText(word, 'nas'))
  })
  it('refuses invalid credentials before invoking the runner', async () => {
    const r = runner({ code: 0, stdout: '', stderr: '' })
    await expect(listSmbShares(r, { server: 'nas', guest: false, user: 'bob', password: '\n' })).rejects.toThrow(folderText('invalid'))
    expect(r.run).not.toHaveBeenCalled()
  })
})
