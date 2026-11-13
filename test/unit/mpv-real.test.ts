import { expect, it } from 'vitest'
import { FixtureSource } from '../../src/main/sources/fixture/FixtureSource'
import { MpvController } from '../../src/main/player/MpvController'
import { findMpv } from '../../src/main/player/mpv/MpvProcess'

const binary = await findMpv()

it.skipIf(!binary)('real mpv reaches playing then ended (skipped: no mpv on PATH or MEDIAOS_MPV)', async () => {
  const source = new FixtureSource()
  const item = (await source.rows()).latest[0]!
  const plan = await source.playback(item.id, { resume: false })
  const player = new MpvController({ processOptions: { mpvPath: binary,
    extraArgs: ['--vo=null', '--ao=null', '--force-window=no', '--hwdec=no', '--no-config'] } })
  let playing = false
  const ended = new Promise<void>((resolve, reject) => {
    player.onState((state) => {
      if (state.status === 'playing') playing = true
      if (state.status === 'ended') resolve()
      if (state.status === 'error') reject(new Error(state.error))
    })
  })
  try {
    await player.play({ ...plan, url: 'av://lavfi:testsrc2=size=320x240:rate=25:duration=3', durationSec: 3 }, source)
    await ended
    expect(playing).toBe(true); expect(player.state().status).toBe('ended')
  } finally { await player.dispose(); source.dispose() }
})
