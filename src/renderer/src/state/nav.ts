// Where the user is: a stack of screens (each remembers what was focused) plus overlays on top.
import { useEffect } from 'react'
import { createStore } from '../lib/store'
import {
  chosenFocus, currentFocus, exists, focus, focusFallback, forgetSpot, isItem, itemAt, replacementFor, revealFocused,
  screenSpot, setFocusFallback, wakeKey,
} from '../input/focus'
import { lastMove, screenMoveCount } from '../input/input'

export type Tab = 'home' | 'libraries' | 'apps' | 'search' | 'settings'
export const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'apps', label: 'Apps' },
  { id: 'search', label: 'Search' },
  { id: 'settings', label: 'Settings' },
]

export type SettingsPage =
  | 'network' | 'display' | 'sound' | 'remotes' | 'libraries' | 'home' | 'apps' | 'playback' | 'system'

export type Route =
  | { name: 'home' }
  | { name: 'libraries' }
  | { name: 'apps' }
  | { name: 'search' }
  | { name: 'settings'; page?: SettingsPage }
  | { name: 'library'; key: string; title: string }
  | { name: 'details'; key: string }
  | { name: 'setup' }

export interface Entry {
  id: number
  route: Route
  /** What was focused when the user left this screen (restored on Back). */
  focusKey?: string
  /**
   * Where that item sat: its group and its place among the group's items. If the item has gone by the time the
   * user comes Back (a film marked as watched under "Not watched", say), the item now in its place gets focus.
   */
  focusSpot?: { group: string; index: number }
}

let seq = 1
export const navStore = createStore<Entry[]>([{ id: seq, route: { name: 'home' } }])

function entry(route: Route): Entry {
  seq += 1
  return { id: seq, route }
}

/** An item of a menu or other overlay (`ov<id>:...`), which is never a place on the screen. */
function isOverlayKey(key: string | undefined): boolean {
  return key !== undefined && /^ov\d+:/.test(key)
}

function saveFocus(stack: Entry[]): Entry[] {
  const top = stack[stack.length - 1]
  let k = chosenFocus()
  // Opened from a menu (Details from a poster's menu, say): the menu may not have closed yet, so remember the item
  // it was opened on, not the menu's own button.
  if (isOverlayKey(k)) k = overlayStore.get()[0]?.returnFocus ?? lastClosedReturn
  if (!top || !k || isOverlayKey(k)) return stack
  const spot = screenSpot(k)
  return [...stack.slice(0, -1), { ...top, focusKey: k, focusSpot: spot }]
}

/** A new screen: a return point from an overlay on the old one means nothing here. */
function leaveScreen(): void {
  lastClosedReturn = undefined
  forgetSpot()
}

export function topEntry(): Entry {
  const s = navStore.get()
  return s[s.length - 1] ?? { id: 0, route: { name: 'home' } }
}

export function push(route: Route): void {
  navStore.set((s) => [...saveFocus(s), entry(route)])
  leaveScreen()
}

/** Go back one screen; false when already at the bottom. */
export function pop(): boolean {
  const s = navStore.get()
  const below = s[s.length - 2]
  if (!below) return false
  // A fresh id so the screen mounts again and restores its remembered focus.
  seq += 1
  navStore.set([...s.slice(0, -2), { ...below, id: seq }])
  leaveScreen()
  return true
}

export function isTab(name: Route['name']): name is Tab {
  return TABS.some((t) => t.id === name)
}

/** Switch to a top-bar tab (clears the stack). */
export function goTab(tab: Tab, page?: SettingsPage): void {
  const top = topEntry()
  if (top.route.name === tab && navStore.get().length === 1 && !page) return
  navStore.set([entry(tab === 'settings' ? { name: 'settings', page } : { name: tab })])
  leaveScreen()
}

export function resetTo(route: Route): void {
  navStore.set([entry(route)])
  leaveScreen()
}

/** Screens (by entry id) that have already put focus on their content once. */
const focusedEntries = new Set<number>()
/** How many screen moves had been made when each screen (by entry id) started loading. */
const movesAtStart = new Map<number, number>()

function markFocused(id: number): void {
  const live = new Set(navStore.get().map((e) => e.id))
  for (const old of focusedEntries) if (!live.has(old)) focusedEntries.delete(old)
  for (const old of movesAtStart.keys()) if (!live.has(old)) movesAtStart.delete(old)
  focusedEntries.add(id)
}

/**
 * The top screen is loading again from scratch (Home's "Try again", say): when it is ready, focus its default
 * item as if it had just opened, unless the user moves somewhere themselves in the meantime.
 */
