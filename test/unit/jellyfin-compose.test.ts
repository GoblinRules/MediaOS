import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { composeCore } from '../../src/main/core/compose'
import { handleCall } from '../../src/main/core/ipc'
import { defaultSettings } from '../../src/shared/settings-schema'
import { temporary } from './helpers'

describe('Jellyfin composition', () => {
  it('loads saved real sources in mock mode, including signed-out sources with no secret', async () => {
    const temp = await temporary()
    const sources = ['saved', 'missing'].map((id) => ({ id, kind: 'jellyfin', name: `Jellyfin ${id}`,
      url: 'http://harbour:8096', serverId: 'server', userId: 'user', userName: 'Maya', enabled: true }))
    await writeFile(join(temp.dir, 'settings.json'), JSON.stringify({ ...defaultSettings(), sources, demoRemoved: true }), 'utf8')
    await writeFile(join(temp.dir, 'secrets.json'), JSON.stringify({ saved: { token: 'private-token', deviceId: 'device' } }), 'utf8')
    const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
      forceMockPlayer: true, mockDelayMs: 0, restartShell() {} })
    try {
      const list = await handleCall(composed.core, 'sources.list', [])
      expect(list.ok).toBe(true)
      if (list.ok) expect(list.value).toMatchObject([{ id: 'saved', status: 'ok' }, { id: 'missing', status: 'signed-out' }])
      expect(JSON.stringify(list)).not.toContain('private-token')
    } finally { await composed.dispose(); await temp.dispose() }
  })
  it('selects real sign-in for sources on Windows mock mode and retains mock sign-in by default', async () => {
    for (const real of [false, true]) {
      const temp = await temporary()
      const asked: string[] = []
      const fake = (async (input: URL | string | Request) => {
        asked.push(new URL(input instanceof Request ? input.url : String(input)).origin)
        return new Response(JSON.stringify({ id: 42, code: 'REALPIN1', expiresIn: 900 }),
          { status: 201, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      const composed = await composeCore({ platform: 'mock', dataDir: temp.dir, logDir: join(temp.dir, 'logs'),
        forceMockPlayer: true, mockDelayMs: 0, realSystem: real ? ['sources'] : undefined, fetch: fake, restartShell() {} })
      try {
        const result = await handleCall(composed.core, 'plex.pin', [])
        expect(result.ok).toBe(true)
        const value = (result.ok ? result.value : {}) as { where?: string; code?: string }
        expect(value.where).toBe('plex.tv/link')
        if (real) {
          expect(asked).toEqual(['https://plex.tv'])
          expect(value.code).toBe('REALPIN1')
        } else {
          expect(asked).toEqual([])
          expect(value.code).not.toBe('REALPIN1')
        }
      } finally { await composed.dispose(); await temp.dispose() }
    }
  })
})
