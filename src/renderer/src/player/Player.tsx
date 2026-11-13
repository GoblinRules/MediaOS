// The playback screen. On the box mpv draws the video in its own window and this view only shows the
// on-screen controls; in mock mode (Windows dev) it also draws a test pattern so playback can be tested.
import { useEffect, useState, type ReactNode } from 'react'
import type { PlayerCommand, PlayerState } from '@shared/player-types'
import { call } from '../lib/api'
import { useStore } from '../lib/store'
import { describeItem } from '../lib/items'
import { LAYER, useInputLayer } from '../input/input'
import { menu, type MenuItem } from '../state/nav'
import { playerActive, playerStore } from '../state/player'
import { useSettings } from '../state/settings'
import { cx } from '../components/Focusable'
import { Icon } from '../components/Icon'

const OSD_MS = 4000

function send(cmd: PlayerCommand): void {
  void call('player.command', cmd).catch(() => undefined)
}

export function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function trackMenu(s: PlayerState): void {
  const items: MenuItem[] = []
  for (const t of s.audioTracks) {
    items.push({ id: `a${t.index}`, label: t.label, detail: 'Audio', icon: 'sound', checked: t.selected, onSelect: () => send({ kind: 'setAudio', index: t.index }) })
  }
  const anySub = s.subtitleTracks.some((t) => t.selected)
  items.push({ id: 'soff', label: 'Subtitles off', icon: 'subtitles', checked: !anySub, onSelect: () => send({ kind: 'setSubtitle', index: null }) })
  for (const t of s.subtitleTracks) {
    items.push({ id: `s${t.index}`, label: t.label, detail: 'Subtitles', icon: 'subtitles', checked: t.selected, onSelect: () => send({ kind: 'setSubtitle', index: t.index }) })
  }
  menu('Audio and subtitles', items)
}