export function restartScreenFocus(): void {
  const id = topEntry().id
  focusedEntries.delete(id)
  movesAtStart.set(id, screenMoveCount())
}

/**
 * Whether `key` is somewhere the user chose while the screen loaded, so it must not be overridden: they moved
 * since the screen appeared, it is a real item, and it is not just where an arrow "woke" focus up on the screen's
 * default. On the tab bar, a last press of Down means they asked for the content, so it is not kept.
 */
function userChose(key: string | undefined, movesAtStart: number): boolean {
  if (screenMoveCount() === movesAtStart || !isItem(key)) return false
  if (key.startsWith('tab:')) return lastMove() !== 'down'
  return key !== wakeKey()
}

/**
 * Put focus on a screen once its content is ready: the remembered item when coming Back, otherwise the
 * screen's default. Also tells the input layer where to go if focus is lost. Where the user moved while the
 * screen was still loading (the tab bar, or along a row that had already appeared), focus stays. If focus is
 * lost later (a "Try again" that reloads the screen, say), the screen is focused again when it is ready.
 */
export function useScreenFocus(current: Entry, ready: boolean, fallbackKey: () => string | undefined): void {
  const { id, focusKey, focusSpot } = current
  if (!movesAtStart.has(id)) movesAtStart.set(id, screenMoveCount())
  useEffect(() => {
    setFocusFallback(fallbackKey)
    return () => setFocusFallback(undefined)
  }, [fallbackKey])
  useEffect(() => {
    if (!ready) return
    const first = !focusedEntries.has(id)
    const overlays = overlayStore.get()
    // After the first time, only step in when focus is on nothing or on an empty group (no ring, dead keys).
    if (!first && (overlays.length > 0 || isItem(currentFocus()))) {
      // The data changed under the focused item, which may have moved (a Continue watching tile played just now goes
      // to the front of its row): keep it in view.
      revealFocused()
      return
    }
    const start = movesAtStart.get(id) ?? screenMoveCount()
    markFocused(id)
    // The first time: the remembered item when coming Back, else the default. Later (the focused item went away,
    // e.g. a poster dropped by a filter): the item now in its place, so the user stays where they were.
    const target = first ? (backTarget(focusKey, focusSpot) ?? fallbackKey()) : (replacementFor() ?? fallbackKey())
    if (modal) {
      // The "Keep these settings?" dialog has focus: the screen's item is where focus goes when it closes.
      if (target !== undefined) focusScreen(target)
      return
    }
    const top = overlays[0]
    if (top) {
      // A menu opened while the screen loaded keeps focus; the screen's item is where focus goes when it closes.
      if (!userChose(top.returnFocus, start) && target !== undefined) focusScreen(target)
      return
    }
    if (first && userChose(currentFocus(), start)) return
    if (!focus(target)) focusFallback()
  }, [ready, id, focusKey, focusSpot, fallbackKey])
}

/** Coming Back to a screen: the remembered item, else the item now in its place (undefined for a new screen). */
function backTarget(key: string | undefined, spot: Entry['focusSpot']): string | undefined {
  if (exists(key)) return key
  return spot ? itemAt(spot.group, spot.index) : undefined
}

// ---------- Overlays ----------

export type IconName = string

