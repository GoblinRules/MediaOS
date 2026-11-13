// The user's settings, loaded once at start and replaced with core's copy after every update.
import type { Settings, SettingsPatch } from '@shared/settings-schema'
import { call, errorText } from '../lib/api'
import { createStore, useStore } from '../lib/store'
import { toast } from './toasts'

export const settingsStore = createStore<Settings | undefined>(undefined)

export async function loadSettings(): Promise<Settings> {
  const s = await call('settings.get')
  settingsStore.set(s)
  return s
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Send only the fields that changed: core merges them one level deep into its own (newest) copy. Updates go one at a
 * time, so replies can never arrive out of order. Pass a function when the patch depends on the current settings
 * (for example adding to a list): it runs once the earlier updates have landed, so two quick edits both survive.
 */
export function updateSettings(patch: SettingsPatch | ((current: Settings) => SettingsPatch | undefined)): Promise<boolean> {
  const job = queue.then(async () => {
    const current = settingsStore.get()
    const p = typeof patch === 'function' ? (current ? patch(current) : undefined) : patch
    if (!p) return false
    try {
      settingsStore.set(await call('settings.update', p))
      return true
    } catch (err) {
      toast(errorText(err), 'error')
      // Core may have saved part of an earlier change, so show its copy rather than guess.
      await loadSettings().catch(() => undefined)
      return false
    }
  })
  queue = job.catch(() => undefined)
  return job
}

/** Settings inside the app (the App only renders once they are loaded). */
export function useSettings(): Settings {
  const s = useStore(settingsStore)
  if (!s) throw new Error('Settings are not loaded yet')
  return s
}

export function getSettings(): Settings | undefined {
  return settingsStore.get()
}
