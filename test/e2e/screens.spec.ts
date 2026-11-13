// Screenshots of every main screen at TV sizes, saved to test-results/screens/, with a check that nothing spills
// off the side of the screen (rows that scroll sideways are allowed to).
import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

const OUT = 'test-results/screens'
const OVERFLOW = `[...document.querySelectorAll('body *')].filter((e) => {
  const r = e.getBoundingClientRect()
  if (r.width === 0 || r.height === 0 || e.closest('[data-scroll]')) return false
  return r.right > innerWidth + 1 || r.left < -1
}).map((e) => (e.className && e.className.baseVal === undefined ? e.className : e.tagName)).slice(0, 5)`

for (const size of ['1280x720', 'full']) {
  test(`screens at ${size === 'full' ? 'full screen' : size}`, async () => {
    test.setTimeout(120_000)
    mkdirSync(OUT, { recursive: true })
    let box: Box | undefined
    try {
      box = await launch({ size })
      const page = box.page
      const viewport = (await page.evaluate('[innerWidth, innerHeight].join("x")')) as string
      // Full screen fills whatever monitor this runs on, which is not always 1080p.
      const screen = (await page.evaluate('[screen.width, screen.height].join("x")')) as string
      expect(viewport).toBe(size === 'full' ? screen : size)
      const tag = viewport
      const shot = async (name: string): Promise<void> => {
        await page.waitForTimeout(500)
        await page.screenshot({ path: `${OUT}/${tag}-${name}.png` })
        expect(await page.evaluate(OVERFLOW), `${name} spills off screen`).toEqual([])
      }

      await shot('01-setup-welcome')
      await press(page, 'Enter', 2)
      await shot('02-setup-libraries')
      await press(page, 'Enter')
      await expect(page.getByTestId('signin')).toBeVisible()
      await shot('03-signin-jellyfin')
      await press(page, 'Escape')
      await expect(page.getByTestId('signin')).toHaveCount(0)
      await press(page, 'Escape', 2)
      await finishSetup(page)
      await shot('04-home')
      await press(page, 'ArrowDown')
      await shot('05-home-row2')
      await press(page, 'ContextMenu')
      await shot('06-item-menu')
      await press(page, 'Escape')

      await openTab(page, 'Libraries')
      await shot('07-libraries')
      await press(page, 'Enter')
      await expect(page.getByTestId('library-grid')).toBeVisible()
      await shot('08-grid-movies')
      await press(page, 'Enter')
      await expect(page.getByTestId('details')).toBeVisible()
      await shot('09-details-movie')
      await press(page, 'Escape', 2)
      await press(page, 'ArrowRight')
      await press(page, 'Enter')
      await press(page, 'Enter')
      await expect(page.getByTestId('episodes')).toBeVisible()
      await shot('10-details-show')
      await press(page, 'ArrowDown', 2)
      await shot('11-details-episodes')

      await openTab(page, 'Apps')
      await shot('12-apps')
      await openTab(page, 'Search')
      await page.keyboard.type('the', { delay: 60 })
      await expect(page.getByTestId('search-results').getByTestId('media-tile').first()).toBeVisible()
      await shot('13-search')

      await openTab(page, 'Settings')
      await shot('14-settings-network')
      await press(page, 'ArrowDown')
      await shot('15-settings-display')
      await press(page, 'ArrowDown', 3)
      await shot('16-settings-libraries')
      await press(page, 'ArrowDown', 4)
      await shot('17-settings-system')
      await press(page, 'ArrowUp', 8)
      await press(page, 'ArrowUp')
      await press(page, 'ContextMenu')
      await shot('18-options-menu')
      await press(page, 'Escape')
      await page.keyboard.press('Control+Alt+Backspace')
      await expect(page.getByTestId('menu-overlay')).toContainText('Recovery')
      await shot('19-recovery-menu')
      await press(page, 'Escape')

      await press(page, 'F1')
      await press(page, 'Enter')
      await expect(page.getByTestId('player')).toHaveAttribute('data-status', 'playing')
      await press(page, 'p')
      await expect(page.getByTestId('player')).toHaveAttribute('data-status', 'paused')
      await shot('20-player-paused')
      await press(page, 'ArrowDown')
      await shot('21-player-tracks')
      // Back closes the track menu, then hides the controls, then stops.
      await press(page, 'Escape', 3)
      await expect(page.getByTestId('player')).toHaveCount(0)
    } finally {
      await box?.app.close().catch(() => undefined)
    }
  })
}
