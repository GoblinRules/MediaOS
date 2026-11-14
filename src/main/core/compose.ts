import { VpnController, type VpnProxyHost } from '../vpn/VpnController'
import { MockVpnBackend, type VpnScenario } from '../vpn/mock/MockVpnBackend'
import { NmWireGuard } from '../vpn/linux/NmWireGuard'
import { ProxyHost } from '../vpn/ProxyHost'
import { NetQueue } from '../system/net/NetQueue'
import { APP_CATALOG, findApp } from '../apps/app-catalog'
import { basename, join, resolve, relative, isAbsolute } from 'node:path'
import * as fs from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { RemoteServer } from '../remote/RemoteServer'
import { VpnUpload } from '../remote/upload'
import { lanAddress, privateIpv4 } from '../remote/source-policy'
import { Core } from './Core'
import { SettingsStore } from '../settings/SettingsStore'
import { SecretStore } from '../settings/SecretStore'
import { Logger } from '../log/Logger'
import { MediaHub } from '../hub/MediaHub'
import { FixtureSource } from '../sources/fixture/FixtureSource'
import { DiskCache } from '../images/DiskCache'
import { ImageResolver } from '../images/ImageResolver'
import { AppIconStore } from '../apps/AppIconStore'
import { MockPlayer } from '../player/MockPlayer'
import { MpvController } from '../player/MpvController'
import { findMpv } from '../player/mpv/MpvProcess'
import { createLinuxNetwork, withRealIp } from '../system/linux/LinuxNetwork'
import { createLinuxSystem } from '../system/linux/LinuxSystem'
import { createMockSystem } from '../system/mock/MockSystemServices'
import { MockAppHost, type MockAppOptions } from '../apps/MockAppHost'
import { ChromeAppHost } from '../apps/ChromeAppHost'
import { LINUX_CHROME_ARGS } from '../apps/chrome'
import { procTable, type ProcessTable } from '../apps/orphans'
import type { AppHost } from '../apps/types'
import { ActionRouter } from './ActionRouter'
import { ControlCommands, ControlServer } from './ControlSocket'
import { MockSignInService } from '../signin/MockSignInService'
import { RealSignInService } from '../signin/RealSignInService'
import { JellyfinSource } from '../sources/jellyfin/JellyfinSource'
import { WeatherService } from '../weather/WeatherService'
import { PlexSource } from '../sources/plex/PlexSource'
import { randomUUID } from 'node:crypto'
import { runtime, type Runtime } from './runtime'
import type { Action } from '@shared/actions'
import { FolderSource } from '../sources/folders/FolderSource'
import { ProgressStore } from '../sources/folders/ProgressStore'
import { FindLister, FsLister } from '../sources/folders/listing'
import { NodeCommandRunner } from '../system/linux/CommandRunner'

export interface ComposeOptions {
  platform: 'linux' | 'mock'
  appVersion?: string
  realSystem?: string[]
  lan?: boolean
  dataDir: string
  logDir: string
  appIcons?: 'fetch' | 'off'
  mpvPath?: string
  forceMockPlayer?: boolean
  openAppWindow?: MockAppOptions['openWindow']
  restartShell: () => void
  fixtureLatencyMs?: number
  clock?: Runtime
  /** Injected transport for real media sources and sign-in. */
  fetch?: typeof fetch
  mockDelayMs?: number
  /** Tests only: shorten the network trial countdown. */
  netTrialSec?: number
  vpnImport?: string
  vpnScenario?: VpnScenario
  /** Linux only: where Chrome lives (default /usr/bin/google-chrome-stable). */
  chromePath?: string
  /** Linux only: the control socket sway's Home key talks to. */
  controlSocket?: string
  /** Linux only: play video without the graphics chip (virtual machines). */
  softwareVideo?: boolean
  /** Linux only: give the keyboard back to the shell window. */
  focusShell?: () => void
  /** Linux only: the process list used to find app windows left over from a crashed shell (tests pass a fake). */
  processes?: ProcessTable
}

/** mpv on the TV: it takes the remote's keys itself and hands the ones that matter back through `mediaos-key` messages. */
export function linuxMpvArgs(softwareVideo: boolean): string[] {
  return ['--input-vo-keyboard=yes', '--input-conf=/etc/mediaos/mpv/input.conf', ...(softwareVideo ? ['--hwdec=no'] : [])]
}

