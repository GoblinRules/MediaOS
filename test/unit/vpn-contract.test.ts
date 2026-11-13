import { describe, expect, it } from 'vitest'
import { SettingsPatch, defaultSettings, migrateSettings } from '../../src/shared/settings-schema'
import { validateCall } from '../../src/shared/ipc-contract'

describe('VPN settings block', () => {
  it('defaults to off with no locations, and reads old boolean app choices', () => {
    expect(defaultSettings().vpn).toEqual({ enabled: false, activeLocationId: null, locations: [], apps: {} })
    const s = migrateSettings({ version: 1, vpn: { apps: { iplayer: true, youtube: false, itvx: 'vpn-or-direct' } } })
    expect(s.version).toBe(1)
    expect(s.vpn.apps).toEqual({ iplayer: 'vpn-only', youtube: 'direct', itvx: 'vpn-or-direct' })
  })

  it('refuses more than 5 locations and bad location ids', () => {
    const loc = (n: number) => ({ id: `loc-0000000${n}`, label: `L${n}`, nmUuid: '0a1b2c3d-0000-4000-8000-00000000000' + n,
      addedAt: '2026-11-13T00:00:00.000Z' })
    expect(() => migrateSettings({ version: 1, vpn: { locations: [1, 2, 3, 4, 5, 6].map(loc) } })).toThrow()
    expect(() => migrateSettings({ version: 1, vpn: { activeLocationId: 'loc-XYZ' } })).toThrow()
    expect(migrateSettings({ version: 1, vpn: { locations: [loc(1)] } }).vpn.locations[0]!.dns).toBeNull()
  })

  it('never lets the renderer patch the VPN block', () => {
    const patch = (SettingsPatch as unknown as { parse(v: unknown): object }).parse({ deviceName: 'TV', vpn: { enabled: true } })
    expect(patch).toEqual({ deviceName: 'TV' })
  })
})

describe('VPN call arguments', () => {
  it.each([
    ['vpn.finishImport', ['  UK  '], ['UK']],
    ['vpn.chooseImportEntry', ['any'], ['any']],
    ['vpn.chooseImportEntry', ['e12'], ['e12']],
    ['vpn.setLocation', ['loc-0123abcd'], ['loc-0123abcd']],
    ['vpn.setAllApps', ['vpn-only'], ['vpn-only']],
  ])('accepts %s %j', (name, args, out) => {
    expect(validateCall(name, args)).toEqual({ name, args: out })
  })

  it.each([
    ['vpn.finishImport', ['   ']],
    ['vpn.finishImport', ['x'.repeat(25)]],
    ['vpn.finishImport', ['UK\nPostUp']],
    ['vpn.chooseImportEntry', ['../a']],
    ['vpn.setLocation', ['loc-0123ABCD']],
    ['vpn.setAllApps', ['vpn-or-direct']],
    ['vpn.setAppVpn', ['iplayer', 'yes']],
  ])('refuses %s %j', (name, args) => {
    expect(validateCall(name, args)).toHaveProperty('error')
  })
})
