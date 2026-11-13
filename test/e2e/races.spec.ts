// Timing cases in the library grid and sign-in that the demo data can't produce on its own. A small stand-in wraps
// the core's call handler in the main process: it can make a library much bigger, hold a reply, or fail one once.
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { finishSetup, launch, openTab, press, type Box } from './launch'

let box: Box | undefined

test.afterEach(async () => {
  await box?.app.close().catch(() => undefined)
  box = undefined
})

interface Control {
  /** Pretend every library holds this many films (0 = leave browsing alone). */
  total?: number
  /** Browse offsets that fail once. */
  fail?: number[]
  /** The next browse at this offset waits until released. */
  holdOffset?: number
  /** The next sign-in poll waits until answered. */
  holdPoll?: boolean
  /** Every call with one of these names waits until release() (Home can load twice as setup finishes). */
  hold?: string[]
  /** The next call with each of these names fails once. */
  failOnce?: string[]
  /** Held calls fail when released, instead of answering. */
  failHeld?: boolean
  /** Home has no rows and no apps (the servers are connected but have nothing to show). */
  emptyHome?: boolean
}

async function intercept(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Reply = { ok: boolean; value?: unknown; error?: string }
    type Handler = (...args: unknown[]) => Promise<Reply>
    // Electron keeps invoke handlers in this map; the test needs the real one to wrap it.
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('mediaos:call')
    if (!original) throw new Error('No call handler to wrap')
    const t = {
      total: 0, fail: [] as number[], holdOffset: undefined as number | undefined, holdPoll: false,
      hold: [] as string[], heldCalls: [] as (() => void)[], failOnce: [] as string[], failHeld: false, emptyHome: false,
      browses: [] as number[], held: undefined as (() => void) | undefined, pollHeld: undefined as ((r: Reply) => void) | undefined,
    }
    ;(globalThis as unknown as { __race: typeof t }).__race = t
    ipcMain.removeHandler('mediaos:call')
    ipcMain.handle('mediaos:call', async (event, name: unknown, args: unknown) => {
      const list = args as unknown[]
      if (name === 'libraries.browse' && t.total > 0) {
        const query = list[1] as { offset: number; limit: number }
        t.browses.push(query.offset)
        if (t.fail.includes(query.offset)) {
          t.fail = t.fail.filter((o) => o !== query.offset)
          return { ok: false, error: 'The test server did not answer.' }
        }
        if (t.holdOffset === query.offset) {
          t.holdOffset = undefined
          await new Promise<void>((resolve) => { t.held = resolve })
        }
        const real = await original(event, name, [list[0], { ...query, offset: 0, limit: 200 }])
        if (!real.ok) return real
        const base = (real.value as { items: Record<string, unknown>[] }).items
        const items: Record<string, unknown>[] = []
        for (let i = query.offset; i < Math.min(t.total, query.offset + query.limit); i++) {
          const b = base[i % base.length]!
          items.push({ ...b, id: `${String(b.id)}~${i}`, key: `${String(b.key)}~${i}`, title: `Film ${i + 1}` })
        }
        return { ok: true, value: { items, total: t.total } }
      }
      if (t.failOnce.includes(String(name))) {
        t.failOnce = t.failOnce.filter((n) => n !== name)
        return { ok: false, error: 'The test server did not answer.' }
      }
      if (t.hold.includes(String(name))) {
        await new Promise<void>((resolve) => { t.heldCalls.push(resolve) })
        if (t.failHeld) return { ok: false, error: 'The test server did not answer.' }
      }
      if (t.emptyHome && name === 'apps.list') return { ok: true, value: [] }
      if (t.emptyHome && name === 'home.get') {
        const real = await original(event, name, args)
        return real.ok ? { ok: true, value: { ...(real.value as object), rows: [] } } : real
      }
      if (name === 'signin.poll' && t.holdPoll) {
        t.holdPoll = false
        return new Promise<Reply>((resolve) => { t.pollHeld = resolve })
      }
      return original(event, name, args)
    })
  })
}

async function control(app: ElectronApplication, c: Control): Promise<void> {
  await app.evaluate((_e, cfg) => { Object.assign((globalThis as unknown as { __race: object }).__race, cfg) }, c)
}

/** Let every held call (see Control.hold) answer, and stop holding. */
async function release(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const t = (globalThis as unknown as { __race: { hold: string[]; heldCalls: (() => void)[] } }).__race
    t.hold = []
    for (const resolve of t.heldCalls.splice(0)) resolve()
  })
}

async function heldCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __race: { heldCalls: unknown[] } }).__race.heldCalls.length)
}

async function browses(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(() => (globalThis as unknown as { __race: { browses: number[] } }).__race.browses.slice())
}

/** Index of the focused poster in the grid, or -1. */
async function focusedTile(page: Page): Promise<number> {
  // A string, because the test files are type-checked without the browser's types.
  return page.evaluate<number>(`[...document.querySelectorAll('[data-testid="library-grid"] .poster-grid .grid-cell')]
    .findIndex((cell) => cell.querySelector('.is-focused') !== null)`)
}

async function tileCount(page: Page): Promise<number> {
  return page.locator('[data-testid="library-grid"] .poster-grid .grid-cell').count()
}

