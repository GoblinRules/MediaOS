import { execFile, type ExecFileException } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_PHONE_KEYS, LogInjector, WtypeInjector } from '../../src/main/remote/key-injector'
import { silentLog } from '../../src/main/log/Logger'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('phone key injection', () => {
  it('uses only wtype with argument arrays, -- for text, a two-second timeout and a serial queue', async () => {
    const callbacks: ((error: ExecFileException | null) => void)[] = []
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      callbacks.push(args[3] as (error: ExecFileException | null) => void)
      return {} as ReturnType<typeof execFile>
    })
    const injector = new WtypeInjector({ display: () => 'wayland-1' })
    const first = injector.key('Up'), second = injector.text('--literal; $(secret)'), third = injector.key('BackSpace')
    await Promise.resolve()
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenNthCalledWith(1, 'wtype', ['-k', 'Up'], { timeout: 2000 }, expect.any(Function))
    callbacks[0]!(null); await first; await Promise.resolve()
    expect(execFile).toHaveBeenNthCalledWith(2, 'wtype', ['--', '--literal; $(secret)'], { timeout: 2000 }, expect.any(Function))
    callbacks[1]!(null); await second; await Promise.resolve()
    expect(execFile).toHaveBeenNthCalledWith(3, 'wtype', ['-k', 'BackSpace'], { timeout: 2000 }, expect.any(Function))
    callbacks[2]!(null); await third
  })
  it.each(['F1', 'XF86HomePage', 'Ctrl+Mod1+BackSpace', 'Return; reboot', 'unknown'])(
    'refuses keys outside the fixed map: %s', async (key) => {
      await expect(new WtypeInjector({ display: () => 'wayland-1' }).key(key)).rejects.toThrow('Unknown phone key')
      expect(execFile).not.toHaveBeenCalled()
    })
  it('warns once and does nothing when WAYLAND_DISPLAY is unset', async () => {
    const warn = vi.fn(), injector = new WtypeInjector({ display: () => undefined, logger: { ...silentLog, warn } })
    await injector.key('Up'); await injector.text('secret'); await injector.key('Down')
    expect(warn).toHaveBeenCalledTimes(1); expect(execFile).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
  })
  it('warns once when wtype is missing, and never forwards subprocess errors containing text', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const cb = args[3] as (error: ExecFileException) => void
      cb(Object.assign(new Error('secret argv'), { code: 'ENOENT' })); return {} as ReturnType<typeof execFile>
    })
    const warn = vi.fn(), injector = new WtypeInjector({ display: () => 'wayland-1', logger: { ...silentLog, warn } })
    await injector.text('secret'); await injector.key('Up')
    expect(execFile).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
  })
  it('sanitises execution failures and continues the serial queue', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      ;(args[3] as (error: Error) => void)(new Error('typed private text')); return {} as ReturnType<typeof execFile>
    })
    const injector = new WtypeInjector({ display: () => 'wayland-1' })
    await expect(injector.text('typed private text')).rejects.toThrow("Couldn't type on the TV. Try again.")
    await expect(injector.key('Up')).rejects.toThrow("Couldn't type on the TV. Try again.")
    expect(execFile).toHaveBeenCalledTimes(2)
  })
  it('logs mock keys and only character counts for text', async () => {
    const debug = vi.fn(), injector = new LogInjector({ ...silentLog, debug })
    for (const name of Object.values(APP_PHONE_KEYS)) await injector.key(name)
    await injector.text('private')
    expect(debug).toHaveBeenCalledWith('Phone key: Up')
    expect(debug).toHaveBeenLastCalledWith('Phone text: 7 characters')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private')
    await expect(injector.key('F1')).rejects.toThrow('Unknown phone key')
  })
})
