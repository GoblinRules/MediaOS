// End-to-end checks of the real app in mock mode, driven only by the keyboard (as a remote would).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { expectFocus, finishSetup, focused, freshDataDir, launch, openTab, press, type Box } from './launch'

let box: Box | undefined

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
})

/**
 * Press a key in the open (mock) streaming app window. Playwright's own key presses skip Electron's key hook,
 * so send it the way a real keyboard does: key down, optionally held, then key up.
 */
async function appKey(keyCode: string, holdMs = 0): Promise<void> {
  const send = (type: 'keyDown' | 'keyUp'): Promise<void> =>
    box!.app.evaluate(
      ({ BrowserWindow }, a) => {
        const appWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'MediaOS')
        appWin?.webContents.sendInputEvent({ type: a.type, keyCode: a.keyCode })
      },
      { type, keyCode },
    )
  await send('keyDown')
  if (holdMs > 0) await box!.page.waitForTimeout(holdMs)
  await send('keyUp')
}

async function openFirstApp(page: Page): Promise<void> {
  await openTab(page, 'Apps')
  await expect(page.getByTestId('apps')).toBeVisible()
  const opened = box!.app.waitForEvent('window')
  await press(page, 'Enter')
  await opened
  await expect(page.getByTestId('app-running')).toBeVisible()
}

async function readyAtHome(): Promise<Page> {
  box = await launch()
  await finishSetup(box.page)
  return box.page
}

test('first run: setup by keyboard reaches Home', async () => {
  box = await launch()
  console.log(`first screen after ${box.startMs} ms (cold start, includes Electron)`)
  const t = Date.now()
  await finishSetup(box.page)
  console.log(`setup walked in ${Date.now() - t} ms`)
  await expect(box.page.getByTestId('home-rows')).toBeVisible()
})

test('warm start goes straight to Home', async () => {
  const dataDir = freshDataDir()
  box = await launch({ dataDir })
  await finishSetup(box.page)
  await box.page.waitForTimeout(800) // settings are saved shortly after a change
  await box.app.close()
  box = await launch({ dataDir })
  await expect(box.page.getByTestId('home')).toBeVisible()
  console.log(`warm start to Home: ${box.startMs} ms (target under 3000)`)
  expect(box.startMs).toBeLessThan(6000)
})

test('Back never leaves the Home root, and Home always returns to it', async () => {
  const page = await readyAtHome()
  await press(page, 'Escape', 4)
  await press(page, 'Backspace', 4)
  await expect(page.getByTestId('home')).toBeVisible()
  expect(box?.app.windows().length).toBe(1)

  // From deep inside: Libraries > grid > details, then Home.
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('libraries')).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await press(page, 'F1')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect(page.getByTestId('details')).toHaveCount(0)

  // From Settings, Back steps out to the top and then Home; more Backs stay there.
  await openTab(page, 'Settings')
  await expect(page.getByTestId('settings')).toBeVisible()
  await press(page, 'Escape', 6)
  await expect(page.getByTestId('home')).toBeVisible()
})

test('every screen can be reached and left by keyboard', async () => {
  const page = await readyAtHome()

  // Libraries > grid > details > Back > Back
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('details-actions')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('libraries')).toBeVisible()

  // A TV show has episodes.
  await press(page, 'ArrowRight')
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('episodes')).toBeVisible()

  // Every Settings section.
  await openTab(page, 'Settings')
  const ids = ['network', 'vpn', 'display','sound', 'remotes', 'libraries', 'home', 'apps', 'playback', 'system']
  for (const [i, id] of ids.entries()) {
    if (i > 0) await press(page, 'ArrowDown')
    await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible()
    await press(page, 'Enter')
    await expect(focused(page)).not.toHaveClass(/set-nav-item/)
    await press(page, 'Escape')
    await expect(focused(page)).toHaveClass(/set-nav-item/)
  }

  // Apps: open a (mock) streaming app and come back with Escape.
  await openFirstApp(page)
  await appKey('Escape')
  await expect(page.getByTestId('app-running')).toHaveCount(0)
  expect(box!.app.windows().length).toBe(1)
  await expect(page.getByTestId('apps')).toBeVisible()

  // Search: type on a keyboard, move to a result, open it.
  await openTab(page, 'Search')
  await expect(page.getByTestId('search')).toBeVisible()
  await page.keyboard.type('the', { delay: 60 })
  await expect(page.getByTestId('search-query')).toContainText('the')
  await expect(page.getByTestId('search-results').getByTestId('media-tile').first()).toBeVisible()
  await press(page, 'ArrowRight', 6)
  await expect(page.getByTestId('search-results').locator('.is-focused')).toHaveCount(1)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('search')).toBeVisible()
  await expect(page.getByTestId('search-query')).toContainText('the')

  // Nothing found.
  await page.keyboard.type('zzqx', { delay: 60 })
  await expect(page.getByTestId('search-empty')).toBeVisible()
  // The focused result has gone, so focus is back on the on-screen keyboard (never nowhere).
  await expect(page.locator('.is-focused')).toHaveCount(1)
  await expect(page.getByTestId('search').locator('.search-kb .is-focused')).toHaveCount(1)
})