/** Press `key` until `target` has the focus ring. */
async function pressUntil(page: Page, key: string, target: Locator, max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el.classList.contains('is-focused')).catch(() => false)) return
    await press(page, key)
  }
  await expect(target).toHaveClass(/is-focused/)
}

/** Move down the grid until focus is within the last two rows of what is loaded. */
async function focusNearEnd(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await focusedTile(page)) >= (await tileCount(page)) - 14) return
    await press(page, 'ArrowDown')
  }
  throw new Error('Focus never reached the end of the grid')
}

async function openBigLibrary(c: Control = {}): Promise<Page> {
  box = await launch()
  await intercept(box.app)
  await finishSetup(box.page)
  await control(box.app, { total: 200, ...c })
  const page = box.page
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => tileCount(page)).toBe(60)
  await expect.poll(() => focusedTile(page)).toBe(0)
  return page
}

test('a next page waits for a library refresh that is still loading', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  // Library data changes (as when something is marked watched elsewhere); hold that refresh.
  await control(app, { holdOffset: 0 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('mediaos:event', { event: 'homeChanged', payload: {} })
  })
  await expect.poll(async () => (await browses(app)).filter((o) => o === 0).length).toBe(2)
  const before = (await browses(app)).length
  await focusNearEnd(page)
  await page.waitForTimeout(600)
  // A page appended now would vanish when the refresh lands, so none may be asked for yet.
  expect((await browses(app)).slice(before)).toEqual([])
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(120)
  expect((await browses(app)).slice(before)).toEqual([60])
})

test('Retry after a failed next page keeps focus on the last poster', async () => {
  const page = await openBigLibrary({ fail: [60] })
  await focusNearEnd(page)
  const retry = page.getByTestId('grid-more-retry')
  await expect(retry).toBeVisible()
  await pressUntil(page, 'ArrowDown', retry)
  await press(page, 'Enter')
  await expect.poll(() => tileCount(page)).toBe(120)
  expect(await focusedTile(page)).toBe(59)
})

test('a fresh first page clears an old "couldn\'t load more" notice', async () => {
  const page = await openBigLibrary({ fail: [60] })
  await focusNearEnd(page)
  await expect(page.getByTestId('grid-more-retry')).toBeVisible()
  // Change the sort and change it back: the first page for Title loads again and must not bring the notice back.
  const sort = page.getByTestId('grid-sort')
  for (const [id, key] of [['added', 'ArrowDown'], ['title', 'ArrowUp']] as const) {
    await pressUntil(page, 'ArrowUp', sort, 30)
    await press(page, 'Enter')
    await expect(page.getByTestId('menu-overlay')).toBeVisible()
    await pressUntil(page, key, page.getByTestId(`menu-${id}`))
    await press(page, 'Enter')
    await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
    await expect.poll(() => tileCount(page)).toBe(60)
  }
  await expect(sort).toContainText('Title (A to Z)')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('grid-more-retry')).toHaveCount(0)
})

test('a Plex sign-in approved just after the user left still says the server was added', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await control(app, { holdPoll: true })
  await press(page, 'Enter', 2)
  await expect(page.getByTestId('setup')).toHaveAttribute('data-step', 'libraries')
  await pressUntil(page, 'ArrowRight', page.getByTestId('setup-add-plex'), 4)
  await press(page, 'Enter')
  await expect(page.getByTestId('signin')).toHaveAttribute('data-step', 'code')
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { pollHeld?: unknown } }).__race.pollHeld !== undefined), { timeout: 10_000 }).toBe(true)
  await press(page, 'Escape')
  await expect(page.getByTestId('signin')).toHaveCount(0)
  await app.evaluate(() => {
    const t = (globalThis as unknown as { __race: { pollHeld: (r: unknown) => void } }).__race
    t.pollHeld({ ok: true, value: { state: 'done', source: { id: 'plex-test', kind: 'plex', name: 'Test Plex' } } })
  })
  await expect(page.getByTestId('toast').filter({ hasText: 'Added Test Plex' })).toBeVisible()
})

/**
 * Finish setup with the calls in `hold` still unanswered, like a box whose server is slow to answer. Setup shows
 * one Home and then hands over to a fresh one, and both ask for every held call, so wait for both before going on.
 */
async function homeStillLoading(hold: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  const setup = page.getByTestId('setup')
  await press(page, 'Enter', 2)
  await expect(setup).toHaveAttribute('data-step', 'libraries')
  await press(page, 'ArrowDown')
  await press(page, 'ArrowRight')
  await press(page, 'Enter')
  await expect(setup).toHaveAttribute('data-step', 'done')
  await control(app, { hold })
  await press(page, 'Enter')
  await expect(page.getByTestId('home')).toBeVisible()
  await expect.poll(() => heldCount(app)).toBe(hold.length * 2)
  return { app, page }
}

/** Exactly one thing on the page has the focus ring, and it is `target`. */
async function expectOnlyFocus(page: Page, target: Locator): Promise<void> {
  await expect(target).toHaveClass(/is-focused/)
  await expect(page.locator('.is-focused')).toHaveCount(1)
}

