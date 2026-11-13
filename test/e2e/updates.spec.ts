// End-to-end check of Settings > System > Updates in mock mode: check, install, check again, go back. The mock box has
// MediaOS 0.1.0 and finds 0.2.0; going back marks 0.2.0 as skipped so it isn't installed overnight again.
import { expect, test, type Page } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

let box: Box | undefined

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
})

/** Press `key` until the item with this test id has the focus ring. */
async function moveTo(page: Page, testId: string, key: string, max = 20): Promise<void> {
  const target = page.getByTestId(testId)
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)) return
    await press(page, key)
  }
  await expect(target).toHaveClass(/is-focused/)
}

/** Answer the open question with its main button. */
async function confirmOk(page: Page): Promise<void> {
  await moveTo(page, 'confirm-ok', 'ArrowRight', 2)
  await press(page, 'Enter')
  await expect(page.getByTestId('confirm-overlay')).toHaveCount(0)
}

test('an update can be found, installed and then gone back from', async () => {
  box = await launch()
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await moveTo(page, 'settings-nav-system', 'ArrowDown')
  await press(page, 'Enter')

  const check = page.getByTestId('updates-check')
  await moveTo(page, 'updates-check', 'ArrowDown')
  await expect(check).toContainText('This box has MediaOS 0.1.0.')
  await expect(page.getByTestId('updates-install')).toHaveCount(0)
  await expect(page.getByTestId('updates-back')).toHaveCount(0)

  await press(page, 'Enter')
  await expect(check).toContainText('MediaOS 0.2.0 is ready')
  await expect(check).toContainText('Last checked today at')
  const install = page.getByTestId('updates-install')
  await expect(install).toContainText('Install MediaOS 0.2.0')

  await moveTo(page, 'updates-install', 'ArrowDown')
  await press(page, 'Enter')
  const question = page.getByTestId('confirm-overlay')
  await expect(question).toContainText('Install MediaOS 0.2.0?')
  await expect(question).toContainText('Faster home screen')
  await confirmOk(page)
  await expect(page.getByTestId('toasts')).toContainText('MediaOS 0.2.0 is installed. The box is restarting to finish.')
  await expect(check).toContainText('This box has MediaOS 0.2.0.')
  await expect(install).toHaveCount(0)
  await expect(page.getByTestId('updates-back')).toContainText('Go back to MediaOS 0.1.0')
  // The install row went away while it had the focus; the remote must still have somewhere to be.
  await expect(page.locator('.is-focused')).not.toHaveCount(0)

  await moveTo(page, 'updates-check', 'ArrowUp')
  await press(page, 'Enter')
  await expect(page.getByTestId('toasts')).toContainText('MediaOS is up to date.')
  await expect(check).toContainText('Up to date')

  await moveTo(page, 'updates-back', 'ArrowDown')
  await press(page, 'Enter')
  await expect(question).toContainText('Go back to MediaOS 0.1.0?')
  await expect(page.getByTestId('confirm-cancel')).toHaveClass(/is-focused/)
  await confirmOk(page)
  await expect(page.getByTestId('toasts')).toContainText('MediaOS 0.1.0 is installed. The box is restarting to finish.')
  await expect(check).toContainText('This box has MediaOS 0.1.0.')
  await expect(install).toContainText('Install MediaOS 0.2.0')
  await expect(install).toContainText("You went back from this version, so it won't install overnight.")
  await expect(page.getByTestId('updates-back')).toHaveCount(0)
})
