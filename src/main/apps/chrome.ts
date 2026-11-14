import type { AppRoute } from '../../shared/vpn-types'
import * as fs from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import type { AppEntry } from '@shared/apps'
import { SourceError } from '../sources/MediaSource'
import { atomicWrite, missing, type FileSystem } from '../settings/atomic'
import { silentLog, type Log } from '../log/Logger'

export function checkApp(app: AppEntry): void {
  if (app.blocked) throw new SourceError(app.note ?? "This app isn't available on this device.", 'unsupported')
}
export function profilePath(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new SourceError('That app could not be found. Choose another app.', 'notFound')
  const path = resolve(root, id)
  const rel = relative(resolve(root), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Profile must be inside the profiles folder')
  return path
}
export function chromeArgs(
  app: AppEntry, opts: { profileDir: string; chromePath: string; extraArgs?: string[] }, route: AppRoute,
): string[] {
  checkApp(app)
  return [`--app=${app.url}`, `--user-data-dir=${profilePath(opts.profileDir, app.id)}`, '--kiosk', '--start-fullscreen',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--disable-features=Translate,MediaRouter', '--autoplay-policy=no-user-gesture-required', `--class=mediaos-app-${app.id}`,
    // Ordinary websites ignore arrow keys (they only scroll); this lets the remote's arrows move between links and buttons.
    // TV-style apps (YouTube TV) handle the arrows themselves, so they don't get it.
    ...(app.nav === 'pointer' ? ['--enable-spatial-navigation'] : []),
    ...(opts.extraArgs ?? []), ...(app.ua ? [`--user-agent=${app.ua}`] : []),
    ...(route.kind === 'vpn' ? [`--proxy-server=socks5://127.0.0.1:${route.port}`,
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--disable-quic'] : ['--no-proxy-server'])]
}

/** Chrome on the TV: a Wayland window under sway, no keyring prompt, no "restore pages?" bubble. */
export const LINUX_CHROME_ARGS = ['--ozone-platform=wayland', '--password-store=basic', '--hide-crash-restore-bubble']

export async function prepareProfile(dir: string, io: FileSystem = fs, logger: Log = silentLog): Promise<void> {
  await io.mkdir(dir, { recursive: true })
  const prefsFile = join(dir, 'Default', 'Preferences')
  try {
    const text = await io.readFile(prefsFile, 'utf8')
    let prefs: Record<string, unknown>
    try {
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid preferences')
      prefs = raw as Record<string, unknown>
    } catch { prefs = {}; logger.warn('Chrome preferences damaged; starting empty') }
    const old = prefs.profile
    prefs.profile = { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}),
      exited_cleanly: true, exit_type: 'Normal' }
    await atomicWrite(prefsFile, `${JSON.stringify(prefs)}\n`, undefined, io)
  } catch (error) { if (!missing(error)) throw error }
  for (const file of await io.readdir(dir)) {
    if (file.startsWith('Singleton')) await io.rm(join(dir, file), { force: true })
  }
}