const HOME_CALLS = ['home.get', 'apps.list']

for (const key of ['ArrowUp', 'Escape']) {
  test(`${key} pressed while Home is still loading keeps focus on the tab bar`, async () => {
    const { app, page } = await homeStillLoading(HOME_CALLS)
    await press(page, key, 2)
    await expectOnlyFocus(page, page.getByTestId('tab-home'))
    await release(app)
    await expect(page.getByTestId('row-continue')).toBeVisible()
    await page.waitForTimeout(400)
    // The user chose the tab bar; Home arriving late must not pull focus back down to the first tile.
    await expectOnlyFocus(page, page.getByTestId('tab-home'))
  })
}

test('moving along the tab bar while Home is still loading keeps focus on the chosen tab', async () => {
  const { app, page } = await homeStillLoading(HOME_CALLS)
  await press(page, 'ArrowUp')
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('tab-libraries'))
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('tab-libraries'))
})

test('Down from the tab bar while Home is still loading puts focus on the first tile once it loads', async () => {
  const { app, page } = await homeStillLoading(HOME_CALLS)
  await press(page, 'ArrowUp')
  await expect(page.getByTestId('tab-home')).toHaveClass(/is-focused/)
  // Nothing to move down to yet; the press asks for the content, so focus goes there when it arrives.
  await press(page, 'ArrowDown')
  await release(app)
  const firstTile = page.getByTestId('row-continue').locator('.focusable').first()
  await expectOnlyFocus(page, firstTile)
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, firstTile)
})

test('Down pressed on a tab whose screen is still loading moves into the screen once it loads', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect.poll(() => heldCount(app)).toBe(1)
  await press(page, 'ArrowLeft')
  await press(page, 'ArrowRight')
  // Down finds nothing below the tab yet and focus stays on it, but the user asked for the content.
  await press(page, 'ArrowDown')
  await expect(page.getByTestId('tab-libraries')).toHaveClass(/is-focused/)
  await release(app)
  await expectOnlyFocus(page, page.getByTestId('library-card').first())
})

for (const [key, tab] of [['ArrowLeft', 'home'], ['ArrowRight', 'apps']] as const) {
  test(`${key} along the tab bar while a tab is still loading keeps focus on the tab the user chose`, async () => {
    box = await launch()
    const { app, page } = box
    await intercept(app)
    await finishSetup(page)
    await control(app, { hold: ['libraries.list'] })
    await openTab(page, 'Libraries')
    await expect.poll(() => heldCount(app)).toBe(1)
    // The only move is sideways along the tab bar (no Up first), so it alone must count as the user moving.
    await press(page, key)
    await expectOnlyFocus(page, page.getByTestId(`tab-${tab}`))
    await release(app)
    await expect(page.getByTestId('library-card').first()).toBeVisible()
    await page.waitForTimeout(400)
    await expectOnlyFocus(page, page.getByTestId(`tab-${tab}`))
  })
}

test('Up while only the Apps row has loaded goes to the tab bar and stays there', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  await expect(page.getByTestId('row-apps')).toBeVisible()
  await press(page, 'ArrowUp')
  await expectOnlyFocus(page, page.getByTestId('tab-home'))
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('tab-home'))
})

test('moving along the Apps row while the rest of Home loads keeps focus on the app the user chose', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.nth(1)).toBeVisible()
  // Down wakes focus on the first app (the screen's default for now); Right is the user's own choice.
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, apps.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, apps.nth(1))
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, apps.nth(1))
})

test('an arrow that only woke focus on the Apps row while Home loads gives way to the first tile', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.first()).toBeVisible()
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, apps.first())
  // Left from the first app goes nowhere, so it does not count as choosing that app either.
  await press(page, 'ArrowLeft')
  await expectOnlyFocus(page, apps.first())
  await release(app)
  // The user did not pick the app, so Home's real first tile (Continue watching) takes focus once it loads.
  await expectOnlyFocus(page, page.getByTestId('row-continue').locator('.focusable').first())
})

test('moving away from the woken app and back to it while Home loads keeps focus on that app', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.nth(1)).toBeVisible()
  // Down only wakes focus on the first app, but Right then Left is the user choosing it on purpose.
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, apps.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, apps.nth(1))
  await press(page, 'ArrowLeft')
  await expectOnlyFocus(page, apps.first())
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, apps.first())
})

test('Down then Right on the tab bar while a tab is still loading keeps focus on the tab the user chose', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect.poll(() => heldCount(app)).toBe(1)
  // Down asks for the content, but the later Right is a choice on the tab bar, which wins.
  await press(page, 'ArrowDown')
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('tab-apps'))
  await release(app)
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('tab-apps'))
})

test('keys used inside a menu while a tab is loading do not count as moving on the screen', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('tab-libraries')).toHaveClass(/is-focused/)
  await expect.poll(() => heldCount(app)).toBe(1)
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp']) await press(page, key)
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await release(app)
  // The user never moved on the screen itself, so focus goes to the first library as usual.
  await expectOnlyFocus(page, page.getByTestId('library-card').first())
})