test('playing from Continue watching: pick subtitles, Back hides the controls, Back again stops', async () => {
  const page = await readyAtHome()
  await expectFocus(page, /\S/)
  await press(page, 'Enter')
  const player = page.getByTestId('player')
  await expect(player).toHaveAttribute('data-status', 'playing')
  await press(page, 'p')
  await expect(player).toHaveAttribute('data-status', 'paused')
  await press(page, 'Enter')
  await expect(player).toHaveAttribute('data-status', 'playing')

  // The track menu is driven by the arrows and OK, like any other menu.
  const menu = page.getByTestId('menu-overlay')
  await press(page, 'ArrowDown')
  await expect(menu).toBeVisible()
  let target = ''
  for (let i = 0; i < 12 && !target; i++) {
    const id = (await focused(page).getAttribute('data-testid')) ?? ''
    if (/^menu-s\d+$/.test(id)) target = id
    else await press(page, 'ArrowDown')
  }
  expect(target, 'a subtitle track in the menu').not.toBe('')
  await press(page, 'Enter')
  await expect(menu).toHaveCount(0)
  await press(page, 'ArrowDown')
  await expect(menu.getByTestId(target).locator('.menu-check')).toHaveCount(1)
  await expect(menu.getByTestId('menu-soff').locator('.menu-check')).toHaveCount(0)
  await press(page, 'Escape')
  await expect(menu).toHaveCount(0)

  // The controls are showing after the menu; the first Back hides them, the second stops.
  const osd = page.getByTestId('player-osd')
  await expect(osd).toHaveAttribute('data-visible', 'yes')
  await press(page, 'Escape')
  await expect(osd).toHaveAttribute('data-visible', 'no')
  await expect(player).toBeVisible()
  await press(page, 'Escape')
  await expect(player).toHaveCount(0)
  await expect(page.getByTestId('home')).toBeVisible()
})

test('while paused, Back hides the controls and then stops; a new play of the same title shows them again', async () => {
  const page = await readyAtHome()
  await expectFocus(page, /\S/)
  const player = page.getByTestId('player')
  const osd = page.getByTestId('player-osd')
  await press(page, 'Enter')
  await expect(player).toHaveAttribute('data-status', 'playing')
  await press(page, 'p')
  await expect(player).toHaveAttribute('data-status', 'paused')
  await expect(osd).toHaveAttribute('data-visible', 'yes')
  await press(page, 'Escape')
  await expect(osd).toHaveAttribute('data-visible', 'no')
  await expect(player).toHaveAttribute('data-status', 'paused')
  await press(page, 'Escape')
  await expect(player).toHaveCount(0)

  // Same title again: the earlier "hide" belonged to the earlier run, so a pause from outside (as from the phone,
  // with no key press here to bring the controls back) still shows them.
  await expect(page.getByTestId('home')).toBeVisible()
  await press(page, 'Enter')
  await expect(player).toHaveAttribute('data-status', 'playing')
  await page.evaluate("window.mediaos.call('player.command', { kind: 'togglePause' })")
  await expect(player).toHaveAttribute('data-status', 'paused')
  await expect(osd).toHaveAttribute('data-visible', 'yes')
  await press(page, 'Escape')
  await expect(osd).toHaveAttribute('data-visible', 'no')
  await expect(player).toBeVisible()
})

