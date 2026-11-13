// What the preload exposes to the renderer as `window.mediaos`.
import type { MediaosApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    readonly mediaos: MediaosApi
  }
}

export {}
