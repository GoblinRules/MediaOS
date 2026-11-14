export interface PhoneInfo {
  id: string
  name: string
  pairedAt: string
  lastUsed: string
}

export type PairStartResult = { ok: true; url: string; code: string; expiresAt: string } |
  { ok: false; error: 'off' | 'no-network' | 'unavailable' }

export type RemoteText = { text: string } | { backspace: true }
export type PairEndReason = 'paired' | 'expired' | 'too-many-tries' | 'off'
