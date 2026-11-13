// Every input (remote, keyboard, gamepad, phone, CEC) is turned into one of these actions.
export const ACTIONS = [
  'up', 'down', 'left', 'right', 'select', 'back', 'home', 'menu',
  'playPause', 'stop', 'rewind', 'fastForward', 'next', 'previous',
  'volumeUp', 'volumeDown', 'mute', 'pageUp', 'pageDown', 'power', 'recovery',
] as const
export type Action = (typeof ACTIONS)[number]

/** Hold Back this long to go Home (TVs often keep the Home key for themselves). */
export const LONG_BACK_MS = 800
/** Hold Select this long to open the Menu (for remotes without a Menu key). */
export const LONG_SELECT_MS = 600
/** Hold Home this long to open the Recovery menu. */
export const LONG_HOME_MS = 1500

/** Raw key from the keyboard/remote, before long-press timing. */
export type RawKey = Action

/**
 * Map a DOM KeyboardEvent (key + code) to a raw action. Covers keyboards, air-mice, CEC and dev shortcuts:
 * F1 = Home, Esc/Backspace = Back, M/ContextMenu = Menu. TV-remote (CEC) buttons arrive as ordinary keys: the box's
 * hwdb remap (os/config-pkg/usr/lib/udev/hwdb.d/70-mediaos-cec.hwdb) turns OK into Enter, Exit into Escape and the
 * remote's Home (Root Menu) button into the Home key, which sway catches, and its Options/Setup buttons into the
 * Menu key.
 * Returns undefined for keys the shell does not handle (e.g. letters typed into a text field).
 */
export function keyToAction(key: string, code: string): RawKey | undefined {
  switch (key) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'ArrowLeft': return 'left'
    case 'ArrowRight': return 'right'
    case 'Enter': case 'Select': return 'select'
    case 'Escape': case 'Backspace': case 'BrowserBack': case 'GoBack': case 'Exit': return 'back'
    case 'F1': case 'BrowserHome': case 'GoHome': case 'Home': return 'home'
    case 'ContextMenu': case 'F2': case 'Info': return 'menu'
    case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause': return 'playPause'
    case 'MediaStop': return 'stop'
    case 'MediaRewind': return 'rewind'
    case 'MediaFastForward': return 'fastForward'
    case 'MediaTrackNext': return 'next'
    case 'MediaTrackPrevious': return 'previous'
    case 'AudioVolumeUp': return 'volumeUp'
    case 'AudioVolumeDown': return 'volumeDown'
    case 'AudioVolumeMute': return 'mute'
    case 'PageUp': return 'pageUp'
    case 'PageDown': return 'pageDown'
    case 'Power': case 'PowerOff': case 'F12': return 'power'
    case 'ColorF0Red': return 'home' // Red key: a second Home path for TVs that keep Home
    case 'm': case 'M': return code === 'KeyM' ? 'menu' : undefined
    case 'p': case 'P': return code === 'KeyP' ? 'playPause' : undefined
    default: return undefined
  }
}
