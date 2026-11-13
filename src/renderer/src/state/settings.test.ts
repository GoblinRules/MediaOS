// Settings writes go one at a time and each patch is built from the newest saved copy (review findings 14 and 15).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings, type SettingsPatch } from '@shared/settings-schema'

const calls: { name: string; patch: unknown; resolve: (v: Settings) => void; reject: (e: Error) => void }[] = []
let saved: Settings
const base = defaultSettings().apps.pinned

vi.mock('../lib/api', () => ({
  call: vi.fn((name: string, patch?: SettingsPatch) => {
    if (name === 'settings.get') return Promise.resolve(saved)
    return new Promise((resolve, reject) => calls.push({ name, patch, resolve, reject }))
  }),
  errorText: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}))
vi.mock('./toasts', () => ({ toast: vi.fn() }))

const { settingsStore, updateSettings } = await import('./settings')
const { toast } = await import('./toasts')

/** Let queued promise callbacks run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function withPinned(pinned: string[]): Settings {
  return { ...saved, apps: { ...saved.apps, pinned } }
}

describe('updateSettings', () => {
  beforeEach(() => {
    calls.length = 0
    saved = defaultSettings()
    settingsStore.set(saved)
    vi.mocked(toast).mockClear()
  })

  it('sends one update at a time and builds each from the newest settings, so two quick pins both stay', async () => {
    const add = (id: string) => (s: Settings): SettingsPatch => ({ apps: { pinned: [...s.apps.pinned, id] } })
    const first = updateSettings(add('x'))
    const second = updateSettings(add('y'))
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch).toEqual({ apps: { pinned: [...base, 'x'] } })
    saved = withPinned([...base, 'x'])
    calls[0]?.resolve(saved)
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.patch).toEqual({ apps: { pinned: [...base, 'x', 'y'] } })
    saved = withPinned([...base, 'x', 'y'])
    calls[1]?.resolve(saved)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(settingsStore.get()?.apps.pinned).toEqual([...base, 'x', 'y'])
  })

  it('shows what core really saved when a later update fails', async () => {
    const first = updateSettings({ apps: { pinned: ['x'] } })
    const second = updateSettings({ apps: { pinned: ['x', 'y'] } })
    await flush()
    saved = withPinned(['x'])
    calls[0]?.resolve(saved)
    await flush()
    // Core saved something else meanwhile (e.g. another screen): only a fresh read can show it.
    saved = withPinned(['x', 'z'])
    calls[1]?.reject(new Error('Could not save'))
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    await flush()
    expect(toast).toHaveBeenCalledWith('Could not save', 'error')
    expect(settingsStore.get()?.apps.pinned).toEqual(['x', 'z'])
  })

  it('sends nothing when the change works out to nothing', async () => {
    expect(await updateSettings(() => undefined)).toBe(false)
    await flush()
    expect(calls).toHaveLength(0)
    expect(toast).not.toHaveBeenCalled()
  })

  it('keeps going after a failure', async () => {
    const first = updateSettings({ apps: { pinned: ['x'] } })
    await flush()
    calls[0]?.reject(new Error('Could not save'))
    expect(await first).toBe(false)
    const second = updateSettings({ apps: { pinned: ['y'] } })
    await flush()
    expect(calls).toHaveLength(2)
    saved = withPinned(['y'])
    calls[1]?.resolve(saved)
    expect(await second).toBe(true)
    expect(settingsStore.get()?.apps.pinned).toEqual(['y'])
  })
})
