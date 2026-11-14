import { execFile, type ExecFileException } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogMediaControl, MprisMediaControl } from '../../src/main/remote/media-control'
import { silentLog } from '../../src/main/log/Logger'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
afterEach(() => vi.resetAllMocks())

type Callback = (error: ExecFileException | null) => void
function answer(error: ExecFileException | null = null) {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args[3] as Callback)(error)
    return {} as ReturnType<typeof execFile>
  })
}

describe('app media controls (MPRIS)', () => {
  it('sends PlayPause and microsecond seeks to the app browser, with -- before the arguments', async () => {
    answer()
    const control = new MprisMediaControl()
    await control.send(4321, { kind: 'playPause' })
    await control.send(4321, { kind: 'seek', seconds: -10 })
    await control.send(4321, { kind: 'seek', seconds: 30 })
    const head = ['--user', '--timeout=2', '--', 'call', 'org.mpris.MediaPlayer2.chromium.instance4321',
      '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player']
    expect(vi.mocked(execFile).mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      ['busctl', [...head, 'PlayPause'], { timeout: 3000 }],
      ['busctl', [...head, 'Seek', 'x', '-10000000'], { timeout: 3000 }],
      ['busctl', [...head, 'Seek', 'x', '30000000'], { timeout: 3000 }],
    ])
  })

  it.each([undefined, 0, -5, 1.5, Number.NaN])('does nothing without a real browser process id: %s', async (pid) => {
    await new MprisMediaControl().send(pid, { kind: 'playPause' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('never throws, and logs only the error kind once until the controls answer again', async () => {
    const info = vi.fn(), control = new MprisMediaControl({ logger: { ...silentLog, info } })
    const error = Object.assign(new Error('Call failed: name org.mpris.secret not found'), { code: 1 }) as ExecFileException
    answer(error)
    await expect(control.send(7, { kind: 'playPause' })).resolves.toBeUndefined()
    await control.send(7, { kind: 'playPause' })
    expect(info.mock.calls).toEqual([["The app's video controls did not answer (1)"]])
    answer(); await control.send(7, { kind: 'playPause' })
    answer(error); await control.send(7, { kind: 'playPause' })
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('logs mock commands', async () => {
    const debug = vi.fn()
    await new LogMediaControl({ ...silentLog, debug }).send(undefined, { kind: 'seek', seconds: -10 })
    expect(debug).toHaveBeenCalledWith('Phone media: seek -10s (pid none)')
  })
})
