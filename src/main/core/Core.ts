import type { CallArgs, CallName, CallResults, EventName, EventPayloads, Foreground } from '@shared/ipc-contract'
import type { PlayerState } from '@shared/player-types'
import type { Result } from '@shared/system-types'
import { randomUUID } from 'node:crypto'
import { APP_CATALOG, findApp } from '../apps/app-catalog'
import type { AppHost } from '../apps/types'
import type { MediaHub } from '../hub/MediaHub'
import type { SettingsStore } from '../settings/SettingsStore'
import type { SecretStore } from '../settings/SecretStore'
import type { PlayerController } from '../player/types'
import type { SystemServices } from '../system/SystemServices'
import type { SignInService } from '../signin/types'
import { SourceError } from '../sources/MediaSource'
import { MAX_SOURCES, SOURCE_LIMIT_MESSAGE } from '../sources/limits'
import type { Log } from '../log/Logger'
import type { WeatherService } from '../weather/WeatherService'
import { runtime, type Runtime } from './runtime'
import { UpdateScheduler } from './UpdateScheduler'

export interface CoreOptions {
  hub: MediaHub; settings: SettingsStore; secrets: SecretStore; player: PlayerController
  apps: AppHost; system: SystemServices; signin: SignInService; logger: Log
  restartShell: () => void; clearCaches: () => Promise<void>
  clearProfiles?: () => Promise<void>; clearLogs?: () => Promise<void>
  notices?: string[]
  bootOnce?: (key: string) => Promise<boolean>
  timers?: Runtime
  /** Enabled by the Linux composition; mock mode does not install overnight. */
  overnightUpdates?: boolean
  /** Weather beside the clock; without it the chip stays hidden. */
  weather?: Pick<WeatherService, 'search' | 'current'>
}
type Handlers = { [N in CallName]: (...args: CallArgs<N>) => Promise<CallResults[N]> }
const ok: Result = { ok: true }

export class Core {
  readonly hub: MediaHub
  readonly settings: SettingsStore
  readonly secrets: SecretStore
  readonly player: PlayerController
  readonly apps: AppHost
  readonly system: SystemServices
  readonly signin: SignInService
  readonly logger: Log
  private foreground: Foreground = { kind: 'shell' }
  private listeners = new Map<EventName, Set<(payload: never) => void>>()
  private unsubs: (() => void)[] = []
  private recovered: string[]
  private handlers: Handlers
  private trialSequence = 0
  private screenOff = false
  private screenOffCount = 0
  private waking: Promise<Result> | undefined
  private started = false
  private updateScheduler?: UpdateScheduler
  private standbyTimers = new Map<ReturnType<typeof setTimeout>, () => void>()
  idle = false

