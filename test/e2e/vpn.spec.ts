// End-to-end checks of Settings > VPN and the per-app VPN dialogs in mock mode (docs/design/vpn.md section 7).
// The location comes from MEDIAOS_VPN_IMPORT (the developer file path); the WireGuard file uses random throwaway keys.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

let box: Box | undefined
let dir: string | undefined
const OUT = 'test-results/screens'

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A full-tunnel WireGuard file with a PostUp line MediaOS strips. Keys are random and unused anywhere. */
function wireGuardFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'mediaos-vpn-e2e-'))
  const file = join(dir, 'uk-london.conf')
  const key = (): string => randomBytes(32).toString('base64')
  writeFileSync(file, [
    '[Interface]', `PrivateKey = ${key()}`, 'Address = 10.64.0.2/32', 'DNS = 10.64.0.1', 'PostUp = echo hi', '',
    '[Peer]', `PublicKey = ${key()}`, 'AllowedIPs = 0.0.0.0/0, ::/0', 'Endpoint = 203.0.113.10:51820', '',
  ].join('\n'))
  return file
}

async function moveTo(page: Page, testId: string, key: string, max = 14): Promise<void> {
  const target = page.getByTestId(testId)
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)) return
    await press(page, key)
  }
  const at = await page.evaluate("document.querySelector('.is-focused')?.getAttribute('data-focus-key') ?? 'nothing'")
  await expect(target, `focus is on ${String(at)}`).toHaveClass(/is-focused/)
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/vpn-${name}.png` })
}

async function openVpnPage(scenario: string, size?: string): Promise<Page> {
  box = await launch({ size, env: { MEDIAOS_VPN_IMPORT: wireGuardFile(), MEDIAOS_VPN_SCENARIO: scenario } })
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await moveTo(page, 'settings-nav-vpn', 'ArrowDown')
  await expect(page.getByTestId('settings-page-vpn')).toBeVisible()
  await press(page, 'Enter')
  return page
}

/** From the empty VPN page: add the location, set every app to use it, and turn the VPN on. */
async function setUp(page: Page, shots = false): Promise<void> {
  await expect(page.getByTestId('vpn-intro')).toBeVisible()
  if (shots) await shot(page, '01-intro')
  await moveTo(page, 'vpn-add', 'ArrowDown')
  await press(page, 'Enter')
  const flow = page.getByTestId('vpn-add-flow')
  await expect(flow).toHaveAttribute('data-step', 'name')
  await expect(page.getByTestId('vpn-add-removed')).toContainText('PostUp')
  if (shots) await shot(page, '02-name')
  await moveTo(page, 'vpn-add-save', 'ArrowDown')
  await press(page, 'Enter')
  await expect(flow).toHaveAttribute('data-step', 'done')
  if (shots) await shot(page, '03-done')
  await moveTo(page, 'vpn-add-apps', 'ArrowLeft')
  await press(page, 'Enter')

  await expect(page.getByTestId('vpn-apps-view')).toBeVisible()
  await expect(page.getByTestId('vpn-app-youtube')).toContainText('Not used')
  await moveTo(page, 'vpn-all-on', 'ArrowUp')
  await press(page, 'Enter')
  await expect(page.getByTestId('vpn-app-youtube')).toContainText('VPN only')
  await expect(page.getByTestId('vpn-app-netflix')).toContainText('May not work over a VPN')
  // NOW is blocked on Linux, so it has no VPN choice.
  await expect(page.getByTestId('vpn-app-now')).toHaveCount(0)
  if (shots) await shot(page, '04-apps')
  await press(page, 'Escape')

  await expect(page.getByTestId('vpn-apps')).toHaveClass(/is-focused/)
  await expect(page.getByTestId('vpn-status')).toContainText('The VPN is off.')
  await moveTo(page, 'vpn-enabled', 'ArrowUp')
  await press(page, 'Enter')
}

test('add a location, choose apps and connect', async () => {
  test.setTimeout(90_000)
  const page = await openVpnPage('vpn-default')
  await setUp(page, true)
  await expect(page.getByTestId('vpn-status')).toContainText('Connected to')
  await moveTo(page, 'vpn-check', 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('vpn-check')).toContainText('The VPN is working.')
  await shot(page, '05-connected')

  await openTab(page, 'Apps')
  await expect(page.getByTestId('apps')).toBeVisible()
  await expect(page.getByTestId('app-vpn-badge').first()).toBeVisible()
  await shot(page, '06-badges')
})

test('an app set to "don\'t open" is stopped when the VPN is down', async () => {
  test.setTimeout(90_000)
  const page = await openVpnPage('vpn-down')
  await setUp(page)
  await expect(page.getByTestId('vpn-status')).toContainText(/Not connected|Connecting/)

  await openTab(page, 'Apps')
  await expect(page.getByTestId('apps')).toBeVisible()
  await press(page, 'Enter')
  const dialog = page.getByTestId('menu-overlay')
  await expect(dialog).toContainText("can't open right now")
  await expect(dialog).toContainText('your normal connection is never used by mistake')
  await expect(page.getByTestId('app-running')).toHaveCount(0)
  await shot(page, '07-blocked')
})

test('a file the mock cannot save shows the save error', async () => {
  test.setTimeout(60_000)
  const page = await openVpnPage('vpn-import-errors')
  await moveTo(page, 'vpn-add', 'ArrowDown')
  await press(page, 'Enter')
  await moveTo(page, 'vpn-add-save', 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('vpn-add-flow')).toHaveAttribute('data-step', 'error')
  await expect(page.getByTestId('vpn-add-error')).toContainText("couldn't be saved")
  await shot(page, '08-error')
  await press(page, 'Escape')
  await expect(page.getByTestId('vpn-intro')).toBeVisible()
  await expect(page.getByTestId('vpn-add')).toHaveClass(/is-focused/)
})
