import type { AppRoute } from '../shared/vpn-types'
// Composition root: opens the TV window, locks it down, and connects it to the core services.
// Everything here is thin Electron glue; the logic lives in core/ and is unit-tested without Electron.
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron'
import { keyToAction } from '@shared/actions'
import { CALL_CHANNEL, EVENT_CHANNEL, EVENT_SCHEMAS, type EventName, type EventPayloads } from '@shared/ipc-contract'
import { KeyTiming } from '@shared/key-timing'
import type { AppEntry } from '@shared/apps'
import { composeCore } from './core/compose'
import { handleCall } from './core/ipc'
import { registerImageProtocol } from './images/electron'
import { mockAppPage, readLaunchOptions } from './launch-options'
import type { MockWindow } from './apps/MockAppHost'
import { focusProcess } from './system/linux/sway'

const opts = readLaunchOptions(process.env, process.argv)
if (opts.dataDir) app.setPath('userData', opts.dataDir)

// Must happen before 'ready': artwork is served through mediaos-img:// so server tokens never reach the page.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mediaos-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

let shellWindow: BrowserWindow | undefined
let shutdown: (() => Promise<void>) | undefined
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!shellWindow) return
    if (shellWindow.isMinimized()) shellWindow.restore()
    shellWindow.focus()
  })
  app.whenReady().then(start).catch((err: unknown) => fatal(err))
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)
  lockDownSessions()
  const dataDir = app.getPath('userData')
  const composed = await composeCore({
    appVersion: app.getVersion(),
    platform: opts.platform,
    realSystem: opts.realSystem,
    lan: opts.lan,
    dataDir,
    logDir: join(dataDir, 'logs'),
    appIcons: opts.appIcons,
    mpvPath: opts.mpvPath,
    forceMockPlayer: opts.forceMockPlayer,
    netTrialSec: opts.netTrialSec,
    vpnImport: app.isPackaged ? undefined : opts.vpnImport,
    vpnScenario: app.isPackaged ? undefined : opts.vpnScenario,
    openAppWindow: openMockApp,
    restartShell,
    chromePath: opts.chromePath,
    controlSocket: opts.controlSocket,
    softwareVideo: opts.softwareVideo,
    focusShell: () => void focusProcess(process.pid),
  })
  const { core, images, appIcons } = composed
  shutdown = composed.dispose
  registerImageProtocol((scheme, handler) => protocol.handle(scheme, handler), images, appIcons)

  const win = createShellWindow()
  shellWindow = win
  ipcMain.handle(CALL_CHANNEL, (event, name: unknown, args: unknown) => {
    // Only the shell page may call the core (never an app window or a stray frame).
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      return { ok: false, error: 'Not allowed.' }
    }
    return handleCall(core, name, args)
  })
  for (const name of Object.keys(EVENT_SCHEMAS) as EventName[]) {
    core.on(name, (payload) => {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { event: name, payload })
    })
  }
  win.on('closed', () => {
    shellWindow = undefined
    app.quit()
  })
  core.logger.info(`MediaOS ${app.getVersion()} started (${opts.platform})`)
}

function createShellWindow(): BrowserWindow {
  const win = newWindow({
    title: 'MediaOS',
    backgroundColor: '#0b0d12',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--mediaos-platform=${opts.platform}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })
  blockNavigation(win.webContents)
  win.once('ready-to-show', () => reveal(win))
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  if (opts.devTools && !app.isPackaged) win.webContents.openDevTools({ mode: 'detach' })
  return win
}

/**
 * A window in the usual place: full screen, or a fixed size for screenshots. For automated tests
 * (MEDIAOS_BACKGROUND=1) it opens off the visible screen and off the taskbar instead, at the size full screen would
 * be, so a test run never pops up over what the person at the PC is working on.
 */
function newWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const common = { ...options, useContentSize: true, autoHideMenuBar: true }
  if (!opts.background) {
    return new BrowserWindow({ ...common, ...(opts.window ?? { width: 1920, height: 1080 }), fullscreen: !opts.window })
  }
  // The size full screen would have on the monitor nearest the window (the one the page reports as its screen).
  const size = opts.window ?? screen.getDisplayNearestPoint({ x: OFF_SCREEN, y: OFF_SCREEN }).size
  const win = new BrowserWindow({
    ...common,
    ...size,
    x: OFF_SCREEN,
    y: OFF_SCREEN,
    frame: false,
    thickFrame: false,
    skipTaskbar: true,
    // Off-screen windows count as hidden, which would pause animation frames and timers.
    webPreferences: { ...options.webPreferences, backgroundThrottling: false },
  })
  // Windows trims a new window to fit above the taskbar; setting the size again afterwards is not trimmed.
  win.setContentBounds({ x: OFF_SCREEN, y: OFF_SCREEN, ...size })
  return win
}

