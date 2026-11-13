import type { AppEntry } from '@shared/apps'

export type AppExitReason = 'exited' | 'handover'

/** Runs a streaming app. Linux: Google Chrome --app in its own profile. Mock: a placeholder window. */
export interface AppHost {
  launch(app: AppEntry): Promise<void>
  /** Close the running app (if any). */
  close(): Promise<void>
  running(): string | undefined
  /** Wipe the app's browser profile (signs the user out of that service). */
  resetProfile(appId: string): Promise<void>
  /** Fires when the running app exits by itself (crash, user closed it). */
  onExit(cb: (appId: string, reason: AppExitReason) => void): () => void
}