export async function composeCore(opts: ComposeOptions): Promise<{
  core: Core; images: ImageResolver; appIcons: AppIconStore; dispose(): Promise<void>
}> {
  const linux = opts.platform === 'linux'
  const logger = new Logger(opts.logDir, { dev: process.env.NODE_ENV === 'development' })
  const settings = await SettingsStore.open(join(opts.dataDir, 'settings.json'), { clock: opts.clock, logger })
  const secrets = await SecretStore.open(join(opts.dataDir, 'secrets.json'), fs, logger)
  const hub = new MediaHub({ logger: logger.child('hub'), clock: opts.clock })
  const configs = settings.get().sources
  const demo = configs.find((s) => s.id === 'demo')
  if (!settings.get().demoRemoved) {
    hub.add(new FixtureSource({ id: 'demo', name: demo?.name ?? 'Demo library', latencyMs: opts.fixtureLatencyMs }), demo?.enabled)
  }
  for (const source of configs.filter((s) => s.id !== 'demo' && s.kind === 'fixture')) {
    hub.add(new FixtureSource({ id: source.id, name: source.name, latencyMs: opts.fixtureLatencyMs }), source.enabled)
  }
  for (const source of configs.filter((s) => s.kind === 'jellyfin')) {
    const secret = secrets.get(source.id)
    hub.add(new JellyfinSource({ ...source, url: source.url ?? 'http://localhost:8096',
      serverId: source.serverId ?? '', userId: source.userId ?? '', token: secret?.token,
      deviceId: secret?.deviceId ?? randomUUID(), deviceName: settings.get().deviceName,
      appVersion: opts.appVersion ?? '0.1.0', clock: opts.clock, fetch: opts.fetch,
      logger: logger.child('jellyfin') }), source.enabled)
  }
  for (const source of configs.filter((s) => s.kind === 'plex')) {
    const secret = secrets.get(source.id)
    hub.add(new PlexSource({ ...source, serverId: source.serverId ?? '', userId: source.userId ?? '',
      token: secret?.token, accountToken: secret?.accountToken, clientId: secret?.clientId ?? randomUUID(),
      deviceName: settings.get().deviceName, appVersion: opts.appVersion ?? '0.1.0', clock: opts.clock, fetch: opts.fetch,
      logger: logger.child('plex'), onConnection: (url) => {
        const sources = settings.get().sources
        if (!sources.some((s) => s.id === source.id && s.url !== url)) return
        try {
          settings.update({ sources: sources.map((s) => s.id === source.id ? { ...s, url } : s) })
          void settings.flush().catch(() => logger.warn('Plex connection could not be saved'))
        } catch { logger.warn('Plex connection could not be saved') }
      } }), source.enabled)
  }
  const cache = new DiskCache(join(opts.dataDir, 'images'), { logger: logger.child('images') })
  const images = new ImageResolver(hub, cache, { logger: logger.child('images') })
  const appIcons = new AppIconStore(join(opts.dataDir, 'app-icons'), { mode: opts.appIcons,
    now: opts.clock ? () => opts.clock!.now() : undefined, logger: logger.child('app-icons') })
  const mpv = opts.forceMockPlayer ? undefined : await findMpv(opts.mpvPath) ?? await findMpv()
  const playerOptions = { clock: opts.clock, logger: logger.child('player'), autoPlayNext: () => settings.get().playback.autoPlayNext }
  // The router is made once core exists; mpv's keys arrive through it (and its Home also refocuses the shell).
  let routeKey: ((action: Action) => Promise<void>) | undefined
  const onKey = (key: Action): void => {
    void routeKey?.(key).catch((error: unknown) => logger.error(`The ${key} key could not be handled`, error))
  }
  const player = mpv
    ? new MpvController({ ...playerOptions, processOptions: { mpvPath: mpv, extraArgs: linux ? linuxMpvArgs(!!opts.softwareVideo) : [] },
      ...(linux ? { onKey } : {}) })
    : new MockPlayer(playerOptions)
  const chrome = linux
    ? new ChromeAppHost({ profileDir: join(opts.dataDir, 'chrome'), chromePath: opts.chromePath ?? '/usr/bin/google-chrome-stable',
      extraArgs: LINUX_CHROME_ARGS, clock: opts.clock, logger: logger.child('apps'),
      processes: opts.processes ?? procTable })
    : undefined
  // An app window left running by a shell that crashed would sit in front of this one; close it (launches wait for this).
  void chrome?.closeLeftovers()
  const apps: AppHost = chrome ?? new MockAppHost({ logger: logger.child('apps'),
    openWindow: opts.openAppWindow ?? (() => ({ close() {}, onClosed() {} })) })
  const mock = createMockSystem({ logger: logger.child('system'), logDir: opts.logDir, clock: opts.clock,
    delayMs: opts.mockDelayMs, journalPath: join(opts.dataDir, 'net-trial.json'), trialSec: opts.netTrialSec,
    foldersDir: join(opts.dataDir, 'mock-folders') })
  const netQueue = new NetQueue()
  const net = linux && opts.realSystem?.includes('network')
    ? createLinuxNetwork({ logger: logger.child('network'), journal: join(opts.dataDir, 'net-trial.json'),
      clock: opts.clock, trialSec: opts.netTrialSec, queue: netQueue }) : undefined
  const linuxSystem = linux ? createLinuxSystem({ logger: logger.child('system'), logDir: opts.logDir,
    clock: opts.clock, timers: opts.clock, fetch: opts.fetch,
    appVersion: opts.appVersion ?? '0.1.0', deviceName: () => settings.get().deviceName }) : undefined
  const system = linuxSystem ? { ...linuxSystem, network: net ?? mock.network,
    info: net ? withRealIp(linuxSystem.info, net) : linuxSystem.info,
    dispose() { net?.dispose(); linuxSystem.dispose(); mock.dispose() } } : mock
  const progress = await ProgressStore.open(join(opts.dataDir, 'folders-progress.json'), { clock: opts.clock, logger })
  hub.add(new FolderSource({ id: 'folders', name: 'Folders', roots: () => system.folders.roots(),
    retry: (id) => system.folders.retry(id), store: progress, clock: opts.clock, logger: logger.child('folders'),
    lister: linux ? new FindLister(new NodeCommandRunner(logger), logger) : new FsLister(logger) }))
  const foldersChanged = system.folders.on('changed', () => hub.invalidate())
  const signin = opts.realSystem?.includes('sources')
    ? new RealSignInService({ hub, settings, secrets, logger: logger.child('signin'), clock: opts.clock,
      sourceLogger: (kind) => logger.child(kind), appVersion: opts.appVersion ?? '0.1.0', fetch: opts.fetch })
    : new MockSignInService(hub, settings, { clock: opts.clock, delayMs: opts.mockDelayMs,
      fixtureLatencyMs: opts.fixtureLatencyMs })
  let notices: string[] = []
  try { notices = await system.network.recoverPending() }
  catch (error) { logger.warn('Network recovery failed at start-up', error) }
  const weather = new WeatherService({ fetch: opts.fetch, logger: logger.child('weather'),
    now: opts.clock ? () => opts.clock!.now() : undefined })
  const realVpn = linux && opts.realSystem?.includes('vpn')
  let mockProxyPort: number | null = null
  const mockPortListeners = new Set<(port: number | null) => void>()
  const mockPort = (port: number | null): void => { mockProxyPort = port; for (const cb of mockPortListeners) cb(port) }
  const proxy: VpnProxyHost = realVpn ? new ProxyHost({ scriptPath: join(__dirname, 'vpn-proxy.js'),
    runtimeDir: process.env.XDG_RUNTIME_DIR ?? null, uid: process.getuid?.() ?? null, clock: opts.clock,
    logger: logger.child('vpn-proxy') }) : {
    async start() { mockPort(1080) }, async stop() { mockPort(null) }, port: () => mockProxyPort,
    onPort(cb) { mockPortListeners.add(cb); return () => { mockPortListeners.delete(cb) } }, setTunnel() {},
  }
  const backend = realVpn ? new NmWireGuard({ runner: new NodeCommandRunner(logger.child('vpn')),
    queue: net ? netQueue : new NetQueue(), runtimeDir: process.env.XDG_RUNTIME_DIR ?? null }) :
    new MockVpnBackend({ scenario: opts.vpnScenario, delayMs: opts.mockDelayMs, clock: opts.clock })
  const remote = new RemoteServer({ port: () => settings.get().remote.port, logger: logger.child('remote'),
    now: opts.clock ? () => opts.clock!.now() : undefined,
    bindHost: async () => {
      if (opts.realSystem?.includes('network')) {
        const ip = (await system.network.status()).ip
        return ip && privateIpv4(ip) ? ip : null
      }
      return opts.lan ? lanAddress(networkInterfaces()) : '127.0.0.1'
    } })
  const upload: VpnUpload = new VpnUpload(remote, {
    receiveFile: (name, data, code) => vpn.receiveFile(name, data, code),
    uploadTooLarge: (code) => vpn.uploadTooLarge(code),
  }, { clock: opts.clock, logger: logger.child('upload') })
  const vpn: VpnController = new VpnController({ backend, settings, proxy, upload, clock: opts.clock ?? runtime, logger: logger.child('vpn'),
    networkBusy: async () => !!await system.network.trial(),
    closeApp: async () => { await apps.close(); core.setForeground({ kind: 'shell' }) }, runningApp: () => apps.running(),
    appIds: () => APP_CATALOG.map((a) => a.id), appName: (id) => findApp(id)?.name ?? 'The app',
    isLockedDirect: (id) => findApp(id)?.vpn?.lock === 'direct',
    emitStatus: (status) => core.emit('vpn', { status }), emitDropped: (appId) => core.emit('vpnDropped', { appId }),
    toast: (text, tone) => core.emit('toast', { id: randomUUID(), text, tone }),
    devImport: opts.vpnImport ? async () => {
      const handle = await fs.open(opts.vpnImport!, 'r')
      try {
        const data = Buffer.alloc(65537)
        let length = 0
        while (length < data.length) {
          const read = await handle.read(data, length, data.length - length, null)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        return { name: basename(opts.vpnImport!), data: data.subarray(0, length) }
      } finally { await handle.close() }
    } : undefined,
  })
  const core = new Core({ hub, settings, secrets, player, apps, vpn, system, signin, logger, notices, weather,
    timers: opts.clock, overnightUpdates: linux,
    bootOnce: linux ? async (key) => {
      try {
        await fs.writeFile(join(process.env.XDG_RUNTIME_DIR || tmpdir(), `mediaos-${key}`), '', { flag: 'wx', mode: 0o600 })
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
        logger.warn('Boot marker could not be saved', error)
        return true
      }
    } : undefined,
    restartShell: opts.restartShell, clearCaches: () => cache.clear(), clearLogs: () => logger.clearFiles(),
    clearProfiles: async () => {
      const root = resolve(opts.dataDir)
      const profiles = resolve(root, 'chrome')
      const rel = relative(root, profiles)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Profiles must be inside the data folder')
      await fs.rm(profiles, { force: true, recursive: true })
    } })
  void core.start()
  let control: { server: ControlServer; commands: ControlCommands } | undefined
  if (linux) {
    const linuxRouter = new ActionRouter({ foreground: () => core.getForeground(), setForeground: (f) => core.setForeground(f),
      player, apps, playbackSettings: () => settings.get().playback, emit: (event, value) => core.emit(event, value) })
    const focusShell = opts.focusShell
    if (focusShell) core.on('foreground', (f) => { if (f.kind === 'shell') focusShell() })
    const route = async (action: Action, long = false): Promise<void> => {
      // Any button wakes a screen MediaOS switched off, even while an app or video has the keys.
      await core.wakeScreen()
      try { await linuxRouter.route(action, long) } finally {
        // Home and Recovery always end on the shell. Say so to sway even when core already thought the shell was in front
        // (a stray window may have the keyboard), not only when the foreground changes.
        if (focusShell && (action === 'home' || action === 'recovery')) focusShell()
      }
    }
    routeKey = route
    if (opts.controlSocket) {
      const commands = new ControlCommands(route, logger.child('control'))
      const server = new ControlServer({ path: opts.controlSocket, onCommand: (c) => commands.handle(c), logger: logger.child('control') })
      try { await server.listen() } catch (error) { logger.error('The Home key will not work: control socket unavailable', error) }
      control = { server, commands }
    }
  }
  let disposed = false
  return { core, images, appIcons, dispose: async () => {
    if (disposed) return
    disposed = true
    vpn.dispose()
    remote.dispose()
    try {
      await proxy.stop()
      await appIcons.dispose()
      control?.commands.dispose(); await control?.server.close(); await player.dispose(); await progress.flush()
      await apps.close(); await settings.flush()
    }
    finally { foldersChanged(); weather.dispose(); core.dispose(); signin.dispose(); system.dispose(); hub.dispose(); await logger.close() }
  } }
}
