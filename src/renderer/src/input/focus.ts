// Spatial focus (Norigin). Norigin finds the next item in a direction; we own the keyboard ourselves (input.ts),
// so the adapter never listens for keys. Positions are measured with getBoundingClientRect, so scrolled rows
// measure where they really are on screen.
import {
  GetBoundingClientRectAdapter,
  ROOT_FOCUS_KEY,
  SpatialNavigation,
  doesFocusableExist,
  getCurrentFocusKey,
  init,
  navigateByDirection,
  setFocus,
} from '@noriginmedia/norigin-spatial-navigation'
import { unscaled } from './unscaled'

type Direction = 'up' | 'down' | 'left' | 'right'

class NoKeysAdapter extends GetBoundingClientRectAdapter {
  // Measured without the focused item's own zoom (see unscaled.ts), so a grown key never hides its neighbour.
  override measureLayout = async ({ node }: { node: HTMLElement }) => {
    const rect = node.getBoundingClientRect()
    const { left, top, width, height } = unscaled(rect, getComputedStyle(node).transform)
    return { node, x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
  }

  override addEventListeners(): void {
    // Keys come from input.ts, not from Norigin's own window listeners.
  }
  override removeEventListeners(): void {
    // Nothing was added.
  }
}

let started = false

export function initFocus(): void {
  if (started) return
  started = true
  init({ layoutAdapter: NoKeysAdapter, shouldFocusDOMNode: false, throttle: 0, distanceCalculationMethod: 'center' })
}

/** The screen's "where should focus go if it is lost" answer. */
let fallback: (() => string | undefined) | undefined

export function setFocusFallback(fn: (() => string | undefined) | undefined): void {
  fallback = fn
}

export function currentFocus(): string | undefined {
  const k = getCurrentFocusKey()
  return k && k !== ROOT_FOCUS_KEY && doesFocusableExist(k) ? k : undefined
}

export function exists(key: string | undefined): key is string {
  return Boolean(key) && doesFocusableExist(key as string)
}

/** Focus a key if it exists; returns true when it did. */
/**
 * A move asked for that Norigin hasn't made yet (setFocus is async). A dialog that opens in that gap (the network
 * trial straight after "Save and test") must return focus to where it was going, not to nothing.
 */
let requested: string | undefined

export function focus(key: string | undefined): boolean {
  if (!exists(key)) return false
  requested = key
  const settled = (): void => {
    if (requested === key) requested = undefined
  }
  setFocus(key).then(settled, settled)
  return true
}

/** True when the key is a real item (a button, tile or tab), not a group that may be empty. */
export function isItem(key: string | undefined): key is string {
  if (!exists(key)) return false
  return Boolean(document.querySelector(`.focusable[data-focus-key="${CSS.escape(key)}"]`))
}

/** Focus the first item on the screen (never the tab bar or an overlay); returns its key, if any. */
function focusFirstItem(): string | undefined {
  for (const node of document.querySelectorAll<HTMLElement>('main.screen .focusable[data-focus-key]')) {
    const key = node.dataset.focusKey
    if (!node.classList.contains('is-disabled') && focus(key)) return key
  }
  return undefined
}

/** Focus the screen's default item, else its first item; returns the key focused (undefined when neither exists). */
export function focusFallback(): string | undefined {
  const key = fallback?.()
  if (focus(key)) return key
  const first = focusFirstItem()
  if (first === undefined) void setFocus(ROOT_FOCUS_KEY)
  return first
}

/**
 * The item an arrow landed on when nothing was focused (focus "woke up" on the screen's default rather than the
 * user picking it). Cleared once focus moves on from it.
 */
let woke: string | undefined

export function wakeKey(): string | undefined {
  return woke
}

/**
 * Keys for an overlay act only inside it. If focus is not in it yet (it has only just opened, say), they put focus
 * on its first item instead, so a press can never reach the screen behind it. False when that happened (or the
 * overlay has nothing to focus).
 */
function inOverlay(overlay: string): boolean {
  if (currentFocus()?.startsWith(`${overlay}:`)) return true
  for (const node of document.querySelectorAll<HTMLElement>('.focusable[data-focus-key]')) {
    const key = node.dataset.focusKey
    if (key?.startsWith(`${overlay}:`) && !node.classList.contains('is-disabled') && focus(key)) break
  }
  return false
}

/**
 * Move focus with an arrow. `overlay` is the focus key of the menu or other overlay the move is in: moves there are
 * not a choice of where to be on the screen, so they leave the wake key alone.
 */
export function moveFocus(dir: Direction, overlay?: string): void {
  const screen = overlay === undefined
  if (!screen && !inOverlay(overlay)) return
  const before = currentFocus()
  if (!isItem(before)) {
    // Nothing focused yet (the screen is still loading), or only an empty group: Up goes to the tab bar even if
    // part of the screen (the Apps row, say) has already appeared below; other arrows go to the screen's first item.
    // Norigin moves focus asynchronously, so remember the key asked for rather than reading it back.
    woke = dir === 'up' && focus('topbar') ? 'topbar' : focusFallback()
    return
  }
  // Focus has moved on from where an arrow woke it, so landing there again later is the user's own choice.
  // (Checked here, before the move, because Norigin's moves finish asynchronously.)
  if (screen && before !== woke) woke = undefined
  // The focused item may veto the move (e.g. a slider uses left/right itself).
  if (SpatialNavigation.onArrowPress(dir, { pressedKeys: {} }) === false) return
  void navigateByDirection(dir, {})
}

/** The pointer (an air mouse, say) put focus on a screen item: that is the user's own choice, like an arrow. */
export function pointerChose(): void {
  woke = undefined
}

/** Press OK on the focused item. `overlay` is the overlay it is in, if any (see moveFocus). */
export function pressFocused(overlay?: string): void {
  const screen = overlay === undefined
  if (!screen && !inOverlay(overlay)) return
  if (!isItem(currentFocus())) {
    // OK with nothing focused only wakes focus up on the screen's default; it is not a choice of that item.
    const key = focusFallback()
    if (screen) woke = key
    return
  }
  // OK on a screen item (even one an arrow woke focus onto) is a clear choice of it.
  if (screen) woke = undefined
  SpatialNavigation.onEnterPress({ pressedKeys: {} })
}

/**
 * Where focus last was on the screen: the item, the element its neighbours share (its group, or a section of the
 * group marked data-focus-section, such as one of the Apps screen's grids) and its place among them. `section` is
 * that section's name when it was focused (Search names its results after the query, so a new query's results are
 * not "the same list"). `row` is where the item's group sat among the rows of a data-focus-rows group (Home), for
 * when the whole row goes.
 */
let lastSpot:
  | { key: string; list: HTMLElement; index: number; section?: string; row?: { rows: HTMLElement; index: number } }
  | undefined

/** The items whose nearest group is `group`, inside `within` (the group itself by default). */
function ownItems(group: HTMLElement, within: HTMLElement = group): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>('.focusable[data-focus-key]')].filter(
    (n) => n.parentElement?.closest('[data-focus-group]') === group,
  )
}