export function Player(): ReactNode {
  const s = useStore(playerStore)
  const settings = useSettings()
  const active = playerActive(s)
  const [osdAt, setOsdAt] = useState(0)
  const [now, setNow] = useState(0)
  // Back hides the controls first (even while paused); any other press shows them again. The hide belongs to
  // the programme it was pressed on, so the next programme starts with the controls allowed again.
  const [hiddenFor, setHiddenFor] = useState<string>()
  const osdHidden = hiddenFor !== undefined && hiddenFor === (s.item?.id ?? '')
  const poke = (): void => {
    setHiddenFor(undefined)
    setOsdAt(Date.now())
  }
  // While loading or buffering the controls cannot be hidden, so Back stops straight away (and the hint says so).
  const controlsShowing = (p: PlayerState): boolean =>
    p.status !== 'loading' && p.status !== 'buffering' && !osdHidden && (p.status === 'paused' || (osdAt > 0 && Date.now() < osdAt + OSD_MS))

  // A new start (or the player closing) allows the controls again, even for the same programme played twice.
  // (Back stops rather than hides while loading, so nothing can set it again until playback is under way.)
  if ((!active || s.status === 'loading') && hiddenFor !== undefined) setHiddenFor(undefined)

  // Hide the controls a few seconds after the last button press.
  useEffect(() => {
    if (!osdAt) return
    const t = setTimeout(() => setNow(Date.now()), OSD_MS + 50)
    return () => clearTimeout(t)
  }, [osdAt])

  useInputLayer(
    LAYER.player,
    (action) => {
      const p = playerStore.get()
      if (p.status === 'error') {
        if (action === 'back' || action === 'select' || action === 'stop') {
          send({ kind: 'stop' })
          return true
        }
        return !['home', 'power', 'recovery'].includes(action)
      }
      if (p.upNext && (action === 'select' || action === 'back')) {
        send(action === 'select' ? { kind: 'playNext' } : { kind: 'cancelUpNext' })
        return true
      }
      switch (action) {
        case 'select':
        case 'playPause':
          send({ kind: 'togglePause' })
          poke()
          return true
        case 'left':
        case 'rewind':
          send({ kind: 'seekRelative', seconds: -settings.playback.skipBackSec })
          poke()
          return true
        case 'right':
        case 'fastForward':
          send({ kind: 'seekRelative', seconds: settings.playback.skipForwardSec })
          poke()
          return true
        case 'previous':
          send({ kind: 'seekTo', seconds: 0 })
          poke()
          return true
        case 'next':
          send({ kind: 'playNext' })
          return true
        case 'up':
          poke()
          return true
        case 'down':
        case 'menu':
          poke()
          trackMenu(p)
          return true
        case 'back':
          if (controlsShowing(p)) {
            setHiddenFor(p.item?.id ?? '')
            setOsdAt(0)
            return true
          }
          send({ kind: 'stop' })
          return true
        case 'stop':
          send({ kind: 'stop' })
          return true
        case 'home':
        case 'power':
        case 'recovery':
        case 'volumeUp':
        case 'volumeDown':
        case 'mute':
          return false
        default:
          return true
      }
    },
    active,
  )

  if (!active || !s.item) return null
  const item = s.item
  const paused = s.status === 'paused'
  const waiting = s.status === 'loading' || s.status === 'buffering'
  const hideable = !waiting && !osdHidden && (paused || (osdAt > 0 && now < osdAt + OSD_MS))
  const showOsd = waiting || hideable
  const dur = s.durationSec ?? item.runtimeSec ?? 0
  const pct = dur > 0 ? Math.min(100, (s.positionSec / dur) * 100) : 0

  return (
    <div className={cx('player', s.backend === 'mock' && 'player-mock')} data-testid="player" data-status={s.status}>
      {s.backend === 'mock' && (
        <div className="player-pattern" aria-hidden>
          <div className="pattern-bars" />
          <div className="pattern-label">Test playback · {item.title}</div>
        </div>
      )}
      {s.status === 'error' ? (
        <div className="player-error" role="alert" data-testid="player-error">
          <Icon name="warning" size="4rem" />
          <h1>This can&apos;t play right now</h1>
          <p>{s.error ?? 'Something went wrong while playing.'}</p>
          <p className="player-hint">Press OK or Back to go back.</p>
        </div>
      ) : (
        <>
          {(s.status === 'loading' || s.status === 'buffering') && (
            <div className="spinner-wrap player-spinner" role="status" aria-label="Loading">
              <div className="spinner" />
            </div>
          )}
          <div className={cx('osd', showOsd && 'is-visible')} data-testid="player-osd" data-visible={showOsd ? 'yes' : 'no'}>
            <div className="osd-top">
              <div className="osd-kicker">{describeItem(item)}</div>
              <h1 className="osd-title">{item.title}</h1>
            </div>
            <div className="osd-bottom">
              <div className="osd-state">
                <Icon name={paused ? 'pause' : 'play'} size="2rem" />
                {paused && <span className="osd-paused">Paused · OK to carry on</span>}
                {s.method === 'transcode' && <span className="osd-tag">Converting on the server</span>}
              </div>
              <div className="osd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                <div className="osd-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="osd-times">
                <span>{clockText(s.positionSec)}</span>
                <span className="osd-help">
                  ◀ ▶ skip {settings.playback.skipBackSec}s / {settings.playback.skipForwardSec}s · ▼ audio and subtitles ·
                  {hideable ? ' Back hides this, press again to stop' : ' Back to stop'}
                </span>
                <span>{dur > 0 ? `-${clockText(dur - s.positionSec)}` : ''}</span>
              </div>
            </div>
          </div>
          {s.upNext && (
            <div className="upnext" data-testid="up-next">
              <div className="upnext-kicker">Up next</div>
              <div className="upnext-title">{s.upNext.title}</div>
              <div className="upnext-sub">{describeItem(s.upNext)}</div>
              <div className="upnext-help">OK: play now · Back: keep watching the credits</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
