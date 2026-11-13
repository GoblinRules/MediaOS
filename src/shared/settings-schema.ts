// User settings: versioned with step-by-step migrations. Secrets (tokens) are NOT stored here; see SecretStore.
import { z } from 'zod'
import { MAX_SOURCES } from './limits'

export const SETTINGS_VERSION = 1

export const HomeRowId = z.enum(['continue', 'nextUp', 'apps', 'latest', 'libraries'])
export type HomeRowId = z.infer<typeof HomeRowId>

export const SourceConfig = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['jellyfin', 'plex', 'fixture']),
  name: z.string().min(1).max(80),
  /** Jellyfin: server URL. Plex: the last connection that worked (rechecked, and replaced if a better one answers). */
  url: z.string().max(500).optional(),
  serverId: z.string().max(200).optional(),
  userId: z.string().max(200).optional(),
  userName: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
})
export type SourceConfig = z.infer<typeof SourceConfig>

export const Settings = z.object({
  version: z.literal(SETTINGS_VERSION),
  setupDone: z.boolean().default(false),
  deviceName: z.string().min(1).max(63).default('MediaOS'),
  language: z.string().max(20).default('en-GB'),
  updates: z.object({ auto: z.boolean().default(true) }).prefault({}),
  sources: z.array(SourceConfig).max(MAX_SOURCES).default([]),
  /** Mock mode: the user removed the built-in demo library, so don't add it back on start. */
  demoRemoved: z.boolean().default(false),
  home: z
    .object({
      rows: z.array(HomeRowId).default(['continue', 'nextUp', 'apps', 'latest', 'libraries']),
      hiddenRows: z.array(HomeRowId).default([]),
      hero: z.boolean().default(true),
      mergeContinue: z.boolean().default(true),
    })
    .prefault({}),
  apps: z
    .object({
      /** Catalogue ids pinned to the Home "Apps" row, in order. */
      pinned: z.array(z.string().max(64)).max(40).default(['youtube', 'netflix', 'iplayer', 'itvx', 'disney', 'prime']),
      hidden: z.array(z.string().max(64)).max(80).default([]),
      pointerHintsShown: z.number().int().min(0).max(10).default(0),
    })
    .prefault({}),
  playback: z
    .object({
      skipBackSec: z.number().int().min(5).max(60).default(10),
      skipForwardSec: z.number().int().min(5).max(120).default(30),
      autoPlayNext: z.boolean().default(true),
      audioLanguage: z.string().max(10).default('eng'),
      subtitleLanguage: z.string().max(10).default(''),
      subtitleMode: z.enum(['off', 'forced', 'always']).default('forced'),
      subtitleSize: z.enum(['small', 'medium', 'large']).default('medium'),
      preferDirectPlay: z.boolean().default(true),
    })
    .prefault({}),
  display: z
    .object({
      screensaverMin: z.number().int().min(0).max(120).default(10),
      screenOffMin: z.number().int().min(0).max(600).default(0),
      uiScale: z.number().min(0.75).max(1.5).default(1),
    })
    .prefault({}),
  sound: z
    .object({
      channels: z.enum(['stereo', '5.1', '7.1']).default('stereo'),
      uiSounds: z.boolean().default(false),
    })
    .prefault({}),
  cec: z
    .object({
      wakeTvOnStart: z.boolean().default(true),
      standbyTvOnPowerOff: z.boolean().default(true),
    })
    .prefault({}),
  remote: z
    .object({
      phoneRemote: z.boolean().default(true),
      port: z.number().int().min(1024).max(65535).default(8080),
    })
    .prefault({}),
  weather: z
    .object({
      enabled: z.boolean().default(true),
      /** The town picked in Settings > Home screen; null until one is chosen (the weather stays hidden till then). */
      place: z
        .object({
          name: z.string().min(1).max(120),
          region: z.string().max(120).optional(),
          country: z.string().max(120).optional(),
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
        })
        .nullable()
        .default(null),
      units: z.enum(['c', 'f']).default('c'),
    })
    .prefault({}),
  /** Learned buttons: evdev/DOM key code -> action. */
  keymap: z.record(z.string().max(64), z.string().max(32)).default({}),
})
export type Settings = z.infer<typeof Settings>

/** Partial update sent from the UI. Top-level keys are replaced/merged one level deep by SettingsStore. */
export type SettingsPatch = {
  [K in Exclude<keyof Settings, 'version'>]?: Settings[K] extends unknown[] | Record<string, string>
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K]
}

/** Strip defaults so a patch only ever carries the fields the caller sent (a missing field must stay missing). */
function withoutDefaults(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) return withoutDefaults(schema.unwrap() as z.ZodType)
  return schema
}

function patchField(schema: z.ZodType): z.ZodType {
  const inner = withoutDefaults(schema)
  if (inner instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(inner.shape).map(([k, v]) => [k, withoutDefaults(v as z.ZodType).optional()]))
    return z.object(shape).optional()
  }
  return inner.optional()
}

export const SettingsPatch = z.object(
  Object.fromEntries(
    Object.entries(Settings.shape)
      .filter(([k]) => k !== 'version')
      .map(([k, v]) => [k, patchField(v as z.ZodType)]),
  ),
) as unknown as z.ZodType<SettingsPatch>

export function defaultSettings(): Settings {
  return Settings.parse({ version: SETTINGS_VERSION })
}

/**
 * Migrations: index n upgrades version n -> n+1. Each takes and returns raw JSON.
 * Add a function here (and bump SETTINGS_VERSION) whenever the shape changes incompatibly.
 */
export const MIGRATIONS: ReadonlyArray<(raw: Record<string, unknown>) => Record<string, unknown>> = [
  // v0 -> v1: pre-release files had no version field.
  (raw) => ({ ...raw, version: 1 }),
]

/** Parse any stored JSON into current Settings, running migrations. Throws on unrecoverable shapes. */
export function migrateSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Settings file is not an object')
  let obj = raw as Record<string, unknown>
  let v = typeof obj.version === 'number' ? obj.version : 0
  if (v > SETTINGS_VERSION) throw new Error(`Settings file is from a newer version (${v})`)
  while (v < SETTINGS_VERSION) {
    const step = MIGRATIONS[v]
    if (!step) throw new Error(`No migration from settings version ${v}`)
    obj = step(obj)
    v += 1
  }
  return Settings.parse(obj)
}
