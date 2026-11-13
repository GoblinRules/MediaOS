// End-to-end check of network folders in mock mode: add one as a guest from Settings › Libraries, see its films in
// Libraries, then remove it. The mock box finds NAS and OFFICE-PC, shares Films, Music and Public, and always has a USB
// drive called HOLIDAY plugged in.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

let box: Box | undefined

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
})

/** Press `key` until `target` has the focus ring. */
async function moveTo(page: Page, target: Locator, key: string, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)) return
    await press(page, key)
  }
  await expect(target).toHaveClass(/is-focused/)
}

/** Find `target` in a grid: sweep each row left then right, then go down a row, until it has the focus ring. */
async function moveToInGrid(page: Page, target: Locator): Promise<void> {
  const focused = () => target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 8 && !(await focused()); i++) await press(page, 'ArrowLeft')
    for (let i = 0; i < 8 && !(await focused()); i++) await press(page, 'ArrowRight')
    if (await focused()) return
    await press(page, 'ArrowDown')
  }
  await expect(target).toHaveClass(/is-focused/)
}

/** Type into the open on-screen keyboard, then press its Done key (the last key on the bottom row). */
async function typeText(page: Page, title: string, text: string): Promise<void> {
  const keyboard = page.getByTestId('keyboard-overlay')
  await expect(keyboard).toContainText(title)
  await page.keyboard.type(text)
  await press(page, 'ArrowDown', 6)
  await moveTo(page, page.getByTestId('keyboard-done'), 'ArrowRight', 6)
  await press(page, 'Enter')
}

test('a network folder can be added as a guest, browsed and removed', async () => {
  box = await launch()
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await moveTo(page, page.getByTestId('settings-nav-libraries'), 'ArrowDown')
  await press(page, 'Enter')

  // The USB drive is listed as soon as the page opens; it needs no setup.
  await expect(page.getByTestId('drive-usb-mock')).toContainText('HOLIDAY')
  await moveTo(page, page.getByTestId('add-folder'), 'ArrowDown')
  await press(page, 'Enter')

  const flow = page.getByTestId('folder-add')
  await expect(flow).toHaveAttribute('data-step', 'find')
  const nas = page.getByTestId('folder-pc-NAS')
  await expect(nas).toBeVisible()
  await moveTo(page, nas, 'ArrowUp')
  await press(page, 'Enter')

  await expect(flow).toHaveAttribute('data-step', 'login')
  await moveTo(page, page.getByTestId('folder-guest'), 'ArrowDown')
  await press(page, 'Enter')

  const films = page.getByTestId('folder-share-Films')
  await expect(films).toBeVisible()
  await moveTo(page, films, 'ArrowUp')
  await press(page, 'Enter')

  await expect(page.getByTestId('toasts')).toContainText('Added Films on NAS')
  await expect(flow).toHaveCount(0)
  const row = page.locator('[data-testid^="folder-smb-"]')
  await expect(row).toContainText('Films on NAS')
  await expect(row).toContainText('Connected')
  await expect(row).toContainText('as a guest')
  // A folder isn't a server: the servers list stays about Jellyfin and Plex.
  await expect(page.locator('[data-testid="source-folders"]')).toHaveCount(0)

  await openTab(page, 'Libraries')
  const card = page.getByTestId('library-card').filter({ hasText: 'Films on NAS' })
  await expect(card).toBeVisible()
  await expect(page.getByTestId('library-card').filter({ hasText: 'HOLIDAY' })).toBeVisible()
  await moveToInGrid(page, card)
  await press(page, 'Enter')
  const grid = page.getByTestId('library-grid')
  await expect(grid).toContainText('Films')
  await expect(grid).toContainText('Shows')
  await expect(grid).not.toContainText('notes')

  await openTab(page, 'Settings')
  await moveTo(page, page.getByTestId('settings-nav-libraries'), 'ArrowDown')
  await press(page, 'Enter')
  await moveTo(page, row, 'ArrowDown')
  await press(page, 'Enter')
  const menu = page.getByTestId('menu-overlay')
  await expect(menu).toContainText('Films on NAS')
  await expect(menu.getByTestId('menu-retry')).toHaveCount(0)
  await moveTo(page, menu.getByTestId('menu-remove'), 'ArrowDown', 3)
  await press(page, 'Enter')
  await expect(page.getByTestId('confirm-overlay')).toContainText('Remove Films on NAS?')
  await moveTo(page, page.getByTestId('confirm-ok'), 'ArrowRight', 2)
  await press(page, 'Enter')
  await expect(page.getByTestId('toasts')).toContainText('Removed Films on NAS')
  await expect(row).toHaveCount(0)
  // Focus went somewhere the remote can still use.
  await expect(page.locator('.is-focused')).not.toHaveCount(0)
})

test('a wrong password says so and Try again goes back to signing in', async () => {
  box = await launch()
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await moveTo(page, page.getByTestId('settings-nav-libraries'), 'ArrowDown')
  await press(page, 'Enter')
  await moveTo(page, page.getByTestId('add-folder'), 'ArrowDown')
  await press(page, 'Enter')

  const flow = page.getByTestId('folder-add')
  const nas = page.getByTestId('folder-pc-NAS')
  await expect(nas).toBeVisible()
  await moveTo(page, nas, 'ArrowUp')
  await press(page, 'Enter')
  await moveTo(page, page.getByTestId('folder-password'), 'ArrowUp')
  await press(page, 'Enter')
  await typeText(page, 'Your user name on NAS', 'bob')
  await typeText(page, 'Password for bob', 'wrong')

  await expect(flow).toHaveAttribute('data-step', 'failed')
  await expect(flow).toContainText('password')
  await expect(page.getByTestId('folder-again')).toHaveClass(/is-focused/)
  await press(page, 'Enter')
  await expect(flow).toHaveAttribute('data-step', 'login')
  await press(page, 'Escape')
  await expect(flow).toHaveCount(0)
})