test('an arrow pressed while the grid reloads after Back still returns to the poster the user left', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await control(app, { holdOffset: 0 })
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { held?: unknown } }).__race.held !== undefined)).toBe(true)
  await press(page, 'ArrowRight')
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(60)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await expect(page.getByTestId('grid-sort')).not.toHaveClass(/is-focused/)
})

test('a menu still open when a tab finishes loading hands focus to the screen when it closes', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect.poll(() => heldCount(app)).toBe(1)
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await release(app)
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  // Focus stays in the menu while it is open...
  await expect(page.getByTestId('menu-overlay').locator('.is-focused')).toHaveCount(1)
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  // ...and then goes to the first library, as if the menu had never opened.
  await expectOnlyFocus(page, page.getByTestId('library-card').first())
})

test('moving from Sort to Filter while the grid reloads after Back keeps focus on Filter', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  await press(page, 'ArrowRight', 3)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await control(app, { holdOffset: 0 })
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { held?: unknown } }).__race.held !== undefined)).toBe(true)
  // The first arrow only wakes focus on Sort; the second is the user's own move to Filter.
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-filter'))
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(60)
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('grid-filter'))
})

test('Details of a show watched to the end puts focus on a real button', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'ArrowRight')
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  await expectOnlyFocus(page, page.getByTestId('details-play'))
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('details-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('details-watched')).toHaveText(/^Watched$/)
  await expect(page.getByTestId('details-play')).toHaveCount(0)
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  // There is no Play button now; focus must still land on a button so the arrows and OK work.
  await expectOnlyFocus(page, page.getByTestId('details-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('details-watched')).toHaveText(/^Mark watched$/)
})

test('Try again after Details failed to load puts focus on the screen once it loads', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(0)
  await control(app, { failOnce: ['items.get'] })
  await press(page, 'Enter')
  const retry = page.getByRole('button', { name: 'Try again' }).or(page.locator('.focusable', { hasText: 'Try again' }))
  await expectOnlyFocus(page, retry.first())
  await press(page, 'Enter')
  // The error and its button go away while it reloads; focus must not be left on nothing.
  const buttons = page.getByTestId('details-actions').locator('.focusable')
  await expectOnlyFocus(page, buttons.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, buttons.nth(1))
})

test('Menu on an app that an arrow woke focus onto while Home loads counts as choosing it', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.first()).toBeVisible()
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, apps.first())
  // Asking for the app's options is a choice of that app, even though the arrow only woke focus onto it.
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, apps.first())
})

test('OK that only woke focus on the Apps row while Home loads gives way to the first tile', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.first()).toBeVisible()
  // OK with nothing focused only wakes focus up (it does not open the app); Left from the first app goes nowhere.
  await press(page, 'Enter')
  await expectOnlyFocus(page, apps.first())
  await press(page, 'ArrowLeft')
  await expectOnlyFocus(page, apps.first())
  await release(app)
  await expectOnlyFocus(page, page.getByTestId('row-continue').locator('.focusable').first())
})

test('arrows inside a menu do not turn a woken button into the user\'s choice', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await control(app, { holdOffset: 0 })
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { held?: unknown } }).__race.held !== undefined)).toBe(true)
  // The arrow only wakes focus on Sort; moving about inside a menu is not a move on the screen.
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await press(page, 'ArrowDown', 2)
  await press(page, 'ArrowUp')
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(60)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await expect(page.getByTestId('grid-sort')).not.toHaveClass(/is-focused/)
})

test('a poster marked as watched under "Not watched" hands focus to the poster now in its place', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(0)
  await pressUntil(page, 'ArrowUp', page.getByTestId('grid-sort'))
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-filter'))
  await press(page, 'Enter')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-unwatched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('grid-filter')).toContainText('Not watched')
  // Down into the grid (onto the poster under Filter), then down again so the poster is scrolled well into the grid.
  await press(page, 'ArrowDown')
  await expect.poll(() => focusedTile(page)).toBeGreaterThanOrEqual(0)
  const top = await focusedTile(page)
  await press(page, 'ArrowDown', 2)
  await expect.poll(() => focusedTile(page)).toBeGreaterThan(top)
  const at = await focusedTile(page)
  const cells = page.locator('[data-testid="library-grid"] .poster-grid .grid-cell')
  const next = await cells.nth(at + 1).locator('.focusable').getAttribute('aria-label')
  const before = await tileCount(page)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-watched'))
  await press(page, 'Enter')
  await expect.poll(() => tileCount(page)).toBe(before - 1)
  // The film is gone from "Not watched"; focus stays where the user was, on the film that moved into its place.
  await expect.poll(() => focusedTile(page)).toBe(at)
  await expect(cells.nth(at).locator('.focusable')).toHaveAttribute('aria-label', next ?? '')
  await page.waitForTimeout(500)
  await expect.poll(() => focusedTile(page)).toBe(at)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

