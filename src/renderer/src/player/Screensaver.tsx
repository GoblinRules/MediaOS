// Screensaver and screen-off timers. Both count from the last button press and pause while something
// plays or a streaming app is open. Any button (or moving the mouse) wakes the screen; that press is used up.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call } from '../lib/api'
import { screenJustTurnedOff, turnScreenOff, wakeScreen } from '../state/screen'
import { LAYER, onActivity, useInputLayer } from '../input/input'
import { foregroundStore, playerActive } from '../state/player'
import { useSettings } from '../state/settings'
import { Clock } from '../components/TopBar'

const TICK_MS = 5000

function reportIdle(idle: boolean): void {
  void call('shell.reportIdle', idle).catch(() => undefined)
}

export function Screensaver(): ReactNode {
  const settings = useSettings()
  const [idle, setIdle] = useState(false)
  // Set by the press that switched the screen back on, so the layer below uses it up.
  const swallow = useRef(false)
  const saverMin = settings.display.screensaverMin
  const offMin = settings.display.screenOffMin

  useEffect(() => {
    let last = Date.now()
    let saver = false
    let off = false
    const resetIdle = (): void => {
      last = Date.now()
      off = false
      if (saver) {
        saver = false
        setIdle(false)
        reportIdle(false)
      }
    }
    // While a video or app is in front, core's key routing wakes the screen instead.
    let pointer: { x: number; y: number } | undefined
    const wakeByMouse = (e: MouseEvent): void => {
      // Switching the screen off makes the pointer leave and re-enter it, which Chromium reports as a move on the spot.
      // Only a real move counts, and none straight after the screen went off.
      const moved = pointer !== undefined && (pointer.x !== e.screenX || pointer.y !== e.screenY)
      pointer = { x: e.screenX, y: e.screenY }
      if (!moved || screenJustTurnedOff()) return
      resetIdle()
      wakeScreen()
    }
    const wakeByPress = (): void => {
      resetIdle()
      if (!wakeScreen()) return
      // The press's own layers run straight after this; typed text has none, so don't let it eat a later press.
      swallow.current = true
      queueMicrotask(() => { swallow.current = false })
    }
    const tick = (): void => {
      if (playerActive() || foregroundStore.get().kind !== 'shell') {
        resetIdle()
        return
      }
      const idleMs = Date.now() - last
      if (!saver && saverMin > 0 && idleMs >= saverMin * 60_000) {
        saver = true
        setIdle(true)
        reportIdle(true)
      }
      if (!off && offMin > 0 && idleMs >= offMin * 60_000) {
        off = true
        void turnScreenOff({ quiet: true })
      }
    }
    const stopActivity = onActivity(wakeByPress)
    const timer = setInterval(tick, TICK_MS)
    window.addEventListener('mousemove', wakeByMouse)
    return () => {
      clearInterval(timer)
      stopActivity()
      window.removeEventListener('mousemove', wakeByMouse)
    }
  }, [saverMin, offMin])

  // Swallow the waking press (screensaver or screen off) so it doesn't also move focus or open something.
  useInputLayer(LAYER.screensaver, () => {
    if (swallow.current) {
      swallow.current = false
      setIdle(false)
      return true
    }
    if (!idle) return false
    setIdle(false)
    return true
  })

  if (!idle) return null
  return (
    <div className="screensaver" data-testid="screensaver" onClick={() => setIdle(false)}>
      <div className="screensaver-clock">
        <Clock />
        <div className="screensaver-name">{settings.deviceName}</div>
      </div>
    </div>
  )
}
