import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { APP_CATALOG } from '../../src/main/apps/app-catalog'
import { chromeArgs, LINUX_CHROME_ARGS } from '../../src/main/apps/chrome'
import { MockAppHost } from '../../src/main/apps/MockAppHost'
import { MockVpnBackend, VPN_SCENARIOS } from '../../src/main/vpn/mock/MockVpnBackend'
import { parseWireGuard } from '../../src/main/vpn/wg-config'
import { mockAppPage, readLaunchOptions } from '../../src/main/launch-options'
import type { AppRoute } from '../../src/shared/vpn-types'

afterEach(() => vi.useRealTimers())

describe('VPN app routes', () => {
  it.each([{ kind: 'direct' }, { kind: 'vpn', port: 1080, label: 'UK' }] satisfies AppRoute[])(
    'puts the complete YouTube route switches last: $kind', (route) => {
      const youtube = APP_CATALOG.find((a) => a.id === 'youtube')!
      expect(chromeArgs(youtube, { profileDir: 'profiles', chromePath: 'chrome', extraArgs: ['--extra-test'] }, route)).toEqual([
        '--app=https://www.youtube.com/tv', `--user-data-dir=${resolve('profiles', 'youtube')}`, '--kiosk', '--start-fullscreen',
        '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
        '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required', '--class=mediaos-app-youtube',
        '--extra-test',
        '--user-agent=Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
        ...(route.kind === 'vpn' ? ['--proxy-server=socks5://127.0.0.1:1080',
          '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--disable-quic'] : ['--no-proxy-server']),
      ])
    })
  it('has no catalogue or platform switches that override VPN routing', () => {
    const banned = /^--(?:proxy|no-proxy-server|host-resolver-rules|enable-quic)/i
    for (const app of APP_CATALOG) {
      const args = (app as typeof app & { extraArgs?: string[] }).extraArgs ?? []
      expect(args.filter((arg) => banned.test(arg)), app.id).toEqual([])
    }
    expect(LINUX_CHROME_ARGS.filter((arg) => banned.test(arg))).toEqual([])
    expect(APP_CATALOG.filter((a) => a.vpn?.mayNotWork).map((a) => a.id).sort())
      .toEqual(['channel4', 'disney', 'iplayer', 'itvx', 'netflix', 'prime'])
  })
  it('passes a route to the mock window and escapes the VPN label on its page', async () => {
    const app = APP_CATALOG[0]!, route: AppRoute = { kind: 'vpn', port: 1080, label: '<UK>' }
    const openWindow = vi.fn(() => ({ close() {}, onClosed() {} })), host = new MockAppHost({ openWindow })
    await host.launch(app, route); expect(openWindow).toHaveBeenCalledWith(app, route)
    expect(decodeURIComponent(mockAppPage(app.name, app.colour, route)))
      .toContain('data-testid="app-network" style="font-size:1.4vw">Network: VPN (&#60;UK&#62;)')
    expect(decodeURIComponent(mockAppPage(app.name, app.colour, { kind: 'direct' }))).toContain('Network: direct')
    await host.close()
  })
  it('reads the development import path and accepts only the four VPN scenarios', () => {
    expect(readLaunchOptions({ MEDIAOS_VPN_IMPORT: ' C:/vpn.conf ' }, []).vpnImport).toBe('C:/vpn.conf')
    for (const scenario of VPN_SCENARIOS) expect(readLaunchOptions({ MEDIAOS_VPN_SCENARIO: scenario }, []).vpnScenario).toBe(scenario)
    expect(readLaunchOptions({ MEDIAOS_VPN_SCENARIO: 'unknown' }, []).vpnScenario).toBeUndefined()
  })
})

describe('VPN mock backend', () => {
  it('delays activation so connecting can be shown', async () => {
    vi.useFakeTimers()
    const backend = new MockVpnBackend({ delayMs: 100 }), key = randomBytes(32).toString('base64')
    const parsed = parseWireGuard(Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\n` +
      `[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`))
    if (!parsed.ok) throw new Error('Bad fixture')
    const uuid = await backend.importProfile(parsed.config, 'UK'), up = backend.up(uuid, '10.64.0.2')
    await vi.advanceTimersByTimeAsync(99); expect((await backend.status()).state).toBe('absent')
    await vi.advanceTimersByTimeAsync(1); await up; expect((await backend.status()).state).toBe('up')
  })
  it.each(VPN_SCENARIOS)('implements %s', async (scenario) => {
    const backend = new MockVpnBackend({ scenario }), key = randomBytes(32).toString('base64')
    const parsed = parseWireGuard(Buffer.from(`[Interface]\nPrivateKey = ${key}\nAddress = 10.64.0.2/32\n` +
      `[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example:51820\nAllowedIPs = 0.0.0.0/0\n`))
    if (!parsed.ok) throw new Error('Bad fixture')
    if (scenario === 'vpn-import-errors') {
      await expect(backend.importProfile(parsed.config, 'UK')).rejects.toThrow(); return
    }
    const uuid = await backend.importProfile(parsed.config, 'UK')
    expect(await backend.address(uuid)).toBe('10.64.0.2')
    expect(await backend.listProfiles()).toEqual([{ uuid, name: 'MediaOS VPN - UK', type: 'wireguard' }])
    await backend.up(uuid, '10.64.0.2')
    expect(await backend.status()).toEqual(scenario === 'vpn-down' ? { state: 'absent', tunIp: null } :
      { state: 'up', tunIp: '10.64.0.2' })
    expect(await backend.probe('10.64.0.2', null, 3000)).toBe(scenario !== 'vpn-not-working')
    await backend.down(uuid); expect((await backend.status()).state).toBe('absent')
    await backend.remove(uuid); expect(await backend.listProfiles()).toEqual([])
  })
})