test('Try again on Home with the Apps row showing puts focus on Home\'s first tile once it loads', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  await control(app, { failHeld: true })
  await release(app)
  const retry = page.getByTestId('home-error').locator('.focusable', { hasText: 'Try again' })
  await expect(retry).toBeVisible()
  await control(app, { failHeld: false })
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expectOnlyFocus(page, apps.first())
  await pressUntil(page, 'ArrowUp', retry)
  // Hold the reload long enough for the vanished button's group to hand focus on to the Apps row.
  await control(app, { hold: ['home.get'] })
  await press(page, 'Enter')
  await expect.poll(() => heldCount(app)).toBe(1)
  await expectOnlyFocus(page, apps.first())
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await expectOnlyFocus(page, page.getByTestId('row-continue').locator('.focusable').first())
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('row-continue').locator('.focusable').first())
})

test('Home with nothing to show still has a button to focus', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await control(app, { emptyHome: true })
  await finishSetup(page)
  await expect(page.getByTestId('home-nothing')).toBeVisible()
  await expectOnlyFocus(page, page.getByTestId('home-nothing-settings'))
  await press(page, 'Enter')
  await expect(page.getByTestId('settings-page-libraries')).toBeVisible()
})

test('a confirmation opened from a menu returns focus to the tile the menu was opened on', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await pressUntil(page, 'ArrowDown', apps.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, apps.nth(1))
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-reset'))
  await press(page, 'Enter')
  await expect(page.getByTestId('confirm-overlay')).toBeVisible()
  await expectOnlyFocus(page, page.getByTestId('confirm-cancel'))
  await press(page, 'Enter')
  await expect(page.getByTestId('confirm-overlay')).toHaveCount(0)
  await expectOnlyFocus(page, apps.nth(1))
})

test('a menu opened on a tab the user chose while it loads returns focus to that tab', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect.poll(() => heldCount(app)).toBe(1)
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('tab-apps'))
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await release(app)
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await expectOnlyFocus(page, page.getByTestId('tab-apps'))
})

test('Down then Menu on a tab while it loads hands focus to the screen when the menu closes', async () => {
  box = await launch()
  const { app, page } = box
  await intercept(app)
  await finishSetup(page)
  await control(app, { hold: ['libraries.list'] })
  await openTab(page, 'Libraries')
  await expect.poll(() => heldCount(app)).toBe(1)
  // Down asks for the content (there is none yet), so the tab is not where the user chose to be.
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, page.getByTestId('tab-libraries'))
  await press(page, 'm')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await release(app)
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await expectOnlyFocus(page, page.getByTestId('library-card').first())
})

test('OK on a button an arrow woke focus onto while the grid reloads counts as choosing it', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await control(app, { holdOffset: 0 })
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { held?: unknown } }).__race.held !== undefined)).toBe(true)
  // The arrow only wakes focus on Sort, but OK on it (opening the sort choices) is a clear choice of Sort.
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(60)
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
})

/** Open the first library, then pick "Not watched" from its Filter menu. */
async function notWatchedGrid(page: Page): Promise<void> {
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(0)
  await pressUntil(page, 'ArrowUp', page.getByTestId('grid-sort'))
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-filter'))
  await press(page, 'Enter')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-unwatched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('grid-filter')).toContainText('Not watched')
}

const gridCells = (page: Page): Locator => page.locator('[data-testid="library-grid"] .poster-grid .grid-cell')

test('choosing another season and then Down puts focus on that season\'s first episode', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'ArrowRight')
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  // Coastline has three seasons.
  await pressUntil(page, 'ArrowRight', page.getByTestId('library-grid').locator('.focusable[aria-label*="Coastline"]'))
  await press(page, 'Enter')
  await expectOnlyFocus(page, page.getByTestId('details-play'))
  const firstEpisode = page.getByTestId('episodes').locator('.focusable').first()
  const shown = /n(\d+)e\d+$/.exec((await firstEpisode.getAttribute('data-focus-key')) ?? '')?.[1]
  expect(shown).toBeDefined()
  // Go to a season other than the one shown when Details opened: the episode row must take that season's name.
  const target = shown === '1' ? 2 : 1
  const tabs = page.getByTestId('season-tabs').locator('.focusable')
  await press(page, 'ArrowDown')
  await expect(page.getByTestId('season-tabs').locator('.is-focused')).toHaveCount(1)
  await pressUntil(page, 'ArrowLeft', tabs.first())
  await expect(firstEpisode).toHaveAttribute('data-focus-key', /n1e1$/)
  if (target === 2) {
    await press(page, 'ArrowRight')
    await expectOnlyFocus(page, tabs.nth(1))
    await expect(firstEpisode).toHaveAttribute('data-focus-key', /n2e1$/)
  }
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, firstEpisode)
  await expect(firstEpisode).toHaveAttribute('data-focus-key', new RegExp(`^det:ep:.*n${target}e1$`))
})

test('a Continue watching tile marked as watched hands focus to the tile now in its place', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  const tiles = page.getByTestId('row-continue').locator('.focusable')
  await expectOnlyFocus(page, tiles.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, tiles.nth(1))
  const was = await tiles.nth(1).getAttribute('aria-label')
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await expect(tiles.nth(1)).not.toHaveAttribute('aria-label', was ?? '')
  await expectOnlyFocus(page, tiles.nth(1))
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, tiles.nth(1))
})

