import { describe, expect, it, vi } from 'vitest'
import { MpvController } from '../../src/main/player/MpvController'
import { MpvTransport } from '../../src/main/player/mpv/MpvTransport'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { silentLog } from '../../src/main/log/Logger'
import { FakeMpv } from '../fixtures/fake-mpv'
import { until } from './helpers'

describe('external subtitle selection', () => {
  it.each([1, 3, 4])('resolves planned subtitle %s with embedded and external tracks', async (subtitle) => {
    const server = new FakeMpv(); await server.start()
    const transport = new MpvTransport(server.path), source = new FixtureSource(), warn = vi.fn()
    const movie = (await source.rows()).latest.find((item) => item.type === 'movie')!
    const plan = await source.playback(movie.id, { resume: false })
    const original = transport.request.bind(transport)
    const request = vi.spyOn(transport, 'request').mockImplementation((command) => {
      if (subtitle !== 1 && command[0] === 'sub-add' && command[1] === 'https://test/two') {
        return Promise.reject(new Error('not found'))
      }
      if (command[0] === 'get_property' && command[1] === 'track-list') return Promise.resolve([
        { type: 'sub', id: 1 },
        { type: 'sub', id: 7, external: true, 'external-filename': 'https://test/one' },
        { type: 'sub', id: 8, external: true, 'external-filename': 'https://test/three' },
      ])
      return original(command)
    })
    const player = new MpvController({ transport, logger: { ...silentLog, warn } })
    try {
      await player.play({ ...plan, selection: { subtitle },
        subtitles: ['one', 'two', 'three'].map((name) => ({ url: `https://test/${name}` })) }, source)
      if (subtitle === 1) {
        await until(() => server.properties.get('sid') === 1)
        expect(request).toHaveBeenCalledWith(['set_property', 'sid', 1])
        expect(warn).not.toHaveBeenCalled()
      } else if (subtitle === 4) {
        await until(() => server.properties.get('sid') === 8)
        expect(request).toHaveBeenCalledWith(['set_property', 'sid', 8])
      } else {
        await until(() => warn.mock.calls.length === 2)
        expect(request.mock.calls.some(([command]) => command[1] === 'sid')).toBe(false)
        expect(warn.mock.lastCall).toEqual(['The chosen subtitles could not be loaded; keeping the player defaults'])
      }
      expect(request.mock.calls.filter(([command]) => command[0] === 'sub-add')).toHaveLength(3)
    } finally { await player.dispose(); source.dispose(); await server.dispose() }
  })
})
