import * as fs from 'node:fs/promises'
import type { SystemServices } from '../SystemServices'
import type { AudioSink, BtDevice, CecStatus, DisplayOutput, NetStatus, Result, WifiAp } from '@shared/system-types'
import { runtime, type Runtime } from '../../core/runtime'
import { silentLog, type Log } from '../../log/Logger'
import { collectDiagnostics } from '../diagnostics'
import type { FileSystem } from '../../settings/atomic'
import { NetQueue } from '../net/NetQueue'
import { IpTrial } from '../net/IpTrial'
import { memoryJournal } from '../net/MemoryJournal'
import { MockTrialBackend } from './MockTrialBackend'

export interface MockSystemOptions {
  scenario?: 'default' | 'offline' | 'noCec' | 'wifiOnly' | 'netUnmanaged'
  delayMs?: number
  clock?: Runtime
  logDir?: string
  logger?: Log
  fs?: FileSystem
  journalPath?: string
  trialSec?: number
}
const ok: Result = { ok: true }

export function createMockSystem(opts: MockSystemOptions = {}): SystemServices & { dispose(): void } {
  const clock = opts.clock ?? runtime
  const log = opts.logger ?? silentLog
  const io = opts.fs ?? fs
  const networkListeners = new Set<() => void>()
  const bluetoothListeners = new Set<() => void>()
  const waiting = new Map<ReturnType<typeof setTimeout>, () => void>()
  const wait = (ms = opts.delayMs ?? 350): Promise<void> => ms <= 0 ? Promise.resolve() : new Promise((resolve) => {
    const done = () => { waiting.delete(timer); resolve() }
    const timer = clock.setTimeout(done, ms)
    waiting.set(timer, done)
  })
  const changed = (listeners: Set<() => void>) => { for (const cb of listeners) cb() }
  const subscribe = (listeners: Set<() => void>, cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
  let network: NetStatus = opts.scenario === 'offline' || opts.scenario === 'wifiOnly'
    ? { connected: false, kind: 'none', internet: false }
    : { connected: true, kind: 'ethernet', ip: '192.168.1.42', gateway: '192.168.1.1',
      dns: ['192.168.1.1'], mac: '02:4D:45:44:49:41', internet: true, method: 'auto', prefix: 24, profileId: 'wired' }
  const wifi: WifiAp[] = [
    { id: 'home', ssid: 'Home Wi-Fi', signal: 93, secure: true, known: true, active: false },
    { id: 'garden', ssid: 'Garden office', signal: 74, secure: true, known: false, active: false },
    { id: 'guest', ssid: 'Home guest', signal: 68, secure: true, known: false, active: false },
    { id: 'neighbour', ssid: 'BT-7H42', signal: 38, secure: true, known: false, active: false },
    { id: 'public', ssid: 'Community Wi-Fi', signal: 21, secure: false, known: false, active: false },
  ]
  const queue = new NetQueue()
  const backend = new MockTrialBackend({ wifi, status: () => network, setStatus: (status) => { network = status },
    changed: () => changed(networkListeners), wait, delayMs: opts.delayMs, unmanaged: opts.scenario === 'netUnmanaged' })
  const trial = new IpTrial({ backend, queue, clock, fs: opts.journalPath ? io : memoryJournal(),
    journalPath: opts.journalPath ?? 'net-trial.json', logger: log, trialSec: opts.trialSec })
  const sinks: AudioSink[] = [
    { id: 'hdmi', name: 'Living room TV', kind: 'hdmi', active: true },
    { id: 'headphones', name: 'Headphone jack', kind: 'analog', active: false },
    { id: 'speaker', name: 'Kitchen speaker', kind: 'bluetooth', active: false },
  ]
  let volume = 65
  let channels = 'stereo'
  const modes = [
    { id: '1080p60', width: 1920, height: 1080, refresh: 60 }, { id: '1080p50', width: 1920, height: 1080, refresh: 50 },
    { id: '720p60', width: 1280, height: 720, refresh: 60 }, { id: '2160p30', width: 3840, height: 2160, refresh: 30 },
  ]
  const displays: DisplayOutput[] = [{ id: 'HDMI-A-1', name: 'Living Room TV', connected: true,
    current: modes[0], modes, scale: 1 }]
  let screenOn = true
  const devices: BtDevice[] = [{ address: 'AA:BB:CC:00:00:01', name: 'Living room remote', kind: 'remote',
    paired: true, connected: true, battery: 82 }]
  const controller: BtDevice = { address: 'AA:BB:CC:00:00:02', name: 'Wireless game controller', kind: 'gamepad',
    paired: false, connected: false, battery: 70 }
  let scanning = false
  // CecStatus has no message member yet; the UI can read this extra field until the shared contract grows it.
  const cec: CecStatus & { message?: string } = opts.scenario === 'noCec'
    ? { adapter: false, message: "No TV remote adapter found. Plug in a USB-CEC adapter, or use a keyboard or phone remote." }
    : { adapter: true, adapterName: 'Pulse-Eight USB-CEC', tvName: 'Living Room TV', tvPower: 'on', physicalAddress: '1.0.0.0' }
  let timezone = 'Europe/London'
  const zones = ['Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York',
    'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney']
  const fail = (error: string): Result => ({ ok: false, error })
  const system: SystemServices & { dispose(): void } = {
    network: {
      status: async () => structuredClone(network),
      scanWifi: async () => { await wait(); return structuredClone(wifi) },
      connect: (ssid, psk) => queue.run(async () => {
        await wait()
        if (psk === 'wrongpass') return fail("That Wi-Fi password didn't work. Check it and try again.")
        const ap = wifi.find((a) => a.ssid === ssid)
        if (!ap) return fail("Can't find that Wi-Fi network. Scan again and choose a network.")
        wifi.forEach((a) => { a.active = a === ap })
        ap.known = true
        network = { connected: true, kind: 'wifi', ssid, signal: ap.signal, ip: '192.168.1.43',
          gateway: '192.168.1.1', dns: ['192.168.1.1'], internet: opts.scenario !== 'offline',
          method: 'auto', prefix: 24, profileId: `wifi:${ap.id}` }
        return backend.activate(`wifi:${ap.id}`)
      }),
      forget: (id) => queue.run(async () => {
        const ap = wifi.find((a) => a.id === id)
        if (ap) {
          ap.known = false
          if (ap.active) { network = { connected: false, kind: 'none', internet: false }; ap.active = false }
          changed(networkListeners)
        }
        return ok
      }),
      profiles: () => queue.run(() => backend.profiles()),
      applyIp: (id, cfg) => trial.apply(id, cfg),
      trial: () => trial.trial(),
      keep: () => trial.keep(),
      revert: () => trial.revert(),
      resetAll: () => trial.resetAll(),
      recoverPending: () => trial.recoverPending(),
      on: (event, cb) => event === 'trial' ? trial.on('trial', cb) : subscribe(networkListeners, cb),
      onToast: (cb) => trial.onToast(cb),
    },
    audio: {
      outputs: async () => structuredClone(sinks),
      setOutput: async (id) => {
        if (!sinks.some((s) => s.id === id)) return fail("That sound output isn't connected. Choose another output.")
        sinks.forEach((s) => { s.active = s.id === id }); return ok
      },
      volume: async () => volume,
      setVolume: async (pct) => { volume = Math.round(Math.max(0, Math.min(100, pct))); return ok },
      setChannels: async (layout) => { channels = layout; return ok },
      testTone: async () => { log.info('Mock sound check', channels); return ok },
    },
    display: {
      outputs: async () => structuredClone(displays),
      setMode: async (output, mode) => {
        const display = displays.find((d) => d.id === output)
        const chosen = display?.modes.find((m) => m.id === mode)
        if (!display || !chosen) return fail("That picture setting isn't available. Choose another setting.")
        display.current = chosen; return ok
      },
      setScale: async (output, scale) => {
        const display = displays.find((d) => d.id === output)
        if (!display) return fail("That screen isn't connected. Choose another screen.")
        display.scale = scale; return ok
      },
      power: async (on) => { screenOn = on; return ok },
    },
    bluetooth: {
      devices: async () => structuredClone(devices),
      startScan: async () => {
        scanning = true; await wait()
        if (scanning && !devices.some((d) => d.address === controller.address)) devices.push(structuredClone(controller))
        changed(bluetoothListeners); return ok
      },
      stopScan: async () => { scanning = false; changed(bluetoothListeners); return ok },
      pair: async (address) => {
        await wait(opts.delayMs ?? 1500)
        const device = devices.find((d) => d.address === address)
        if (!device) return fail("Can't find that Bluetooth device. Put it in pairing mode and scan again.")
        device.paired = true; device.connected = true; changed(bluetoothListeners); return ok
      },
      remove: async (address) => {
        const index = devices.findIndex((d) => d.address === address)
        if (index !== -1) devices.splice(index, 1)
        changed(bluetoothListeners); return ok
      },
      on: (_event, cb) => subscribe(bluetoothListeners, cb),
    },
    cec: {
      status: async () => structuredClone(cec),
      wakeTv: async () => { if (cec.adapter) cec.tvPower = 'on'; return ok },
      standbyTv: async () => { if (cec.adapter) cec.tvPower = 'standby'; return ok },
      setActiveSource: async () => ok,
    },
    power: {
      reboot: async () => { log.info('Mock reboot requested'); return ok },
      powerOff: async () => { log.info('Mock power off requested'); return ok },
    },
    time: {
      get: async () => ({ iso: new Date(clock.now()).toISOString(), timezone, ntp: true }),
      setTimezone: async (zone) => {
        try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); timezone = zone; return ok }
        catch { return fail("That time zone isn't recognised. Choose one from the list.") }
      },
      zones: async () => [...zones],
    },
    updates: {
      check: async () => ({ current: '0.1.0', checkedAt: new Date(clock.now()).toISOString() }),
      apply: async () => ok,
    },
    info: {
      get: async () => ({ deviceName: 'MediaOS', version: '0.1.0', os: 'Debian 13 (mock)', kernel: '6.12.0',
        cpu: 'Intel N100', memoryMb: 8192, uptimeSec: 3600, platform: 'mock', ip: network.ip, storage: { totalGb: 256, freeGb: 203 } }),
      collectDiagnostics: () => collectDiagnostics({ logDir: opts.logDir, now: () => clock.now(),
        info: () => system.info.get(), screenOn, fs: io }),
    },
    dispose: () => {
      trial.dispose()
      networkListeners.clear(); bluetoothListeners.clear()
      for (const [timer, done] of waiting) { clock.clearTimeout(timer); done() }
    },
  }
  return system
}