test('the Menu key twice on the same tile acts on its newest state', async () => {
  const page = await readyAtHome()
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid').getByTestId('media-tile').first()).toBeVisible()
  const menu = page.getByTestId('menu-overlay')
  const pickFavourite = async (): Promise<string> => {
    await press(page, 'ContextMenu')
    await expect(menu).toBeVisible()
    let id = ''
    for (let i = 0; i < 8 && !id; i++) {
      const t = (await focused(page).getAttribute('data-testid')) ?? ''
      if (t === 'menu-fav' || t === 'menu-unfav') id = t
      else await press(page, 'ArrowDown')
    }
    expect(id, 'a favourite item in the menu').not.toBe('')
    await press(page, 'Enter')
    await expect(menu).toHaveCount(0)
    return id
  }
  const first = await pickFavourite()
  await expect(page.getByTestId('toasts')).toContainText(first === 'menu-fav' ? 'Added' : 'Removed')
  // Focus never moved, so the second menu must come from the updated item.
  const second = await pickFavourite()
  expect(second).toBe(first === 'menu-fav' ? 'menu-unfav' : 'menu-fav')
})

test('two steppers changed quickly both stay changed', async () => {
  const dataDir = freshDataDir()
  box = await launch({ dataDir })
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await press(page, 'ArrowDown', 8)
  await expect(page.getByTestId('settings-page-playback')).toBeVisible()
  await press(page, 'Enter')
  await expectFocus(page, 'Left skips back')
  await press(page, 'ArrowRight', 2)
  await press(page, 'ArrowDown')
  await expectFocus(page, 'Right skips forward')
  await press(page, 'ArrowRight')
  await expect(page.getByTestId('settings-page-playback')).toContainText('20 sec')
  await expect(page.getByTestId('settings-page-playback')).toContainText('35 sec')
  const saved = (): { skipBackSec: number; skipForwardSec: number } | undefined => {
    try {
      return (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { playback: { skipBackSec: number; skipForwardSec: number } }).playback
    } catch {
      return undefined
    }
  }
  await expect.poll(saved, { timeout: 5000 }).toEqual(expect.objectContaining({ skipBackSec: 20, skipForwardSec: 35 }))
  // Still showing both once every reply is in.
  await page.waitForTimeout(3500)
  await expect(page.getByTestId('settings-page-playback')).toContainText('20 sec')
  await expect(page.getByTestId('settings-page-playback')).toContainText('35 sec')
})

test('leaving the page straight after changing two steppers still saves both', async () => {
  const dataDir = freshDataDir()
  box = await launch({ dataDir })
  const page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await press(page, 'ArrowDown', 8)
  await expect(page.getByTestId('settings-page-playback')).toBeVisible()
  await press(page, 'Enter')
  await expectFocus(page, 'Left skips back')
  // All in one go, well inside the 400 ms wait, so both changes are still waiting when the page closes. Back returns
  // to the list and Down moves to the next page, which replaces the Playback page.
  const started = Date.now()
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowRight', 'Escape', 'ArrowDown']) await page.keyboard.press(key)
  // If the keys took too long the changes were sent the normal way, and this test would prove nothing.
  expect(Date.now() - started).toBeLessThan(300)
  await expect(page.getByTestId('settings-page-playback')).toBeHidden()
  const saved = (): { skipBackSec: number; skipForwardSec: number } | undefined => {
    try {
      return (JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { playback: { skipBackSec: number; skipForwardSec: number } }).playback
    } catch {
      return undefined
    }
  }
  await expect.poll(saved, { timeout: 5000 }).toEqual(expect.objectContaining({ skipBackSec: 15, skipForwardSec: 35 }))
})

test('in a streaming app, Home goes to the Home screen and a long Home opens Recovery', async () => {
  const page = await readyAtHome()
  await openFirstApp(page)
  await appKey('F1')
  await expect(page.getByTestId('app-running')).toHaveCount(0)
  expect(box!.app.windows().length).toBe(1)
  await expect(page.getByTestId('home')).toBeVisible()

  await openFirstApp(page)
  await appKey('F1', 1700)
  await expect(page.getByTestId('app-running')).toHaveCount(0)
  expect(box!.app.windows().length).toBe(1)
  await expect(page.getByTestId('menu-overlay')).toContainText('Recovery')
})

