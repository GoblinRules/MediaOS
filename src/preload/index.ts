// The only code that can talk to the main process. It runs sandboxed, so it may only require('electron').
// Calls are validated here before sending (and again in main); events are validated before reaching the UI.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  CALL_CHANNEL, EVENT_CHANNEL, EVENT_SCHEMAS, validateCall,
  type CallName, type CallReply, type EventName, type EventPayloads, type MediaosApi,
} from '@shared/ipc-contract'

type Listener = (payload: unknown) => void
const listeners = new Map<EventName, Set<Listener>>()

ipcRenderer.on(EVENT_CHANNEL, (_e: IpcRendererEvent, msg: unknown) => {
  if (typeof msg !== 'object' || msg === null) return
  const { event, payload } = msg as { event?: unknown; payload?: unknown }
  if (typeof event !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, event)) return
  const name = event as EventName
  if (!EVENT_SCHEMAS[name].safeParse(payload).success) return
  for (const cb of listeners.get(name) ?? []) {
    try {
      cb(payload)
    } catch (err) {
      console.error('MediaOS event listener failed', err)
    }
  }
})

const platform: 'linux' | 'mock' = process.argv.includes('--mediaos-platform=linux') ? 'linux' : 'mock'

const api: MediaosApi = {
  platform,
  async call(name: CallName, ...args: unknown[]) {
    const checked = validateCall(name, args)
    if ('error' in checked) {
      // The detail is technical (and never holds the arguments themselves), so it goes to the console only.
      console.warn('MediaOS call refused:', checked.error)
      throw new Error('Something went wrong. Try again, or restart MediaOS from Settings.')
    }
    const reply = (await ipcRenderer.invoke(CALL_CHANNEL, checked.name, checked.args)) as CallReply<unknown>
    if (!reply || typeof reply !== 'object') throw new Error('No reply from MediaOS core.')
    if (!reply.ok) throw new Error(reply.error)
    return reply.value as never
  },
  on<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void) {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    const fn = cb as Listener
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  },
} as MediaosApi

contextBridge.exposeInMainWorld('mediaos', api)
