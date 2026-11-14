// One path for every input. DOM keys go through keyToAction + KeyTiming (long presses); actions from core
// (gamepad, phone remote, CEC daemon) arrive already timed. Handlers form layers: the highest priority layer
// that returns true wins; otherwise arrows move focus and Select presses the focused item.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { keyToAction, type Action } from '@shared/actions'
import { KeyTiming } from '@shared/key-timing'
import { moveFocus, pressFocused } from './focus'

export type ActionInfo = { long: boolean }
export type Handler = (action: Action, info: ActionInfo) => boolean

/** Layer priorities: higher runs first. */
export const LAYER = { app: 0, screen: 10, player: 20, overlay: 30, screensaver: 100 } as const

interface Layer {
  priority: number
  seq: number
  handler: { current: Handler }
}

const layers: Layer[] = []
let seq = 0
const activity = new Set<() => void>()

export function addLayer(priority: number, handler: { current: Handler }): () => void {
  seq += 1
  const layer: Layer = { priority, seq, handler }
  layers.push(layer)
  layers.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  return () => {
    const i = layers.indexOf(layer)
    if (i >= 0) layers.splice(i, 1)
  }
}

/** Register an input layer for as long as the component is mounted (and `active`). */
export function useInputLayer(priority: number, handler: Handler, active = true): void {
  const ref = useRef(handler)
  useLayoutEffect(() => {
    ref.current = handler
  })
  useEffect(() => (active ? addLayer(priority, ref) : undefined), [priority, active])
}

/** Called on every key or remote press (the screensaver timer listens). */
export function onActivity(fn: () => void): () => void {
  activity.add(fn)
  return () => {
    activity.delete(fn)
  }
}

export type ScreenMove = 'up' | 'down' | 'left' | 'right' | 'back' | 'pointer'

let screenMoves = 0
let lastScreenMove: ScreenMove | undefined

/**
 * Note a press that moved around the screen itself (not inside a menu, the player or the screensaver). A screen
 * still loading uses this to see whether the user went somewhere on their own, such as up to the tab bar.
 */
export function noteScreenMove(move: ScreenMove): void {
  screenMoves += 1
  lastScreenMove = move
}

export function screenMoveCount(): number {
  return screenMoves
}

export function lastMove(): ScreenMove | undefined {
  return lastScreenMove
}

function touch(): void {
  for (const fn of [...activity]) fn()
}

export function dispatch(action: Action, info: ActionInfo = { long: false }): void {
  touch()
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (layer && layer.handler.current(action, info)) return
  }
  switch (action) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      noteScreenMove(action)
      moveFocus(action)
      break
    case 'select':
      pressFocused()
      break
    default:
      break
  }
}

/** Where typed characters go while an on-screen keyboard is open (physical keyboards and phone remotes). */
export interface TextSink {
  insert(text: string): void
  /** Returns false when there is nothing to delete (so Backspace acts as Back). */
  backspace(): boolean
}

const sinks: TextSink[] = []

/** Make `s` the active text sink (sinks stack: closing a keyboard overlay gives typing back to Search). */
export function setTextSink(s: TextSink): () => void {
  sinks.push(s)
  return () => {
    const i = sinks.lastIndexOf(s)
    if (i >= 0) sinks.splice(i, 1)
  }
}

function activeSink(): TextSink | undefined {
  return sinks[sinks.length - 1]
}

/** Send typed text from outside the DOM (phone remote) to the active text sink. */
export function typeText(text: string): void {
  touch()
  activeSink()?.insert(text)
}

/** Delete one character from the active text sink (the phone remote's ⌫). Does nothing when no keyboard is open. */
export function eraseText(): void {
  touch()
  activeSink()?.backspace()
}

/** True while a holdable key (Back/Select/Home) is down, so the UI can hint "keep holding". */
let timing: KeyTiming | undefined

export function heldKey(): Action | undefined {
  return timing?.pending()
}

export function installKeyboard(target: Window = window): () => void {
  const t = new KeyTiming((action, info) => dispatch(action, info))
  timing = t
  const down = (e: KeyboardEvent): void => {
    if (e.ctrlKey && e.altKey && e.key === 'Backspace') {
      e.preventDefault()
      t.cancel()
      dispatch('recovery')
      return
    }
    const sink = activeSink()
    if (sink && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key.length === 1) {
        e.preventDefault()
        touch()
        sink.insert(e.key)
        return
      }
      if (e.key === 'Backspace' && sink.backspace()) {
        e.preventDefault()
        touch()
        return
      }
    }
    if (e.ctrlKey || e.metaKey) return
    const action = keyToAction(e.key, e.code)
    if (!action) return
    e.preventDefault()
    t.down(action, e.repeat)
  }
  const up = (e: KeyboardEvent): void => {
    const action = keyToAction(e.key, e.code)
    if (action) t.up(action)
  }
  const blur = (): void => t.cancel()
  target.addEventListener('keydown', down, true)
  target.addEventListener('keyup', up, true)
  target.addEventListener('blur', blur)
  return () => {
    target.removeEventListener('keydown', down, true)
    target.removeEventListener('keyup', up, true)
    target.removeEventListener('blur', blur)
    t.cancel()
    if (timing === t) timing = undefined
  }
}
