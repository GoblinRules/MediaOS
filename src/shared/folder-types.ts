export interface FolderShare {
  id: string; name: string; server: string; share: string; user: string; domain: string; guest: boolean
  /** Mounted and readable now. */
  available: boolean
  problem?: string
}
export interface FolderDrive { id: string; name: string; fs: string; sizeBytes?: number }
export interface FolderList { shares: FolderShare[]; drives: FolderDrive[] }
export interface FoundComputer { name: string; host: string; ip?: string }
export interface ShareLogin { server: string; ip?: string; guest: boolean; user?: string; password?: string; domain?: string }
export interface ShareAdd extends ShareLogin { share: string; name?: string }
export type FolderAddResult = { ok: true; id: string } | { ok: false; error: string }
