// OS integration. `linux/*` (Phase 2) shells out via CommandRunner; `mock/*` is used on Windows and in tests.
import type {
  AudioSink, BtDevice, CecStatus, DisplayOutput, IpConfig, NetProfile, NetStatus, NetTrial, Result, SysInfo, TimeInfo,
  UpdateInfo, WifiAp,
} from '@shared/system-types'

import type { FolderAddResult, FolderList, FoundComputer, ShareAdd, ShareLogin } from '@shared/folder-types'

export type Unsub = () => void
export interface FolderRoot {
  id: string; name: string; kind: 'share' | 'usb'; path: string; available: boolean; server?: string
}

export interface SystemServices {
  folders: {
    list(): Promise<FolderList>
    roots(): Promise<FolderRoot[]>
    discover(): Promise<FoundComputer[]>
    listShares(login: ShareLogin): Promise<string[]>
    add(req: ShareAdd): Promise<FolderAddResult>
    remove(id: string): Promise<Result>
    retry(id: string): Promise<Result>
    on(ev: 'changed', cb: () => void): Unsub
  }
  network: {
    status(): Promise<NetStatus>
    scanWifi(): Promise<WifiAp[]>
    connect(ssid: string, psk?: string): Promise<Result>
    forget(id: string): Promise<Result>
    /** Saved wired and Wi-Fi profiles with their IP settings (docs/design/network.md section 3). */
    profiles(): Promise<NetProfile[]>
    /** Starts a trial. The old settings return unless keep() is called before the countdown ends. Refused while a trial runs. */
    applyIp(profileId: string, config: IpConfig): Promise<Result>
    trial(): Promise<NetTrial | null>
    keep(): Promise<Result>
    revert(): Promise<Result>
    /** Ends any trial, then every ethernet and Wi-Fi profile goes to Automatic with automatic DNS. */
    resetAll(): Promise<Result>
    /** Awaited once at start-up before Core is built; finishes or undoes a trial left by a crash. Returns notices. */
    recoverPending(): Promise<string[]>
    /** 'trial' fires when a trial starts, ticks, its checks change, or it ends. */
    on(ev: 'changed' | 'trial', cb: () => void): Unsub
    onToast(cb: (toast: { text: string; tone: 'info' | 'warn' | 'ok' | 'error' }) => void): Unsub
  }
  audio: {
    outputs(): Promise<AudioSink[]>
    setOutput(id: string): Promise<Result>
    volume(): Promise<number>
    setVolume(pct: number): Promise<Result>
    setChannels(layout: 'stereo' | '5.1' | '7.1'): Promise<Result>
    testTone(): Promise<Result>
  }
  display: {
    outputs(): Promise<DisplayOutput[]>
    setMode(output: string, modeId: string): Promise<Result>
    setScale(output: string, scale: number): Promise<Result>
    power(on: boolean): Promise<Result>
  }
  bluetooth: {
    devices(): Promise<BtDevice[]>
    startScan(): Promise<Result>
    stopScan(): Promise<Result>
    pair(address: string): Promise<Result>
    remove(address: string): Promise<Result>
    on(ev: 'changed', cb: () => void): Unsub
  }
  cec: {
    status(): Promise<CecStatus>
    wakeTv(): Promise<Result>
    standbyTv(): Promise<Result>
    setActiveSource(): Promise<Result>
  }
  power: { reboot(): Promise<Result>; powerOff(): Promise<Result> }
  time: { get(): Promise<TimeInfo>; setTimezone(tz: string): Promise<Result>; zones(): Promise<string[]> }
  updates: {
    status(): Promise<UpdateInfo>
    check(): Promise<UpdateInfo>
    apply(): Promise<Result>
    rollback(): Promise<Result>
    auto(): Promise<Result>
    on(ev: 'changed', cb: () => void): Unsub
  }
  info: { get(): Promise<SysInfo>; collectDiagnostics(): Promise<string> }
}