const OFF_SCREEN = -20_000

/** Show a window and give it the keyboard; test windows are shown without taking focus from other programs. */
function reveal(win: BrowserWindow): void {
  if (opts.background) {
    win.showInactive()
    return
  }
  win.show()
  win.focus()
}

/** The page can never leave the shell, open pop-ups or attach webviews. */
function blockNavigation(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) event.preventDefault()
  })
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** No camera, microphone, notifications or other permission prompts for any page. */
function lockDownSessions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

/** Tell the shell page about an action, the same way core forwards remote presses to it. */
function sendToShell(event: 'action' | 'recovery', payload: EventPayloads['action'] | EventPayloads['recovery']): void {
  const win = shellWindow
  if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { event, payload })
}

/**
 * On Windows (mock mode) a streaming app is a plain window with a local test page; nothing is fetched from the
 * internet. Its keys use the shell's own mapping and long-press timing: Back closes it back to Apps, Home (or a
 * long Back) closes it and goes to the Home screen, and a long Home opens the Recovery menu, just like the TV.
 */
function openMockApp(entry: AppEntry, route: AppRoute): MockWindow {
  const win = newWindow({
    title: entry.name,
    backgroundColor: entry.colour,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  })
  reveal(win)
  blockNavigation(win.webContents)
  // What the shell should do once the window has gone (Home or Recovery); plain Back just returns to Apps.
  let after: 'home' | 'recovery' | undefined
  const leave = (then?: 'home' | 'recovery'): void => {
    after ??= then
    if (!win.isDestroyed()) win.close()
  }
  const timing = new KeyTiming((action) => {
    if (action === 'back') leave()
    else if (action === 'home') leave('home')
    else if (action === 'recovery') leave('recovery')
  })
  win.webContents.on('before-input-event', (event, input) => {
    // Ctrl+Alt+Backspace is Recovery here too, as in the shell window (otherwise it would read as a plain Back).
    if (input.control && input.alt && input.key === 'Backspace') {
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        timing.cancel()
        leave('recovery')
      }
      return
    }
    const action = keyToAction(input.key, input.code)
    if (action !== 'back' && action !== 'home') return
    // Only the key-up is swallowed: Chromium drops the key-up of a swallowed key-down, so a short press would
    // look like a hold. The test page runs no scripts, so letting it see the key-down is harmless.
    if (input.type === 'keyDown') timing.down(action, input.isAutoRepeat)
    else if (input.type === 'keyUp') {
      event.preventDefault()
      timing.up(action)
    }
  })
  win.on('blur', () => timing.cancel())
  win.once('closed', () => timing.cancel())
  void win.loadURL(mockAppPage(entry.name, entry.colour, route))
  return {
    close: () => {
      if (!win.isDestroyed()) win.close()
    },
    onClosed: (cb) => {
      win.once('closed', () => {
        cb()
        if (shellWindow && !opts.background) shellWindow.focus()
        if (after === 'home') sendToShell('action', { action: 'home' })
        else if (after === 'recovery') sendToShell('recovery', {})
      })
    },
  }
}

function restartShell(): void {
  void stopCore().finally(() => {
    // On the TV, systemd starts the shell again by itself; relaunching too would race it for the single-instance lock.
    if (opts.platform !== 'linux') app.relaunch()
    app.exit(0)
  })
}

function stopCore(): Promise<void> {
  const fn = shutdown
  shutdown = undefined
  // The log file is already closed by now, so say so on the console (error kind only, never its text).
  return fn ? fn().catch((err: unknown) => console.error(`MediaOS did not shut down cleanly (${errorKind(err)})`)) : Promise.resolve()
}

function errorKind(err: unknown): string {
  return err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err
}

// Save settings and stop the player before the process ends.
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void stopCore().finally(() => app.exit(0))
})

app.on('window-all-closed', () => app.quit())

function fatal(err: unknown): void {
  // Never show or log the error's text: a parse error quotes the file it read, and that file may hold sign-ins.
  const kind = errorKind(err)
  console.error(`MediaOS could not start (${kind})`)
  // Show a plain screen rather than a black one; the shell page has no way to start without the core.
  const win = newWindow({ backgroundColor: '#0b0d12', show: false })
  reveal(win)
  const html =
    '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;' +
    'background:#0b0d12;color:#f2f4f8;font:1.6vw system-ui,sans-serif;text-align:center"><div>' +
    '<h1>MediaOS could not start</h1><p>Turn the box off and on again. If this keeps happening, it may need to be set up again.</p>' +
    `<p style="opacity:.6">Error type: ${kind.replace(/[^\w.-]/g, '')}</p></div>`
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}
