import { describe, expect, it } from 'vitest'
import * as parse from '../../src/main/system/linux/nmcli-parse'
import { fixture, NM_UUID, NM_CHECKPOINT } from './helpers'

describe('NetworkManager fixture parsers', () => {
  it('decodes terse escaping and splits show output only once', () => {
    expect(parse.terse(String.raw`MOS probe\: a\\b c:uuid::no`)).toEqual(['MOS probe: a\\b c', 'uuid', '', 'no'])
    expect(parse.properties(String.raw`ipv6.dns:2606\:4700\:4700\:\:1111`)).toEqual({ 'ipv6.dns': '2606:4700:4700::1111' })
    expect(parse.properties('value:with:colons')).toEqual({ value: 'with:colons' })
  })
  it('reads device status, live addresses and missing addresses', () => {
    expect(parse.deviceStatus(fixture('device-status.txt'))[0]).toEqual({
      device: 'ens160', type: 'ethernet', state: 'connected', uuid: NM_UUID,
    })
    for (const [name, address] of [['dhcp', '192.168.80.137'], ['manual', '192.168.80.150'], ['after-clash', '192.168.80.2']]) {
      expect(parse.deviceShow(fixture(`device-show-${name}.txt`))).toMatchObject({ state: 100,
        mac: '00:0C:29:58:DD:41', live: { address, prefix: 24 } })
    }
    expect(parse.deviceShow('GENERAL.STATE:70 (connecting)\n').live).toBeUndefined()
  })
  it('reads both connection lists, names, settings and comma or indexed lists', () => {
    expect(parse.connectionList(fixture('connection-list-plain.txt'))[0]).toMatchObject({ uuid: NM_UUID, active: true })
    expect(parse.connectionList(fixture('connection-list-odd.txt'))[3]?.name).toBe('MOS probe: a\\b c')
    for (const name of ['auto', 'customdns', 'manual', 'shared']) {
      const props = parse.connectionSettings(fixture(`connection-${name}.txt`))
      expect(props['802-11-wireless.ssid']).toBeUndefined()
      const cfg = parse.configFrom(props)
      if (name === 'shared') expect(cfg).toBeUndefined()
      else if (name === 'manual') expect(cfg).toEqual({ method: 'manual', address: '192.168.80.150', prefix: 24,
        gateway: '192.168.80.2', dns: { mode: 'router' } })
      else expect(cfg).toEqual({ method: 'auto', dns: name === 'auto' ? { mode: 'auto' } : { mode: 'preset', preset: 'quad9' } })
    }
    expect(parse.values(parse.properties('IP4.DNS[2]:1.0.0.1\nIP4.DNS[1]:1.1.1.1'), 'IP4.DNS')).toEqual(['1.1.1.1', '1.0.0.1'])
    expect(parse.configFrom({ 'ipv4.method': 'auto', 'ipv4.ignore-auto-dns': 'yes', 'ipv4.dns': '10.0.0.53,10.0.0.54' }))
      .toEqual({ method: 'auto', dns: { mode: 'custom', servers: ['10.0.0.53', '10.0.0.54'] } })
  })
  it('reads zero, one and multiple default routes', () => {
    for (const name of ['route-default-1.json', 'route-default-1b.json']) {
      expect(parse.routes(fixture(name))).toEqual([{ device: 'ens160', gateway: '192.168.80.2', metric: 100 }])
    }
    expect(parse.routes('[]')).toEqual([])
    expect(parse.routes('[{"dst":"default","dev":"eth0"},{"dst":"default","dev":"wlan0","metric":20}]')).toHaveLength(2)
  })
  it('recognises DNS presets only in their original server order', () => {
    const props = { 'ipv4.method': 'auto', 'ipv4.ignore-auto-dns': 'yes', 'ipv4.dns': '1.0.0.1,1.1.1.1' }
    expect(parse.configFrom(props)).toEqual({ method: 'auto', dns: { mode: 'custom', servers: ['1.0.0.1', '1.1.1.1'] } })
    props['ipv4.dns'] = '1.1.1.1,1.0.0.1'
    expect(parse.configFrom(props)).toEqual({ method: 'auto', dns: { mode: 'preset', preset: 'cloudflare' } })
  })
  it('reads reachable and incomplete neighbours', () => {
    for (const last of ['1', '2', '151']) {
      const result = parse.neighbours(fixture(`neigh-192.168.80.${last}.json`))[0]!
      expect(result.states).toEqual([last === '151' ? 'INCOMPLETE' : 'REACHABLE'])
      expect(!!result.lladdr).toBe(last !== '151')
    }
  })
  it('reads the exact busctl JSON shapes, including the captured create annotation', () => {
    expect(parse.busPath(fixture('busctl-device-path.json'))).toBe('/org/freedesktop/NetworkManager/Devices/2')
    expect(parse.busPath(fixture('busctl-settings-path.json'))).toBe('/org/freedesktop/NetworkManager/Settings/2')
    expect(parse.busPath(fixture('busctl-create.json'))).toBe(NM_CHECKPOINT)
    expect(parse.busPaths(fixture('busctl-checkpoints-empty.json'))).toEqual([])
    expect(parse.busPaths(fixture('busctl-checkpoints-one.json'))).toEqual([NM_CHECKPOINT])
    expect(parse.busBool(fixture('busctl-unsaved-false.json'))).toBe(false)
    expect(parse.busBool(fixture('busctl-unsaved-true.json'))).toBe(true)
    expect(parse.busRollback(fixture('busctl-rollback.json'))).toEqual({ '/org/freedesktop/NetworkManager/Devices/2': 0 })
    expect(() => parse.busRollback('{"type":"a{su}","data":[{"dev":"0"}]}')).toThrow()
    expect(() => parse.busBool('{"type":"b","data":"false"}')).toThrow()
  })
})