test('Menu key, M and a long Home press open the right menus', async () => {
  const page = await readyAtHome()
  const menu = page.getByTestId('menu-overlay')
  // On a programme, Menu offers things to do with it.
  await press(page, 'ContextMenu')
  await expect(menu).toContainText('Play from the beginning')
  await press(page, 'ContextMenu')
  await expect(menu).toHaveCount(0)
  // Elsewhere it offers the general options.
  await press(page, 'ArrowUp', 4)
  await expectFocus(page, 'Home')
  await press(page, 'ContextMenu')
  await expect(menu).toContainText('Options')
  await press(page, 'Escape')
  await expect(menu).toHaveCount(0)
  await press(page, 'm')
  await expect(menu).toContainText('Options')
  await press(page, 'm')
  await expect(menu).toHaveCount(0)

  await page.keyboard.down('F1')
  await page.waitForTimeout(1700)
  await page.keyboard.up('F1')
  await expect(menu).toContainText('Recovery')
  await expect(menu).toContainText('Use these if something is stuck.')
  await press(page, 'Escape')
  await expect(menu).toHaveCount(0)

  await page.keyboard.press('Control+Alt+Backspace')
  await expect(menu).toContainText('Recovery')
})

test('settings survive a restart', async () => {
  const dataDir = freshDataDir()
  box = await launch({ dataDir })
  let page = box.page
  await finishSetup(page)
  await openTab(page, 'Settings')
  await press(page, 'ArrowDown', 2)
  await expect(page.getByTestId('settings-page-display')).toBeVisible()
  await press(page, 'Enter')
  for (let i = 0; i < 4 && !(await focused(page).textContent())?.includes('Text size'); i++) await press(page, 'ArrowDown')
  await expectFocus(page, 'Text size')
  await expectFocus(page, 'Normal')
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await expectFocus(page, 'Normal') // opens on the current choice
  await press(page, 'ArrowDown')
  await expectFocus(page, 'Large')
  await press(page, 'Enter')
  await expectFocus(page, 'Large')
  await page.waitForTimeout(800)
  await box.app.close()

  const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { setupDone: boolean; display: { uiScale: number } }
  expect(saved.setupDone).toBe(true)
  expect(saved.display.uiScale).toBe(1.15)

  box = await launch({ dataDir })
  page = box.page
  await expect(page.getByTestId('home')).toBeVisible()
  await expect.poll(() => page.evaluate('document.documentElement.style.getPropertyValue("--ui-scale")')).toBe('1.15')
})

test('a damaged settings file is set aside and defaults are used', async () => {
  const dataDir = freshDataDir()
  writeFileSync(join(dataDir, 'settings.json'), '{ this is not json')
  box = await launch({ dataDir })
  await expect(box.page.getByTestId('setup')).toBeVisible()
  await expect(box.page.getByTestId('toasts')).toContainText('damaged')
  expect(existsSync(join(dataDir, 'settings.json.bad'))).toBe(true)
  expect(readFileSync(join(dataDir, 'settings.json.bad'), 'utf8')).toBe('{ this is not json')
})

test('the page is locked down', async () => {
  const requests: string[] = []
  box = await launch()
  const page = box.page
  page.on('request', (r) => requests.push(r.url()))
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await press(page, 'Enter')
  await expect(page.getByTestId('media-tile').first()).toBeVisible()
  await page.waitForTimeout(1000)

  expect(await page.evaluate('typeof require')).toBe('undefined')
  expect(await page.evaluate('typeof process')).toBe('undefined')
  expect(await page.evaluate('Object.keys(window.mediaos).sort().join(",")')).toBe('call,on,platform')

  // No pop-ups.
  expect(await page.evaluate('String(window.open("https://example.com/"))')).toBe('null')
  expect(box.app.windows().length).toBe(1)

  // The page itself only ever loads local files, artwork through mediaos-img://, and inline data.
  expect(requests.length).toBeGreaterThan(0)
  const outside = requests.filter((u) => !/^(file|mediaos-img|data|blob):/.test(u))
  expect(outside).toEqual([])
  expect(requests.filter((u) => /token|api_key|apikey|x-plex|x-emby/i.test(u))).toEqual([])

  // No leaving the shell page. Checked last and from the main process: Playwright waits forever for a
  // navigation that Electron cancelled.
  const shellUrl = (): Promise<string> =>
    box!.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? '')
  const before = await shellUrl()
  expect(before).toMatch(/^file:/)
  await page.evaluate('setTimeout(() => { location.href = "https://example.com/" }, 0)')
  await page.waitForTimeout(1000)
  expect(await shellUrl()).toBe(before)
})