test('hiding the last app in the grid hands focus to the app before it', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Apps')
  const shown = page.getByTestId('apps').locator('.app-grid').first().locator('.focusable')
  await expectOnlyFocus(page, shown.first())
  const n = await shown.count()
  expect(n).toBeGreaterThan(2)
  // The grid is five apps wide: go down to the last row, then along it to the last app.
  const rowsDown = Math.floor((n - 1) / 5)
  if (rowsDown > 0) await press(page, 'ArrowDown', rowsDown)
  await pressUntil(page, 'ArrowRight', shown.nth(n - 1))
  const before = await shown.nth(n - 2).getAttribute('data-focus-key')
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-hide'))
  await press(page, 'Enter')
  await expect(shown).toHaveCount(n - 1)
  // The hidden app moved to "Hidden apps"; focus stays in the grid the user was in, on the app now last in it.
  await expectOnlyFocus(page, shown.nth(n - 2))
  await expect(shown.nth(n - 2)).toHaveAttribute('data-focus-key', before ?? '')
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, shown.nth(n - 2))
})

test('Details opened from a poster\'s menu returns to that poster on Back', async () => {
  const page = await openBigLibrary()
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-details'))
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(3)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

test('Back from Details after marking the film watched under "Not watched" focuses the film now in its place', async () => {
  box = await launch()
  const { page } = box
  await notWatchedGrid(page)
  await press(page, 'ArrowDown')
  await expect.poll(() => focusedTile(page)).toBeGreaterThanOrEqual(0)
  await press(page, 'ArrowRight')
  await expect.poll(() => focusedTile(page)).toBeGreaterThan(0)
  const at = await focusedTile(page)
  const next = await gridCells(page).nth(at + 1).locator('.focusable').getAttribute('aria-label')
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await pressUntil(page, 'ArrowRight', page.getByTestId('details-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('details-watched')).toHaveText(/^Watched$/)
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect(gridCells(page).nth(at).locator('.focusable')).toHaveAttribute('aria-label', next ?? '')
  await expect.poll(() => focusedTile(page)).toBe(at)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

test('Back from Details opened on a poster past the first page returns to that poster', async () => {
  const page = await openBigLibrary()
  // Down until focus is past the first page of 60 (the next page loads on the way).
  for (let i = 0; i < 30 && (await focusedTile(page)) < 60; i++) await press(page, 'ArrowDown')
  await expect.poll(() => tileCount(page)).toBe(120)
  const at = await focusedTile(page)
  expect(at).toBeGreaterThanOrEqual(60)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(at)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

test('OK inside a menu does not turn a woken button into the user\'s choice', async () => {
  const page = await openBigLibrary()
  const app = box!.app
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await press(page, 'Enter')
  await expect(page.getByTestId('details')).toBeVisible()
  await control(app, { holdOffset: 0 })
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { __race: { held?: unknown } }).__race.held !== undefined)).toBe(true)
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  // The general menu (Sort has no options of its own): OK on Power opens the Power menu, which is then closed.
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-power'))
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-screen-off')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  await expectOnlyFocus(page, page.getByTestId('grid-sort'))
  await app.evaluate(() => { (globalThis as unknown as { __race: { held?: () => void } }).__race.held?.() })
  await expect.poll(() => tileCount(page)).toBe(60)
  await expect.poll(() => focusedTile(page)).toBe(3)
  await expect(page.getByTestId('grid-sort')).not.toHaveClass(/is-focused/)
})

test('the last poster under "Not watched" marked as watched hands focus to the new last poster', async () => {
  box = await launch()
  const { page } = box
  await notWatchedGrid(page)
  await press(page, 'ArrowDown')
  await expect.poll(() => focusedTile(page)).toBeGreaterThanOrEqual(0)
  for (let i = 0; i < 20; i++) {
    const at = await focusedTile(page)
    await press(page, 'ArrowDown')
    if ((await focusedTile(page)) === at) break
  }
  await pressUntil(page, 'ArrowRight', gridCells(page).last().locator('.focusable'))
  const count = await tileCount(page)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-watched'))
  await press(page, 'Enter')
  await expect.poll(() => tileCount(page)).toBe(count - 1)
  await expect.poll(() => focusedTile(page)).toBe(count - 2)
  await page.waitForTimeout(500)
  await expect.poll(() => focusedTile(page)).toBe(count - 2)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

test('Home with every row switched off offers Home screen settings', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.evaluate(`window.mediaos.call('settings.update',
    { home: { hiddenRows: ['continue', 'nextUp', 'apps', 'latest', 'libraries'] } })`)
  // Start the screen again so it reads the saved settings.
  await page.reload()
  await expect(page.getByTestId('home-nothing')).toBeVisible()
  const button = page.getByTestId('home-nothing-settings')
  await expect(button).toContainText('Home screen settings')
  await expectOnlyFocus(page, button)
  await press(page, 'Enter')
  await expect(page.getByTestId('settings-page-home')).toBeVisible()
})

test('an app the pointer moved onto while Home loads keeps focus', async () => {
  const { app, page } = await homeStillLoading(['home.get'])
  const apps = page.getByTestId('row-apps').locator('.focusable')
  await expect(apps.nth(1)).toBeVisible()
  await apps.nth(1).hover()
  await expectOnlyFocus(page, apps.nth(1))
  await release(app)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  await page.waitForTimeout(400)
  await expectOnlyFocus(page, apps.nth(1))
})

test('a poster clicked while another has focus is the one Back returns to', async () => {
  const page = await openBigLibrary()
  // A click with no pointer move first: focus is still on the first poster when the click opens Details.
  await gridCells(page).nth(5).locator('.focusable').dispatchEvent('click')
  await expect(page.getByTestId('details')).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await expect.poll(() => focusedTile(page)).toBe(5)
  await expect(page.locator('.is-focused')).toHaveCount(1)
})

/** Open the second library (shows) and then Coastline's Details. */
async function openCoastline(page: Page): Promise<void> {
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'ArrowRight')
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await pressUntil(page, 'ArrowRight', page.getByTestId('library-grid').locator('.focusable[aria-label*="Coastline"]'))
  await press(page, 'Enter')
  await expect(page.getByTestId('details-actions')).toBeVisible()
}

test('Back to a show returns to the episode the user left, in the season they were in', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openCoastline(page)
  const firstEpisode = page.getByTestId('episodes').locator('.focusable').first()
  const shown = /n(\d+)e\d+$/.exec((await firstEpisode.getAttribute('data-focus-key')) ?? '')?.[1]
  const target = shown === '1' ? 2 : 1
  const tabs = page.getByTestId('season-tabs').locator('.focusable')
  await press(page, 'ArrowDown')
  await expect(page.getByTestId('season-tabs').locator('.is-focused')).toHaveCount(1)
  await pressUntil(page, 'ArrowLeft', tabs.first())
  if (target === 2) await press(page, 'ArrowRight')
  await expectOnlyFocus(page, tabs.nth(target - 1))
  await expect(firstEpisode).toHaveAttribute('data-focus-key', new RegExp(`n${target}e1$`))
  await press(page, 'ArrowDown')
  await press(page, 'ArrowRight')
  const second = page.getByTestId('episodes').locator('.focusable').nth(1)
  await expectOnlyFocus(page, second)
  const key = (await second.getAttribute('data-focus-key')) ?? ''
  expect(key).toMatch(new RegExp(`n${target}e2$`))
  // The episode's own Details, from its menu, then Back.
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-details'))
  await press(page, 'Enter')
  await expect(page.getByTestId('season-tabs')).toHaveCount(0)
  await press(page, 'Escape')
  await expect(page.getByTestId('season-tabs')).toBeVisible()
  await expectOnlyFocus(page, page.locator(`[data-focus-key="${key}"]`))
  await expect(tabs.nth(target - 1)).toHaveClass(/is-active/)
})

test('an episode marked as watched from its menu stays in the season the user is in', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openCoastline(page)
  await press(page, 'Escape')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  const tile = page.getByTestId('library-grid').locator('.focusable[aria-label*="Coastline"]')
  const show = ((await tile.getAttribute('data-focus-key')) ?? '').replace(/^grid:/, '')
  expect(show).not.toBe('')
  // Season 1 watched up to episode 5, nothing else: the show's next episode is season 1, episode 6.
  await page.evaluate(`(async () => {
    const show = await window.mediaos.call('items.get', ${JSON.stringify(show)})
    for (const [si, season] of show.seasons.entries()) {
      const eps = await window.mediaos.call('items.children', season.key)
      for (const [i, ep] of eps.entries()) await window.mediaos.call('items.setWatched', ep.key, si === 0 && i < 5)
    }
  })()`)
  await press(page, 'Enter')
  await expect(page.getByTestId('details-actions')).toBeVisible()
  const tabs = page.getByTestId('season-tabs').locator('.focusable')
  await expect(tabs.first()).toHaveClass(/is-active/)
  const sixth = page.getByTestId('episodes').locator('.focusable').nth(5)
  await expect(sixth).toHaveAttribute('data-focus-key', /n1e6$/)
  // The pointer goes straight to the episode (never through the season tabs).
  await sixth.hover()
  await expectOnlyFocus(page, sixth)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('menu-overlay')).toHaveCount(0)
  // The show's next episode is now in season 2, but the user is still in season 1, on the same episode.
  await page.waitForTimeout(500)
  await expect(tabs.first()).toHaveClass(/is-active/)
  await expect(sixth).toHaveAttribute('data-focus-key', /n1e6$/)
  await expectOnlyFocus(page, sixth)
})

test('a Bluetooth device forgotten in Settings hands focus to the row now in its place', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Settings')
  await pressUntil(page, 'ArrowDown', page.getByTestId('settings-nav-remotes'))
  await expect(page.getByTestId('settings-page-remotes')).toBeVisible()
  await press(page, 'Enter')
  const remote = page.getByTestId('settings-page-remotes').locator('.focusable[aria-label*="Living room remote"]')
  await pressUntil(page, 'ArrowDown', remote)
  await press(page, 'Enter')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-remove'))
  await press(page, 'Enter')
  await expect(remote).toHaveCount(0)
  // It was the only device: the row before it in the Bluetooth section takes focus, not a row in another section.
  await expectOnlyFocus(page, page.getByTestId('bt-scan'))
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, page.getByTestId('bt-scan'))
})

