import { describe, expect, it, vi } from 'vitest'
import { Settings, defaultSettings } from '../../src/shared/settings-schema'
import { CALLS } from '../../src/shared/ipc-contract'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../../src/main/sources/limits'

// A smaller shared limit proves each boundary follows it rather than an independent literal.
vi.mock('../../src/shared/limits', () => ({ MAX_SOURCES: 2 }))

describe('shared library limit', () => {
  it('applies the shared limit to saved settings', () => {
    const sources = Array.from({ length: MAX_SOURCES }, (_, i) => ({
      id: `source-${i}`, name: `Library ${i}`, kind: 'fixture', enabled: true,
    }))
    expect(Settings.safeParse({ ...defaultSettings(), sources }).success).toBe(true)
    expect(Settings.safeParse({ ...defaultSettings(), sources: [...sources, { ...sources[0], id: 'extra' }] }).success).toBe(false)
  })
  it('applies the shared limit to Plex server selection and its explanation', () => {
    const ids = Array.from({ length: MAX_SOURCES }, (_, i) => `server-${i}`)
    expect(CALLS['plex.addServers'].safeParse(['flow', ids]).success).toBe(true)
    expect(CALLS['plex.addServers'].safeParse(['flow', [...ids, 'extra']]).success).toBe(false)
    expect(SOURCE_LIMIT_MESSAGE).toContain(`limit of ${MAX_SOURCES} libraries`)
  })
})
