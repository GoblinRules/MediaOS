// Short messages at the bottom of the screen. Core sends some (toast event); the UI adds its own.
import type { Toast } from '@shared/system-types'
import { createStore } from '../lib/store'

export const toastStore = createStore<Toast[]>([])
let seq = 0

export function pushToast(t: Toast): void {
  toastStore.set((list) => [...list.filter((x) => x.id !== t.id), t].slice(-3))
  setTimeout(() => dismissToast(t.id), t.tone === 'error' ? 7000 : 4000)
}

export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  seq += 1
  pushToast({ id: `ui-${seq}`, text, tone })
}

export function dismissToast(id: string): void {
  toastStore.set((list) => (list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : list))
}