export interface MenuItem {
  id: string
  label: string
  detail?: string
  icon?: IconName
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type Overlay =
  | { kind: 'menu'; title?: string; subtitle?: string; items: MenuItem[]; side?: boolean }
  | {
      kind: 'confirm'
      title: string
      body?: string
      confirmLabel: string
      cancelLabel?: string
      danger?: boolean
      /** Start on the cancel button (dangerous choices always do). */
      startOnCancel?: boolean
      onConfirm: () => void
      /** Runs when the user picks cancel or presses Back. */
      onCancel?: () => void
    }
  | {
      kind: 'keyboard'
      title: string
      initial: string
      secret?: boolean
      maxLength?: number
      hint?: string
      /** 'ip' shows a number pad for IPv4 addresses instead of the full keyboard. */
      pad?: 'text' | 'ip'
      /** Runs before Done closes the keyboard: a message keeps it open and shows under the field. */
      validate?: (value: string) => string | undefined
      /** Characters that may be typed (each one is tested on its own); others are ignored. */
      allowed?: RegExp
      onDone: (value: string) => void
    }

export type OverlayEntry = Overlay & { id: number; returnFocus?: string }

export const overlayStore = createStore<OverlayEntry[]>([])

/**
 * Where focus was sent when the last overlay closed (focus moves asynchronously, so it may not be there yet).
 * Forgotten when the screen changes.
 */
let lastClosedReturn: string | undefined

/**
 * Where focus should go back to when a new overlay closes: what is focused now, unless that is nothing or an item
 * of an overlay that has just closed (a menu choice that opens a confirmation, say), when it is where that
 * overlay sent focus back to.
 */
function returnPoint(list: OverlayEntry[]): string | undefined {
  const k = chosenFocus()
  const owner = k ? /^ov(\d+):/.exec(k) : null
  const stale = owner !== null && !list.some((o) => o.id === Number(owner[1]))
  return k && !stale ? k : lastClosedReturn
}

/** Send focus back to `key` after an overlay closed; if that item has gone, the item now in its place. */
function returnTo(key: string | undefined): string | undefined {
  if (focus(key)) return key
  const instead = replacementFor()
  return focus(instead) ? instead : focusFallback()
}

export function openOverlay(o: Overlay): number {
  seq += 1
  const id = seq
  overlayStore.set((list) => [...list, { ...o, id, returnFocus: returnPoint(list) }])
  return id
}

/** Close an overlay (the top one by default) and put focus back where it was. */
export function closeOverlay(id?: number): void {
  const list = overlayStore.get()
  const target = id === undefined ? list[list.length - 1] : list.find((o) => o.id === id)
  if (!target) return
  const at = list.indexOf(target)
  if (at < list.length - 1) {
    // Not the top one (a timer closing a confirmation that another has since covered): focus stays in the overlay
    // on top, which now returns to where this one would have.
    overlayStore.set(list.flatMap((o, i) => (i === at ? [] : i === at + 1 ? [{ ...o, returnFocus: target.returnFocus }] : [o])))
    return
  }
  overlayStore.set(list.filter((o) => o !== target))
  lastClosedReturn = returnTo(target.returnFocus)
}

/**
 * Move focus to something on the screen. If a menu or other overlay is open on top, focus stays in the overlay
 * and the screen item becomes where focus returns once the overlays close (a finished sign-in or a step change
 * underneath must never pull focus out from under the Recovery menu).
 */
export function focusScreen(key: string): boolean {
  const list = overlayStore.get()
  if (list.length === 0 && modal) {
    if (!exists(key)) return false
    modal.returnFocus = key
    return true
  }
  if (list.length === 0) return focus(key)
  if (!exists(key)) return false
  overlayStore.set(list.map((o, i) => (i === 0 ? { ...o, returnFocus: key } : o)))
  return true
}

export function closeAllOverlays(): void {
  const list = overlayStore.get()
  if (list.length === 0) return
  const first = list[0]
  overlayStore.set([])
  lastClosedReturn = returnTo(first?.returnFocus)
}

export function confirm(o: Omit<Extract<Overlay, { kind: 'confirm' }>, 'kind'>): void {
  openOverlay({ kind: 'confirm', ...o })
}

export function menu(title: string | undefined, items: MenuItem[], subtitle?: string): void {
  if (items.length === 0) return
  openOverlay({ kind: 'menu', title, subtitle, items, side: true })
}

export function keyboard(o: Omit<Extract<Overlay, { kind: 'keyboard' }>, 'kind'>): void {
  openOverlay({ kind: 'keyboard', ...o })
}

// ---------- Modal dialog ----------

/**
 * A dialog drawn outside the overlay list (the network "Keep these settings?" check, which main drives). It has
 * focus while it shows; menus may still open above it. Only one at a time.
 */
let modal: { prefix: string; returnFocus?: string } | undefined

export function modalShowing(): boolean {
  return modal !== undefined
}

/** The dialog (whose focus keys start with `prefix:`) appeared: remember where to put focus when it goes. */
export function beginModal(prefix: string): void {
  let k = chosenFocus()
  if (isOverlayKey(k)) k = overlayStore.get()[0]?.returnFocus ?? lastClosedReturn
  if (k?.startsWith(`${prefix}:`)) k = undefined
  modal = { prefix, returnFocus: k }
}

/** The dialog went: focus goes back where it was, or (with a menu open above it) the menu returns there. */
export function endModal(): void {
  const m = modal
  if (!m) return
  modal = undefined
  const list = overlayStore.get()
  const first = list[0]
  if (first) {
    if (first.returnFocus === undefined || first.returnFocus.startsWith(`${m.prefix}:`)) {
      overlayStore.set(list.map((o, i) => (i === 0 ? { ...o, returnFocus: m.returnFocus } : o)))
    }
    return
  }
  lastClosedReturn = returnTo(m.returnFocus)
}
