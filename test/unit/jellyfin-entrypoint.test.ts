import { expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => ({
  version: '9.8.7',
  compose: vi.fn(() => new Promise<never>(() => {})),
}))
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on() {}, setPath() {},
    getPath: () => '/mediaos-test', getVersion: () => entry.version,
  },
  Menu: { setApplicationMenu() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
}))
// Stop at composition: this tests production startup wiring without opening an Electron window.
vi.mock('../../src/main/core/compose', () => ({ composeCore: entry.compose }))

it('passes the running Electron app version to Jellyfin composition', async () => {
  await import('../../src/main/index')
  expect(entry.compose).toHaveBeenCalledOnce()
  expect(entry.compose).toHaveBeenCalledWith(expect.objectContaining({ appVersion: entry.version }))
})