test('the last hidden app shown again keeps focus, now in the Apps grid', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Apps')
  const shown = page.getByTestId('apps').locator('.app-grid').first().locator('.focusable')
  await expectOnlyFocus(page, shown.first())
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, shown.nth(1))
  const id = ((await shown.nth(1).getAttribute('data-focus-key')) ?? '').replace(/^apps:/, '')
  expect(id).not.toBe('')
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-hide'))
  await press(page, 'Enter')
  const hidden = page.locator(`[data-focus-key="apps-hidden:${id}"]`)
  await expect(hidden).toHaveCount(1)
  await pressUntil(page, 'ArrowDown', hidden)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-unhide'))
  await press(page, 'Enter')
  await expect(hidden).toHaveCount(0)
  const back = page.locator(`[data-focus-key="apps:${id}"]`)
  await expectOnlyFocus(page, back)
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, back)
})

test('a new search that drops the focused result puts focus on the keyboard, not on a result it never chose', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Search')
  await expect(page.getByTestId('search')).toBeVisible()
  const results = page.getByTestId('search-results')
  // Search "the" first, so its results are ready the moment it is typed again.
  await page.keyboard.type('the', { delay: 60 })
  await expect(results.locator('.focusable[aria-label*="Glass Orchard"]')).toBeVisible()
  await expect(results.locator('.focusable[aria-label*="Northbound"]')).toHaveCount(0)
  await press(page, 'Backspace')
  const northbound = results.locator('.focusable[aria-label*="Northbound"]')
  await expect(northbound).toBeVisible()
  await pressUntil(page, 'ArrowRight', northbound)
  // "the" again: Northbound drops out, and a different search's results take the grid's place.
  await page.keyboard.type('e')
  await expect(northbound).toHaveCount(0)
  await expect(results.locator('.focusable').first()).toBeVisible()
  const key = page.locator('[data-focus-key="search:k:a"]')
  await expectOnlyFocus(page, key)
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, key)
})

