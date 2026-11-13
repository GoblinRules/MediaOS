// End-to-end checks of Settings > Network > IP settings and the "Keep these settings?" trial, in mock mode
// (docs/design/network.md sections 2, 4 and 7). The mock LAN is 192.168.1.0/24 with the router at .1.
import { expect, test, type Page } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

let box: Box | undefined

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
})

const SAVED = 'New network settings saved.'
const PUT_BACK = 'The old network settings are back.'
const EXPIRED = 'No answer, so MediaOS put the old network settings back.'
const RESET = 'Network set back to automatic. It can take up to a minute to reconnect.'

async function readyAtNetwork(env?: Record<string, string>): Promise<Page> {
  box = await launch({ env })
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await expect(page.getByTestId('settings-page-network')).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('net-status')).toHaveClass(/is-focused/)
  return page
}

/** Press `key` until the item with this test id has the focus ring. */
async function moveTo(page: Page, testId: string, key: string, max = 12): Promise<void> {
  const target = page.getByTestId(testId)
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)) return
    await press(page, key)
  }
  await expect(target).toHaveClass(/is-focused/)
}

/** On a choice row: open its list and pick the choice with this value. */
async function choose(page: Page, row: string, value: string): Promise<void> {
  await moveTo(page, row, 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await moveTo(page, `menu-${value}`, 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
}

/** On an address row: open the number pad, replace the address, press Done. */
async function typeAddress(page: Page, row: string, value: string): Promise<void> {
  await moveTo(page, row, 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('keyboard-pad')).toBeVisible()
  // Backspace on an empty field closes the pad, so delete exactly what is there.
  const old = (await page.getByTestId('keyboard-value').innerText()).trim()
  if (/^[0-9.]+$/.test(old)) await press(page, 'Backspace', old.length)
  await page.keyboard.type(value)
  await expect(page.getByTestId('keyboard-value')).toHaveText(value)
  // The pad starts on 1; four Downs reach Clear on the bottom row, and Done is to its right.
  await press(page, 'ArrowDown', 4)
  await moveTo(page, 'keyboard-done', 'ArrowRight', 2)
  await press(page, 'Enter')
  await expect(page.getByTestId('keyboard-overlay')).toHaveCount(0)
  await expect(page.getByTestId(row)).toContainText(value)
}

/** From the Network page: open IP settings, set a fixed address and router, and press "Save and test". */
async function startTrial(page: Page, address: string, gateway?: string): Promise<void> {
  await moveTo(page, 'net-ip', 'ArrowDown')
  await expect(page.getByTestId('net-ip')).toContainText('Automatic')
  await press(page, 'Enter')
  await expect(page.getByTestId('ip-settings')).toBeVisible()
  await expect(page.getByTestId('ip-method')).toHaveClass(/is-focused/)
  await choose(page, 'ip-method', 'manual')
  await typeAddress(page, 'ip-address', address)
  if (gateway) await typeAddress(page, 'ip-gateway', gateway)
  await expect(page.getByTestId('ip-dns')).toContainText('Use my router')
  await expect(page.getByTestId('ip-problem')).toHaveCount(0)
  await moveTo(page, 'ip-save', 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('net-trial')).toBeVisible()
  await expect(page.getByTestId('net-trial-revert')).toHaveClass(/is-focused/)
}

test('a fixed address that works can be kept', async () => {
  const page = await readyAtNetwork()
  await startTrial(page, '192.168.1.60')
  await expect(page.getByTestId('net-trial-address')).toContainText('192.168.1.60')
  await expect(page.getByTestId('net-trial-router')).toHaveAttribute('data-state', 'ok')
  await expect(page.getByTestId('net-trial-internet')).toHaveAttribute('data-state', 'ok')
  await press(page, 'ArrowRight')
  await expect(page.getByTestId('net-trial-keep')).toHaveClass(/is-focused/)
  await press(page, 'Enter')
  await expect(page.getByTestId('toasts')).toContainText(SAVED)
  await expect(page.getByTestId('net-trial')).toHaveCount(0)
  await expect(page.getByTestId('net-ip')).toContainText('Fixed: 192.168.1.60')
  await expect(page.getByTestId('net-ip')).toHaveClass(/is-focused/)
})

test('settings that cannot reach the router cannot be kept, and the old ones come back by themselves', async () => {
  const page = await readyAtNetwork({ MEDIAOS_NET_TRIAL_SEC: '4' })
  await startTrial(page, '10.0.0.20', '10.0.0.1')
  await expect(page.getByTestId('net-trial-router')).toHaveAttribute('data-state', 'failed')
  await expect(page.getByTestId('net-trial-router')).toContainText('Not answering')
  await expect(page.getByTestId('net-trial-keep')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('toasts')).toContainText(EXPIRED, { timeout: 10_000 })
  await expect(page.getByTestId('net-trial')).toHaveCount(0)
  await expect(page.getByTestId('net-ip')).toContainText('Automatic')
})

test('during a trial Home waits, a long Home puts the old settings back, and Recovery can reset the network', async () => {
  const page = await readyAtNetwork()
  await startTrial(page, '192.168.1.61')
  // A short Home leaves the question on screen.
  await press(page, 'F1')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('net-trial')).toBeVisible()
  await expect(page.getByTestId('net-trial-revert')).toHaveClass(/is-focused/)
  // A long Home (Recovery) puts the old settings back first.
  await page.keyboard.down('F1')
  await page.waitForTimeout(1700)
  await page.keyboard.up('F1')
  await expect(page.getByTestId('menu-overlay')).toContainText('Recovery')
  await expect(page.getByTestId('toasts')).toContainText(PUT_BACK)
  await expect(page.getByTestId('net-trial')).toHaveCount(0)
  await moveTo(page, 'menu-rec-net-reset', 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('confirm-cancel')).toHaveClass(/is-focused/)
  await moveTo(page, 'confirm-ok', 'ArrowRight', 2)
  await press(page, 'Enter')
  await expect(page.getByTestId('toasts')).toContainText(RESET)
})

test('IP settings for a saved Wi-Fi network ask you to connect to it first', async () => {
  const page = await readyAtNetwork()
  await moveTo(page, 'net-ap-home', 'ArrowDown')
  await expect(page.getByTestId('net-ap-home')).toContainText('Saved')
  await press(page, 'ContextMenu')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await moveTo(page, 'menu-ip', 'ArrowDown')
  await press(page, 'Enter')
  await expect(page.getByTestId('toasts')).toContainText('Connect to Home Wi-Fi first')
  await expect(page.getByTestId('ip-settings')).toHaveCount(0)
})
