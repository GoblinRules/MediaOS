// Opening, pinning and hiding streaming apps.
import type { AppEntry } from '@shared/apps'
import { confirm, menu, type MenuItem } from '../state/nav'
import { getSettings, updateSettings } from '../state/settings'
import { toast } from '../state/toasts'
import { run } from './api'

const POINTER_HINTS = 3

export async function launchApp(app: AppEntry): Promise<void> {
  if (app.blocked) {
    toast(app.note ?? `${app.name} does not work on this box.`, 'warn')
    return
  }
  const s = getSettings()
  if (app.nav === 'pointer' && s && s.apps.pointerHintsShown < POINTER_HINTS) {
    toast(`${app.name} needs pointer mode: use your remote's pointer or a mouse. Hold Back to come Home.`, 'info')
    void updateSettings((c) => ({ apps: { pointerHintsShown: c.apps.pointerHintsShown + 1 } }))
  }
  await run('apps.launch', app.id)
}

// Each change is worked out from the settings as they are when it is sent, so two quick edits both survive.

function setPinned(app: AppEntry, pinned: boolean): void {
  void updateSettings((s) => {
    const list = s.apps.pinned.filter((id) => id !== app.id)
    return { apps: { pinned: pinned ? [...list, app.id] : list } }
  }).then((ok) => {
    if (ok) toast(pinned ? `${app.name} is now on Home` : `Removed ${app.name} from Home`, 'ok')
  })
}

function movePinned(app: AppEntry, by: -1 | 1): void {
  void updateSettings((s) => {
    const list = [...s.apps.pinned]
    const i = list.indexOf(app.id)
    const j = i + by
    const other = list[j]
    if (i < 0 || other === undefined) return undefined
    list[j] = app.id
    list[i] = other
    return { apps: { pinned: list } }
  })
}

function setHidden(app: AppEntry, hidden: boolean): void {
  void updateSettings((s) => {
    const list = s.apps.hidden.filter((id) => id !== app.id)
    const pinned = hidden ? s.apps.pinned.filter((id) => id !== app.id) : s.apps.pinned
    return { apps: { hidden: hidden ? [...list, app.id] : list, pinned } }
  }).then((ok) => {
    if (ok) toast(hidden ? `Hid ${app.name}. Find it again under "Hidden apps".` : `${app.name} is back in Apps`, 'ok')
  })
}

function resetSignIn(app: AppEntry): void {
  confirm({
    title: `Sign out of ${app.name}?`,
    body: 'This clears everything the app saved on this box, including your sign-in.',
    confirmLabel: 'Sign out',
    danger: true,
    onConfirm: () => {
      void run('apps.resetProfile', app.id).then((ok) => {
        if (ok) toast(`Signed out of ${app.name}`, 'ok')
      })
    },
  })
}

export function appMenuItems(app: AppEntry): MenuItem[] {
  const s = getSettings()
  const pinned = s?.apps.pinned ?? []
  const hidden = s?.apps.hidden.includes(app.id) ?? false
  const i = pinned.indexOf(app.id)
  const items: MenuItem[] = []
  if (!app.blocked) items.push({ id: 'open', label: 'Open', icon: 'play', onSelect: () => void launchApp(app) })
  if (i >= 0) {
    items.push({ id: 'unpin', label: 'Remove from Home', icon: 'minus', onSelect: () => setPinned(app, false) })
    if (i > 0) items.push({ id: 'left', label: 'Move left on Home', icon: 'back', onSelect: () => movePinned(app, -1) })
    if (i < pinned.length - 1) items.push({ id: 'right', label: 'Move right on Home', icon: 'next', onSelect: () => movePinned(app, 1) })
  } else if (!app.blocked && !hidden) {
    items.push({ id: 'pin', label: 'Add to Home', icon: 'pin', onSelect: () => setPinned(app, true) })
  }
  items.push(
    hidden
      ? { id: 'unhide', label: 'Show in Apps', icon: 'eye', onSelect: () => setHidden(app, false) }
      : { id: 'hide', label: 'Hide', icon: 'eyeOff', onSelect: () => setHidden(app, true) },
  )
  if (!app.blocked) items.push({ id: 'reset', label: 'Sign out and clear app data', icon: 'trash', danger: true, onSelect: () => resetSignIn(app) })
  return items
}

export function openAppMenu(app: AppEntry): void {
  menu(app.name, appMenuItems(app), app.blocked ? app.note : `${app.quality}${app.nav === 'pointer' ? ' · Uses pointer mode' : ''}`)
}