  constructor(private opts: CoreOptions) {
    this.hub = opts.hub; this.settings = opts.settings; this.secrets = opts.secrets; this.player = opts.player
    this.apps = opts.apps; this.system = opts.system; this.signin = opts.signin; this.logger = opts.logger
    this.recovered = [this.settings.recoveredFrom, this.secrets.recoveredFrom].filter((s): s is string => !!s)
    this.recovered.push(...(opts.notices ?? []))
    this.unsubs.push(this.hub.onChanged(() => this.emit('homeChanged', {})),
      this.player.onState((state) => this.playerChanged(state)),
      this.apps.onExit((appId, reason) => {
        this.setForeground({ kind: 'shell' })
        if (reason === 'handover') this.emit('toast', { id: randomUUID(), tone: 'error',
          text: `${findApp(appId)?.name ?? 'The app'} didn't open properly. Try again.` })
      }),
      this.system.network.on('changed', () => this.emit('system', { what: 'network' })),
      this.system.network.on('trial', () => {
        const sequence = ++this.trialSequence
        void this.system.network.trial().then((trial) => {
          if (sequence === this.trialSequence) this.emit('netTrial', { trial })
        }).catch((error: unknown) => this.logger.warn('Network trial update failed', error))
      }),
      this.system.network.onToast((t) => this.emit('toast', { id: randomUUID(), text: t.text, tone: t.tone })),
      this.system.bluetooth.on('changed', () => this.emit('system', { what: 'bluetooth' })),
      this.system.folders.on('changed', () => this.emit('system', { what: 'folders' })),
      this.system.updates.on('changed', () => this.emit('system', { what: 'updates' })))
    this.handlers = this.makeHandlers()
    if (opts.overnightUpdates) this.updateScheduler = new UpdateScheduler({
      settings: () => this.settings.get(), system: this.system, logger: this.logger, timers: opts.timers,
      state: () => ({ idle: this.idle, screenOff: this.screenOff,
        shell: this.foreground.kind === 'shell' && ['idle', 'ended', 'error'].includes(this.player.state().status) }),
    })
  }
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      if (this.settings.get().cec.wakeTvOnStart && await (this.opts.bootOnce?.('tv-woken') ?? true)) await this.wakeTv()
    } catch (error) { this.logger.warn('TV wake at start-up failed', error) }
  }
  private async wakeTv(): Promise<void> {
    try {
      const result = await this.system.cec.wakeTv()
      if (!result.ok) {
        if (result.error === 'No TV remote adapter is connected.') this.logger.debug('TV could not be woken', result.error)
        else this.logger.warn('TV could not be woken', result.error)
      }
    } catch (error) { this.logger.warn('TV could not be woken', error) }
  }
  private async standbyTv(): Promise<void> {
    if (!this.settings.get().cec.standbyTvOnPowerOff) return
    const timers = this.opts.timers ?? runtime
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = async () => {
        const result = await this.system.cec.standbyTv()
        if (!result.ok) this.logger.warn('TV could not be put on standby', result.error)
      }
      await Promise.race([work(), new Promise<void>((resolve) => {
        timer = timers.setTimeout(() => {
          this.logger.warn('TV standby timed out'); resolve()
        }, 3000)
        this.standbyTimers.set(timer, resolve)
      })])
    } catch (error) { this.logger.warn('TV could not be put on standby', error) }
    finally {
      if (timer !== undefined) { timers.clearTimeout(timer); this.standbyTimers.delete(timer) }
    }
  }
  on<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners) }
    const listener = cb as (payload: never) => void
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try { cb(structuredClone(payload) as never) } catch (error) { this.logger.error('Event listener failed', error) }
    }
  }
  getForeground(): Foreground { return { ...this.foreground } }
  setForeground(value: Foreground): void {
    if (JSON.stringify(value) === JSON.stringify(this.foreground)) return
    this.foreground = { ...value }; this.emit('foreground', value)
  }
  private playerChanged(state: PlayerState): void {
    this.emit('player', state)
    if (['idle', 'ended', 'error'].includes(state.status) && this.foreground.kind === 'player') {
      this.setForeground({ kind: 'shell' }); this.hub.invalidate()
    }
    if (['playing', 'loading'].includes(state.status) && this.foreground.kind !== 'app') this.setForeground({ kind: 'player' })
  }
  async dispatch<N extends CallName>(name: N, args: unknown[]): Promise<CallResults[N]> {
    // The IPC boundary validates arguments; this assertion preserves the correlation in the mapped handler table.
    const handler = this.handlers[name] as (...args: unknown[]) => Promise<CallResults[N]>
    return handler(...args)
  }
  /** Switches the screen back on after MediaOS switched it off. Every button press calls this; it does nothing otherwise. */
  wakeScreen(): Promise<Result> {
    if (!this.screenOff) return Promise.resolve(ok)
    const offAt = this.screenOffCount
    this.waking ??= this.system.display.power(true).then((result) => {
      // A screen-off that arrived while this was running wins; the next press wakes it again.
      if (result.ok && offAt === this.screenOffCount) { this.screenOff = false; void this.wakeTv() }
      else if (!result.ok) this.logger.warn('The screen could not be switched back on', result.error)
      return result
    }, (error: unknown): Result => {
      this.logger.warn('The screen could not be switched back on', error)
      return { ok: false, error: "The screen couldn't be switched back on. Try the TV's power button." }
    }).finally(() => { this.waking = undefined })
    return this.waking
  }
  private async revertPendingTrial(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = async () => {
        if (await this.system.network.trial()) {
          const result = await this.system.network.revert()
          if (!result.ok) this.logger.warn('Network trial could not be reverted', result.error)
        }
      }
      await Promise.race([work(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Network revert timed out')), 10_000)
      })])
    } catch (error) { this.logger.warn('Network trial could not be reverted before leaving', error) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  private makeHandlers(): Handlers {
    const home = () => this.hub.home(this.settings.get().home)
    const system = this.system
    return {
      'home.get': home,
      'home.refresh': async () => { this.hub.refresh(); return home() },
      'sources.list': async () => this.hub.list(),
      'sources.remove': async (id) => {
        if (id === 'folders') throw new SourceError(
          "Folders can't be removed. Remove each network folder in Settings › Libraries instead.", 'unsupported')
        this.settings.update({ sources: this.settings.get().sources.filter((s) => s.id !== id),
          ...(id === 'demo' ? { demoRemoved: true } : {}) })
        this.hub.remove(id)
        try { await this.secrets.delete(id) } catch { this.logger.warn('Saved sign-in could not be deleted') }
        return ok
      },
      'sources.rename': async (id, name) => {
        const source = this.hub.get(id)
        if (!source) throw new SourceError("That library isn't connected any more.", 'notFound')
        if (source.kind === 'folders') throw new SourceError(
          "Folders can't be renamed. Each network folder keeps the name it was added with.", 'unsupported')
        const sources = this.settings.get().sources
        const old = sources.find((s) => s.id === id)
        if (!old && sources.length >= MAX_SOURCES) throw new SourceError(SOURCE_LIMIT_MESSAGE, 'unsupported')
        this.settings.update({ sources: old ? sources.map((s) => s.id === id ? { ...s, name } : s) :
          [...sources, { id, name, kind: source.kind, enabled: true }] })
        this.hub.rename(id, name); return ok
      },
      'libraries.list': () => this.hub.libraries(),
      'libraries.browse': (key, q) => this.hub.browse(key, q),
      'items.get': (key) => this.hub.item(key),
      'items.children': (key) => this.hub.children(key),
      'items.setWatched': async (key, watched) => { await this.hub.setWatched(key, watched); return ok },
      'items.setFavourite': async (key, favourite) => { await this.hub.setFavourite(key, favourite); return ok },
      'search.query': (text) => this.hub.search(text),
      'weather.search': async (text) => {
        if (!this.opts.weather) throw new SourceError("The weather isn't available on this box.", 'unsupported')
        return this.opts.weather.search(text)
      },
      'weather.get': async () => {
        const { enabled, place } = this.settings.get().weather
        if (!enabled || !place || !this.opts.weather) return null
        return this.opts.weather.current(place)
      },
      'jellyfin.discover': () => this.signin.discover(),
      'jellyfin.probe': (url) => this.signin.probe(url),
      'jellyfin.quickConnect': (url) => this.signin.quickConnect(url),
      'jellyfin.password': (url, user, pw) => this.signin.password(url, user, pw),
      'plex.pin': () => this.signin.plexPin(),
      'signin.poll': (id) => this.signin.poll(id),
      'signin.cancel': (id) => this.signin.cancel(id),
      'plex.addServers': (id, ids) => this.signin.plexAddServers(id, ids),
      'player.play': async (key, playOpts) => {
        const source = this.hub.sourceFor(key)
        const plan = await this.hub.playback(key, playOpts)
        await this.apps.close()
        this.setForeground({ kind: 'shell' })
        await this.player.play(plan, source)
        if (this.player.state().status !== 'error') this.setForeground({ kind: 'player' })
        return ok
      },
      'player.command': async (command) => { await this.player.command(command); return ok },
      'player.state': async () => this.player.state(),
      'apps.list': async () => {
        const { pinned } = this.settings.get().apps
        const rank = (id: string) => pinned.includes(id) ? pinned.indexOf(id) : pinned.length
        return [...APP_CATALOG].sort((a, b) => rank(a.id) - rank(b.id))
      },
      'apps.launch': async (id) => {
        const app = findApp(id)
        if (!app) throw new SourceError('That app could not be found. Choose another app.', 'notFound')
        await this.player.stop(); await this.apps.launch(app); this.setForeground({ kind: 'app', appId: id }); return ok
      },
      'apps.close': async () => { await this.apps.close(); this.setForeground({ kind: 'shell' }); return ok },
      'apps.resetProfile': async (id) => { await this.apps.resetProfile(id); return ok },
      'settings.get': async () => this.settings.get(),
      'settings.update': async (patch) => {
        const value = this.settings.update(patch)
        if (patch.sources) for (const source of value.sources) {
          this.hub.rename(source.id, source.name, false); this.hub.setEnabled(source.id, source.enabled, false)
        }
        if (patch.sources || patch.home) this.hub.invalidate()
        return value
      },
      'network.status': () => system.network.status(),
      'folders.list': () => system.folders.list(),
      'folders.discover': () => system.folders.discover(),
      'folders.listShares': (login) => system.folders.listShares(login),
      'folders.add': (req) => system.folders.add(req),
      'folders.remove': (id) => system.folders.remove(id),
      'folders.retry': (id) => system.folders.retry(id),
      'network.scan': () => system.network.scanWifi(),
      'network.connect': (ssid, psk) => system.network.connect(ssid, psk),
      'network.forget': (id) => system.network.forget(id),
      'network.profiles': () => system.network.profiles(),
      'network.applyIp': (id, cfg) => system.network.applyIp(id, cfg),
      'network.trial': () => system.network.trial(),
      'network.keep': () => system.network.keep(),
      'network.revert': () => system.network.revert(),
      'network.resetAll': () => system.network.resetAll(),
      'audio.outputs': () => system.audio.outputs(),
      'audio.setOutput': (id) => system.audio.setOutput(id),
      'audio.volume': () => system.audio.volume(),
      'audio.setVolume': (pct) => system.audio.setVolume(pct),
      'audio.setChannels': (layout) => system.audio.setChannels(layout),
      'audio.testTone': () => system.audio.testTone(),
      'display.outputs': () => system.display.outputs(),
      'display.setMode': (id, mode) => system.display.setMode(id, mode),
      'display.setScale': (id, scale) => system.display.setScale(id, scale),
      'bluetooth.devices': () => system.bluetooth.devices(),
      'bluetooth.scan': (on) => on ? system.bluetooth.startScan() : system.bluetooth.stopScan(),
      'bluetooth.pair': (id) => system.bluetooth.pair(id),
      'bluetooth.remove': (id) => system.bluetooth.remove(id),
      'cec.status': () => system.cec.status(),
      'cec.wakeTv': () => system.cec.wakeTv(),
      'cec.standbyTv': () => system.cec.standbyTv(),
      'power.reboot': async () => { await this.revertPendingTrial(); return system.power.reboot() },
      'power.powerOff': async () => {
        await this.revertPendingTrial(); await this.standbyTv(); return system.power.powerOff()
      },
      'power.screenOff': async () => {
        await this.revertPendingTrial()
        // Remembered even if the command reports a failure: the next button press then makes sure the screen is on.
        this.screenOff = true
        this.screenOffCount++
        const result = await system.display.power(false)
        if (result.ok) this.emit('toast', { id: randomUUID(), text: 'The screen is off. Press a button to return.', tone: 'info' })
        return result
      },
      'power.screenOn': () => this.wakeScreen(),
      'time.get': () => system.time.get(),
      'time.zones': () => system.time.zones(),
      'time.setTimezone': (tz) => system.time.setTimezone(tz),
      'updates.check': () => system.updates.check(),
      'updates.status': () => system.updates.status(),
      'updates.apply': async () => {
        await this.revertPendingTrial(); await this.settings.flush(); return system.updates.apply()
      },
      'updates.rollback': async () => {
        await this.revertPendingTrial(); await this.settings.flush(); return system.updates.rollback()
      },
      'info.get': () => system.info.get(),
      'info.diagnostics': async () => ({ path: await system.info.collectDiagnostics() }),
      'shell.restart': async () => {
        await this.revertPendingTrial(); await this.settings.flush(); this.opts.restartShell(); return ok
      },
      'shell.factoryReset': async (_confirmation) => {
        await this.revertPendingTrial()
        let eraseFailed = false
        const failed: string[] = []
        const step = async (name: string, action: () => Promise<void>, sensitive = false) => {
          try { await action() } catch {
            failed.push(name)
            if (sensitive) eraseFailed = true
          }
        }
        await step('sign-in flows', async () => { await this.signin.cancelAll() }, true)
        await step('sign-ins', () => this.secrets.erase(), true)
        await step('network', () => system.network.resetAll().then((r) => { if (!r.ok) throw new Error(r.error) }))
        await step('settings', () => this.settings.erase(), true)
        await step('player', () => this.player.stop())
        await step('apps', () => this.apps.close())
        await step('cache', this.opts.clearCaches)
        if (this.opts.clearProfiles) await step('profiles', this.opts.clearProfiles)
        if (this.opts.clearLogs) await step('logs', this.opts.clearLogs)
        if (failed.length) this.logger.error(`Factory reset incomplete: ${failed.join(', ')}`)
        if (eraseFailed) throw new SourceError("MediaOS couldn't erase everything. Restart the box and try again.", 'server')
        if (failed.includes('network')) {
          throw new SourceError("Everything else was erased, but the network settings couldn't be reset. " +
            'Hold Home, choose Reset network to automatic, then restart the box.', 'server')
        }
        this.opts.restartShell(); return ok
      },
      'shell.reportIdle': async (idle) => { this.idle = idle; return ok },
      // Pulled by the screen once it is listening, so a warning raised before the window loaded is not lost.
      'shell.notices': async () => {
        const notices = this.recovered.map((text) => ({ id: randomUUID(), text, tone: 'warn' as const }))
        this.recovered = []
        return notices
      },
    }
  }
  dispose(): void {
    this.updateScheduler?.dispose()
    ++this.trialSequence
    for (const [timer, resolve] of this.standbyTimers) { (this.opts.timers ?? runtime).clearTimeout(timer); resolve() }
    this.standbyTimers.clear()
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []; this.listeners.clear()
  }
}
