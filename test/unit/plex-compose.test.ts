import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { composeCore } from '../../src/main/core/compose'
import { handleCall } from '../../src/main/core/ipc'
import { defaultSettings } from '../../src/shared/settings-schema'
import { plexReplay, temporary } from './helpers'

describe('Plex composition', () => {
  it('loads saved Plex sources in mock mode and persists a rediscovered connection, with missing secrets signed-out', async () => {
    const temp = await temporary(), fake = plexReplay()
    const sources = ['saved', 'missing'].map((id) => ({ id, kind: 'plex', name: `Plex ${id}`,
      url: 'http://192.168.1.99:32400', serverId: 'server-a', userId: '42', userName: 'Maya', enabled: true }))
    await writeFile(join(temp.dir, 'settings.json'), JSON.stringify({ ...defaultSettings(), sources, demoRemoved: true }), 'utf8')
    await writeFile(join(temp.dir, 'secrets.json'), JSON.stringify({ saved: {
      token: 'private-server-a', accountToken: 'private-account', clientId: 'stable-device',
    } }), 'utf8')
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, fetch: fake.fetch, restartShell() {} })
    try {
      const list = await handleCall(composed.core, 'sources.list', [])
      expect(list).toMatchObject({ ok: true, value: [{ id: 'saved', kind: 'plex', status: 'ok' },
        { id: 'missing', status: 'signed-out' }, { id: 'folders', status: 'ok' }] })
      expect((await handleCall(composed.core, 'libraries.list', [])).ok).toBe(true)
      expect(fake.calls.length).toBeGreaterThan(0)
      expect(fake.calls.every((c) => c.headers.get('X-Plex-Client-Identifier') === 'stable-device')).toBe(true)
    } finally { await composed.dispose() }
    try {
      const settings = await readFile(join(temp.dir, 'settings.json'), 'utf8')
      expect(JSON.parse(settings)).toMatchObject({ sources: [{ id: 'saved', url: 'https://home-a.plex.direct:32400' },
        { id: 'missing' }] })
      expect(settings).not.toContain('private-')
    } finally { await temp.dispose() }
  })
  it('uses real Plex PIN sign-in when real sources are enabled', async () => {
    const temp = await temporary(), fake = plexReplay()
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, realSystem: ['sources'], mockDelayMs: 0, fetch: fake.fetch, restartShell() {} })
    try {
      expect(await handleCall(composed.core, 'plex.pin', [])).toMatchObject({ ok: true, value: { code: 'ABCD', where: 'plex.tv/link' } })
    } finally { await composed.dispose(); await temp.dispose() }
  })
})