test('a Home row whose only tile is marked as watched hands focus to the row now in its place', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await expect(page.getByTestId('row-continue')).toBeVisible()
  // Apps first, then Continue watching (only what is part-watched) with a single tile.
  await page.evaluate(`(async () => {
    await window.mediaos.call('settings.update', { home: { rows: ['apps', 'continue', 'nextUp', 'latest', 'libraries'], mergeContinue: false } })
    const home = await window.mediaos.call('home.get')
    const row = home.rows.find((r) => r.kind === 'continue')
    for (const item of row.items.slice(1)) await window.mediaos.call('items.setWatched', item.key, true)
  })()`)
  await page.reload()
  const rows = page.getByTestId('home-rows').locator('[data-testid^="row-"]')
  await expect(rows.first()).toHaveAttribute('data-testid', 'row-apps')
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'row-continue')
  const only = page.getByTestId('row-continue').locator('.focusable')
  await expect(only).toHaveCount(1)
  await expectOnlyFocus(page, rows.first().locator('.focusable').first())
  await press(page, 'ArrowDown')
  await expectOnlyFocus(page, only)
  await press(page, 'm')
  await pressUntil(page, 'ArrowDown', page.getByTestId('menu-watched'))
  await press(page, 'Enter')
  await expect(page.getByTestId('row-continue')).toHaveCount(0)
  const now = rows.nth(1).locator('.focusable').first()
  await expectOnlyFocus(page, now)
  await page.waitForTimeout(500)
  await expectOnlyFocus(page, now)
})

test('Details after stopping a film part-way puts focus on Resume, and only there', async () => {
  box = await launch()
  const { page } = box
  await finishSetup(page)
  await openTab(page, 'Libraries')
  await expect(page.getByTestId('library-card').first()).toBeVisible()
  await press(page, 'Enter')
  await expect(page.getByTestId('library-grid')).toBeVisible()
  await press(page, 'Enter')
  await expectOnlyFocus(page, page.getByTestId('details-play'))
  await expect(page.getByTestId('details-play')).toHaveText(/^Play$/)
  await press(page, 'Enter')
  const player = page.getByTestId('player')
  await expect(player).toHaveAttribute('data-status', 'playing')
  // Skip far enough in for the film to have a place to resume from (over 30 seconds).
  await press(page, 'ArrowRight', 3)
  await expect.poll(() => page.evaluate("window.mediaos.call('player.state')").then((r) => (r as { positionSec?: number })?.positionSec ?? 0))
    .toBeGreaterThan(40)
  // Back hides the controls if they are showing, then stops.
  await expect(async () => {
    if ((await player.count()) > 0) await press(page, 'Escape')
    await expect(player).toHaveCount(0, { timeout: 500 })
  }).toPass()
  await expect(page.getByTestId('details')).toBeVisible()
  // The Play button the user pressed is now "Play from the beginning"; focus goes to Resume instead.
  await expect(page.getByTestId('details-resume')).toBeVisible()
  await expectOnlyFocus(page, page.getByTestId('details-resume'))
  await press(page, 'ArrowRight')
  await expectOnlyFocus(page, page.getByTestId('details-start'))
})
