import type { Action } from '@shared/actions'
import type { Foreground, EventPayloads } from '@shared/ipc-contract'
import type { PlayerController } from '../player/types'
import type { AppHost } from '../apps/types'

export interface ActionRouterOptions {
  foreground: () => Foreground
  setForeground: (foreground: Foreground) => void
  player: PlayerController
  apps: AppHost
  playbackSettings: () => { skipBackSec: number; skipForwardSec: number }
  emit: <E extends 'action' | 'recovery'>(event: E, value: EventPayloads[E]) => void
}

export class ActionRouter {
  constructor(private opts: ActionRouterOptions) {}
  async route(action: Action, long = false): Promise<void> {
    const foreground = this.opts.foreground()
    if (action === 'recovery') {
      // The Recovery menu lives in the shell, so whatever is covering it goes first.
      try {
        if (foreground.kind === 'app') await this.opts.apps.close()
        if (foreground.kind === 'player') await this.opts.player.stop()
      } finally {
        if (foreground.kind !== 'shell') this.opts.setForeground({ kind: 'shell' })
        this.opts.emit('recovery', {})
      }
      return
    }
    if (foreground.kind === 'shell') { this.opts.emit('action', { action, ...(long ? { long } : {}) }); return }
    if (foreground.kind === 'app') {
      if (action === 'home' || (action === 'back' && long)) {
        await this.opts.apps.close(); this.opts.setForeground({ kind: 'shell' })
      }
      return
    }
    if (this.opts.player.state().backend !== 'mpv') return
    const player = this.opts.player
    const settings = this.opts.playbackSettings()
    // OK and the side arrows do what they do on a real remote in mpv (see input.conf), so phone and CEC remotes match.
    if (action === 'playPause' || action === 'select') await player.command({ kind: 'togglePause' })
    if (action === 'rewind' || action === 'left') await player.command({ kind: 'seekRelative', seconds: -settings.skipBackSec })
    if (action === 'fastForward' || action === 'right') await player.command({ kind: 'seekRelative', seconds: settings.skipForwardSec })
    if (['stop', 'back', 'home'].includes(action)) {
      await player.stop(); this.opts.setForeground({ kind: 'shell' })
    }
  }
}