function groupOf(node: HTMLElement): HTMLElement | null {
  return node.parentElement?.closest<HTMLElement>('[data-focus-group]') ?? null
}

/** The element an item's neighbours share: the section of its group it is in, else the group. */
function listOf(node: HTMLElement, group: HTMLElement): HTMLElement {
  const section = node.parentElement?.closest<HTMLElement>('[data-focus-section]')
  return section && group.contains(section) ? section : group
}

function usable(nodes: HTMLElement[]): HTMLElement[] {
  return nodes.filter((n) => !n.classList.contains('is-disabled'))
}

/** The rows of a data-focus-rows group: its own child groups that have an item to focus. */
function rowsOf(rows: HTMLElement): HTMLElement[] {
  return [...rows.querySelectorAll<HTMLElement>('[data-focus-group]')].filter(
    (g) => g.parentElement?.closest('[data-focus-group]') === rows && usable(ownItems(g)).length > 0,
  )
}

/** Called when an item gets focus. Items in overlays and the tab bar are not places on the screen. */
export function noteFocused(key: string, node: HTMLElement): void {
  const group = groupOf(node)
  if (!group || !node.closest('main.screen')) return
  const list = listOf(node, group)
  const rows = group.parentElement?.closest<HTMLElement>('[data-focus-rows]')
  lastSpot = {
    key,
    list,
    index: usable(ownItems(group, list)).indexOf(node),
    section: list.dataset.focusSection,
    row: rows ? { rows, index: rowsOf(rows).indexOf(group) } : undefined,
  }
}

/** A new screen: where focus was on the old one means nothing here. */
export function forgetSpot(): void {
  lastSpot = undefined
}

/** The item that had focus on this screen, if it has since gone (to find where it went under another key). */
export function lostKey(): string | undefined {
  return lastSpot && !exists(lastSpot.key) ? lastSpot.key : undefined
}

/** The item at `index` among `nodes` (the last one when there are fewer), if it can take focus. */
function keyAt(nodes: HTMLElement[], index: number): string | undefined {
  const key = nodes[Math.min(Math.max(index, 0), nodes.length - 1)]?.dataset.focusKey
  return exists(key) ? key : undefined
}

/**
 * When the focused item has gone (a poster dropped by a "Not watched" filter after it was marked as watched, say),
 * the item now in its place among its neighbours, else the last of them. Undefined when the item still exists,
 * or its neighbours have all gone too (a different screen).
 */
