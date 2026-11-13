import { describe, expect, it } from 'vitest'
import { mockAppPage, readLaunchOptions } from '../../src/main/launch-options'

describe('readLaunchOptions', () => {
  it('defaults to mock, fullscreen, real player', () => {
    expect(readLaunchOptions({}, [])).toEqual({ platform: 'mock', dataDir: undefined, window: undefined, forceMockPlayer: false,
      mpvPath: undefined, devTools: false, background: false, appIcons: 'fetch', chromePath: undefined, controlSocket: undefined,
      softwareVideo: false, netTrialSec: undefined, realSystem: [] })
  })
  it('parses the real-system comma list', () => {
    expect(readLaunchOptions({ MEDIAOS_REAL_SYSTEM: ' network, ,audio,  ' }, []).realSystem).toEqual(['network', 'audio'])
    expect(readLaunchOptions({ MEDIAOS_REAL_SYSTEM: ' , ' }, []).realSystem).toEqual([])
  })
  it('turns off site icon downloads for automated, visible e2e and explicitly offline runs', () => {
    for (const env of [{ MEDIAOS_BACKGROUND: '1' }, { MEDIAOS_APP_ICONS: 'off' }, { MEDIAOS_E2E_VISIBLE: '1' }]) {
      expect(readLaunchOptions(env, []).appIcons).toBe('off')
    }
    expect(readLaunchOptions({ MEDIAOS_APP_ICONS: 'fetch', MEDIAOS_BACKGROUND: '1' }, []).appIcons).toBe('off')
    expect(readLaunchOptions({ MEDIAOS_APP_ICONS: 'no' }, []).appIcons).toBe('fetch')
  })
  it('reads the Linux options', () => {
    expect(readLaunchOptions({ XDG_RUNTIME_DIR: '/run/user/1000/' }, []).controlSocket).toBe('/run/user/1000/mediaos/ctl.sock')
    expect(readLaunchOptions({ XDG_RUNTIME_DIR: 'relative' }, []).controlSocket).toBeUndefined()
    expect(readLaunchOptions({ MEDIAOS_CONTROL_SOCKET: ' /tmp/s ', XDG_RUNTIME_DIR: '/run/user/1' }, []).controlSocket).toBe('/tmp/s')
    expect(readLaunchOptions({ MEDIAOS_CHROME: ' /usr/bin/google-chrome ', MEDIAOS_SOFTWARE_VIDEO: '1' }, []))
      .toMatchObject({ chromePath: '/usr/bin/google-chrome', softwareVideo: true })
  })
  it('accepts only integer network trial lengths from 3 to 45 seconds', () => {
    for (const seconds of [3, 5, 45]) {
      expect(readLaunchOptions({ MEDIAOS_NET_TRIAL_SEC: String(seconds) }, []).netTrialSec).toBe(seconds)
    }
    for (const value of ['2', '46', 'abc', '3.5', '5.0', '5e0', '']) {
      expect(readLaunchOptions({ MEDIAOS_NET_TRIAL_SEC: value }, []).netTrialSec).toBeUndefined()
    }
  })
  it('reads the environment', () => {
    const o = readLaunchOptions(
      { MEDIAOS_PLATFORM: 'linux', MEDIAOS_DATA_DIR: ' /tmp/x ', MEDIAOS_WINDOW: '1280x720', MEDIAOS_MOCK_PLAYER: '1' }, [])
    expect(o).toMatchObject({ platform: 'linux', dataDir: '/tmp/x', window: { width: 1280, height: 720 }, forceMockPlayer: true })
    expect(readLaunchOptions({ MEDIAOS_BACKGROUND: '1' }, []).background).toBe(true)
    expect(readLaunchOptions({ MEDIAOS_BACKGROUND: 'yes' }, []).background).toBe(false)
  })
  it('ignores bad window sizes and unknown platforms', () => {
    expect(readLaunchOptions({ MEDIAOS_WINDOW: '20x20', MEDIAOS_PLATFORM: 'mac' }, []).window).toBeUndefined()
    expect(readLaunchOptions({ MEDIAOS_WINDOW: '1280 x 720' }, []).window).toBeUndefined()
    expect(readLaunchOptions({ MEDIAOS_PLATFORM: 'mac' }, []).platform).toBe('mock')
    expect(readLaunchOptions({}, ['--mock-player']).forceMockPlayer).toBe(true)
  })
})

describe('mockAppPage', () => {
  it('escapes the app name and refuses odd colours', () => {
    const html = decodeURIComponent(mockAppPage('<img src=x onerror=alert(1)>', 'red;background:url(http://x)'))
    expect(html).not.toContain('<img')
    expect(html).toContain('&#60;img')
    expect(html).toContain('background:#222')
    expect(html).not.toContain('http://x')
  })
})
