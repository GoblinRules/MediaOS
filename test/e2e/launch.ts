// Starts the built app (out/) under Playwright in mock mode with a throwaway data folder.
// `npm run e2e` builds first; when running `playwright test` directly, run `npm run build` before it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

export interface Box {
  app: ElectronApplication
  page: Page
  dataDir: string
  /** Milliseconds from starting the process to the first screen (setup or Home) being visible. */
  startMs: number
}

// Data folders made by this test worker. Tests may relaunch on the same folder (to check settings persist), so they
// are removed when the worker exits rather than when an app closes. Each is ~8 MB; left behind, a few hundred mutation
// runs filled the disk.
const made = new Set<string>()
process.once('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A file still held open by a closing Electron is left for the OS temp cleaner.
    }
  }
})

export function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mediaos-e2e-'))
  made.add(dir)
  return dir
}

export async function launch(opts: { dataDir?: string; size?: string; env?: Record<string, string> } = {}): Promise<Box> {
  const dataDir = opts.dataDir ?? freshDataDir()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // The T3 shell sets this, which would make Electron run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  env.MEDIAOS_DATA_DIR = dataDir
  env.MEDIAOS_MOCK_PLAYER = '1'
  // Windows open off-screen and never take focus, so tests don't pop up over whatever you are working on.
  // Set MEDIAOS_E2E_VISIBLE=1 to watch them instead.
  if (process.env.MEDIAOS_E2E_VISIBLE !== '1') env.MEDIAOS_BACKGROUND = '1'
  // 'full' means fullscreen (1920x1080 on a 1080p screen); a fixed window on this PC gets shrunk to fit the taskbar.
  if (opts.size === 'full') delete env.MEDIAOS_WINDOW
  else env.MEDIAOS_WINDOW = opts.size ?? '1280x720'
  Object.assign(env, opts.env)
  const started = Date.now()
  const app = await _electron.launch({ args: ['out/main/index.js'], env })
  const page = await app.firstWindow()
  await expect(page.locator('[data-testid="setup"], [data-testid="home"]').first()).toBeVisible({ timeout: 20_000 })
  return { app, page, dataDir, startMs: Date.now() - started }
}

/** Press a key `times` times, giving focus and React a moment to settle between presses. */
export async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key)
    await page.waitForTimeout(90)
  }
}

/** The single item that has the TV focus ring. */
export function focused(page: Page): Locator {
  return page.locator('.is-focused').first()
}

export async function expectFocus(page: Page, text: string | RegExp): Promise<void> {
  await expect(focused(page)).toContainText(text)
}

/** Walk the first-run steps with the keyboard and land on Home. */
export async function finishSetup(page: Page): Promise<void> {
  const setup = page.getByTestId('setup')
  await expect(setup).toHaveAttribute('data-step', 'welcome')
  await expectFocus(page, "Let's start")
  await press(page, 'Enter')
  await expect(setup).toHaveAttribute('data-step', 'network')
  await expectFocus(page, /Next|Skip for now/)
  await press(page, 'Enter')
  await expect(setup).toHaveAttribute('data-step', 'libraries')
  await expectFocus(page, 'Add Jellyfin')
  await press(page, 'ArrowDown')
  await press(page, 'ArrowRight')
  await expectFocus(page, /Next|Skip for now/)
  await press(page, 'Enter')
  await expect(setup).toHaveAttribute('data-step', 'done')
  await press(page, 'Enter')
  await expect(page.getByTestId('home')).toBeVisible()
}

/** Go to a top tab the way a remote would: Home, up to the tab bar, across, OK. */
export async function openTab(page: Page, label: 'Home' | 'Libraries' | 'Apps' | 'Search' | 'Settings'): Promise<void> {
  const order = ['Home', 'Libraries', 'Apps', 'Search', 'Settings']
  await press(page, 'F1')
  await expect(page.getByTestId('home')).toBeVisible()
  await press(page, 'ArrowUp', 4)
  await expectFocus(page, 'Home')
  await press(page, 'ArrowRight', order.indexOf(label))
  await expectFocus(page, label)
  await press(page, 'Enter')
}