export function replacementFor(): string | undefined {
  if (!lastSpot || exists(lastSpot.key)) return undefined
  const { list, row } = lastSpot
  if (!list.isConnected) {
    // The item's whole row went (its last item was marked as watched, say): the first item of the row now in its
    // place, else of the last row.
    if (!row?.rows.isConnected || row.index < 0) return undefined
    const rows = rowsOf(row.rows)
    const now = rows[Math.min(row.index, rows.length - 1)]
    return now ? keyAt(usable(ownItems(now)), 0) : undefined
  }
  if (list.dataset.focusSection !== lastSpot.section) return undefined
  const group = list.hasAttribute('data-focus-group') ? list : groupOf(list)
  return group ? keyAt(usable(ownItems(group, list)), lastSpot.index) : undefined
}

/**
 * An item left the page. If it had focus and the page is still there (a device forgotten in Settings, say), focus
 * the item now in its place once the page has settled. Screens whose data changed do this too (useScreenFocus);
 * this also covers pages whose screen-level answer does not change.
 */
export function itemGone(key: string): void {
  if (lastSpot?.key !== key) return
  setTimeout(() => {
    if (lastSpot?.key !== key || isItem(currentFocus())) return
    focus(replacementFor())
  }, 0)
}

/** The item being clicked while its click runs (focus moves to it asynchronously, so it may not have it yet). */
let clicked: string | undefined

/** Run a click on `key`: anything it does that asks where focus is (opening Details or a menu) sees `key`. */
export function clickOn(key: string, act: () => void): void {
  clicked = key
  try {
    act()
  } finally {
    clicked = undefined
  }
}

/** The item the user has chosen: the one being clicked, else the one focus is moving to, else the focused one. */
export function chosenFocus(): string | undefined {
  return clicked ?? (exists(requested) ? requested : undefined) ?? currentFocus()
}

/** Keep the focused screen item in view after the screen's data changed (it may have moved inside its row). */
export function revealFocused(): void {
  const key = currentFocus()
  const node = key ? document.querySelector<HTMLElement>(`main.screen .focusable[data-focus-key="${CSS.escape(key)}"]`) : null
  if (node) reveal(node)
}

/** Where a screen item sits: its group's name and its place among the group's items (remembered for Back). */
export function screenSpot(key: string): { group: string; index: number } | undefined {
  const node = document.querySelector<HTMLElement>(`main.screen .focusable[data-focus-key="${CSS.escape(key)}"]`)
  const group = node && groupOf(node)
  const name = group?.dataset.focusGroup
  if (!node || !group || !name) return undefined
  return { group: name, index: usable(ownItems(group)).indexOf(node) }
}

/** The item at `index` in the screen group named `group` (its last item when it has fewer). */
export function itemAt(group: string, index: number): string | undefined {
  const node = document.querySelector<HTMLElement>(`main.screen [data-focus-group="${CSS.escape(group)}"]`)
  return node && index >= 0 ? keyAt(usable(ownItems(node)), index) : undefined
}

/**
 * Keep the focused element visible. Rows marked data-scroll="x" scroll sideways; the screen (data-scroll="y")
 * scrolls so the whole row (data-reveal) is in view. Scrolling is instant so positions are always measurable.
 */
export function reveal(node: HTMLElement): void {
  const row = node.closest<HTMLElement>('[data-scroll="x"]')
  if (row) {
    const r = row.getBoundingClientRect()
    const n = node.getBoundingClientRect()
    const pad = Math.min(r.width * 0.12, n.width * 0.6)
    if (n.left < r.left + pad) row.scrollLeft -= r.left + pad - n.left
    else if (n.right > r.right - pad) row.scrollLeft += n.right - (r.right - pad)
  }
  const page = node.closest<HTMLElement>('[data-scroll="y"]')
  if (page) {
    const target = node.closest<HTMLElement>('[data-reveal]') ?? node
    const r = page.getBoundingClientRect()
    const n = target.getBoundingClientRect()
    const top = r.top + r.height * 0.08
    const bottom = r.bottom - r.height * 0.06
    if (target.dataset.reveal === 'top') page.scrollTop += n.top - top
    else if (n.top < top) page.scrollTop -= top - n.top
    else if (n.bottom > bottom) page.scrollTop += Math.min(n.bottom - bottom, n.top - top)
  }
}

/** What the Menu key opens for the focused item (set when an item with options gets focus). */
let menuTarget: { key: string; open: () => void } | undefined

export function setMenuTarget(key: string, open: (() => void) | undefined): void {
  menuTarget = open ? { key, open } : undefined
}

/** Open the focused item's options; false when it has none. */
export function openFocusedMenu(): boolean {
  if (!menuTarget || menuTarget.key !== currentFocus()) return false
  // Asking for an item's options is a choice of that item, even if an arrow only woke focus onto it.
  woke = undefined
  menuTarget.open()
  return true
}
