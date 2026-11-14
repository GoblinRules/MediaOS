import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VpnController, type VpnControllerOptions } from '../../src/main/vpn/VpnController'
import { MockVpnBackend } from '../../src/main/vpn/mock/MockVpnBackend'
import { SettingsStore } from '../../src/main/settings/SettingsStore'
import { runtime } from '../../src/main/core/runtime'
import type { VpnStatus } from '../../src/shared/vpn-types'
import type { UploadOpenResult } from '../../src/main/remote/upload'

const controllers: VpnController[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z')) })
afterEach(() => { for (const c of controllers) c.dispose(); controllers.length = 0; vi.clearAllTimers(); vi.useRealTimers() })
function pasted(): Buffer {
  const key = (): string => randomBytes(32).toString('base64')
  return Buffer.from('\uFEFF\r\n\r\n' + `[Interface]\r\nPrivateKey = ${key()}\r\nAddress = 10.64.0.2/32\r\n\r\n` +
    `[Peer]\r\nPublicKey = ${key()}\r\nEndpoint = vpn.example:51820\r\nAllowedIPs = 0.0.0.0/0\r\n\r\n`)
}
async function make() {
  const settings = await SettingsStore.open('vpn-upload-unused.json', { clock: runtime,
    fs: { ...fs, readFile: vi.fn().mockRejectedValue(Object.assign(new Error('Missing'), { code: 'ENOENT' })) } })
  vi.spyOn(settings, 'flush').mockResolvedValue()
  const close = vi.fn(), open = vi.fn(async (): Promise<UploadOpenResult> => ({ ok: true,
    url: 'http://127.0.0.1:8080/vpn-upload?code=12345678', code: '12345678',
    expiresAt: new Date(Date.now() + 300000).toISOString() }))
  const statuses: VpnStatus[] = []
  const opts: VpnControllerOptions = { settings, backend: new MockVpnBackend({ delayMs: 0 }),
    proxy: { start: async () => {}, stop: async () => {}, port: () => null, onPort: () => () => {}, setTunnel: () => {} },
    upload: { open, close }, closeApp: async () => {}, runningApp: () => undefined, appName: (id) => id,
    appIds: () => [], isLockedDirect: () => false, emitStatus: (status) => statuses.push(status), emitDropped: () => {}, toast: () => {} }
  const controller = new VpnController(opts); controllers.push(controller)
  return { controller, opts, open, close, settings, statuses }
}

describe('controller phone upload port', () => {
  it('publishes the URL, code and expiry in the waiting stage and status', async () => {
    const f = await make(), opened = await f.controller.startImport()
    expect(opened).toEqual({ stage: 'waiting', url: 'http://127.0.0.1:8080/vpn-upload?code=12345678',
      code: '12345678', expiresAt: '2026-11-14T00:05:00.000Z' })
    expect(f.controller.status().import).toEqual(opened)
    expect(f.statuses.at(-1)?.import).toEqual(opened)
  })
  it.each(['no-network', 'upload-unavailable'] as const)('shows the %s error', async (error) => {
    const f = await make(); f.open.mockResolvedValue({ ok: false, error })
    expect(await f.controller.startImport()).toEqual({ stage: 'error', error })
  })
  it('shows upload-unavailable and closes the upload when opening it throws', async () => {
    const f = await make(); f.open.mockRejectedValue(new Error('boom'))
    expect(await f.controller.startImport()).toEqual({ stage: 'error', error: 'upload-unavailable' })
    expect(f.close).toHaveBeenCalled()
  })
  it('keeps the developer file path ahead of the phone upload', async () => {
    const f = await make(); f.opts.devImport = async () => ({ name: 'uk.conf', data: pasted() })
    expect(await f.controller.startImport()).toMatchObject({ stage: 'name', suggested: 'uk' })
    expect(f.open).not.toHaveBeenCalled()
  })
  it('preserves waiting without an upload host', async () => {
    const f = await make(); f.opts.upload = undefined
    expect(await f.controller.startImport()).toMatchObject({ stage: 'waiting', url: null, code: null })
    await vi.advanceTimersByTimeAsync(300000)
    expect(f.controller.status().import).toEqual({ stage: 'error', error: 'expired' })
  })
  it.each(['file', 'oversized-file', 'too-large', 'expiry', 'cancel', 'restart', 'dispose', 'save-error'] as const)(
    'closes the upload when leaving waiting: %s', async (exit) => {
      const f = await make(); await f.controller.startImport(); f.close.mockClear()
      if (exit === 'file') await f.controller.receiveFile('uk.conf', pasted(), '12345678')
      if (exit === 'oversized-file') await f.controller.receiveFile('uk.conf', Buffer.alloc(65537), '12345678')
      if (exit === 'too-large') f.controller.uploadTooLarge('12345678')
      if (exit === 'expiry') await vi.advanceTimersByTimeAsync(300000)
      if (exit === 'cancel') await f.controller.cancelImport()
      if (exit === 'restart') await f.controller.startImport()
      if (exit === 'dispose') f.controller.dispose()
      if (exit === 'save-error') { f.opts.networkBusy = async () => true; await f.controller.finishImport('UK') }
      expect(f.close).toHaveBeenCalled()
    })
  it('ignores stale files and oversize reports, then accepts a current pasted file with BOM, CRLF and blank lines', async () => {
    const f = await make(); await f.controller.startImport(); f.close.mockClear()
    expect(await f.controller.receiveFile('stale.conf', pasted(), '87654321')).toBe(false)
    f.controller.uploadTooLarge('87654321')
    expect(f.controller.status().import?.stage).toBe('waiting'); expect(f.close).not.toHaveBeenCalled()
    expect(await f.controller.receiveFile('', pasted(), '12345678')).toBe(true)
    expect(f.controller.status().import).toEqual({ stage: 'name', suggested: 'VPN', removed: [] })
  })
  it('reports a file that arrives after the import has ended as not received', async () => {
    const f = await make(); await f.controller.startImport(); await f.controller.cancelImport()
    expect(await f.controller.receiveFile('uk.conf', pasted(), '12345678')).toBe(false)
    expect(f.controller.status().import).toBeNull()
  })
  it('moves to too-large only for the waiting code and emits the error', async () => {
    const f = await make(); await f.controller.startImport()
    f.controller.uploadTooLarge('12345678')
    expect(f.controller.status().import).toEqual({ stage: 'error', error: 'too-large' })
    expect(f.statuses.at(-1)?.import).toEqual({ stage: 'error', error: 'too-large' })
  })
  it('closes an upload that finishes opening after disposal', async () => {
    const f = await make()
    let finish!: (result: UploadOpenResult) => void
    f.open.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const started = f.controller.startImport(); await vi.advanceTimersByTimeAsync(0)
    f.controller.dispose(); f.close.mockClear()
    finish({ ok: true, url: 'http://127.0.0.1:8080/vpn-upload?code=12345678', code: '12345678', expiresAt: '' })
    expect(await started).toEqual({ stage: 'error', error: 'save-failed' })
    expect(f.close).toHaveBeenCalledOnce(); expect(f.controller.status().import).toBeNull()
  })
})
