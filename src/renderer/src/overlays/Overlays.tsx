// Everything drawn above the screens: menus, confirmations, the on-screen keyboard, toasts.
import { useEffect, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import { LAYER, useInputLayer } from '../input/input'
import { focus, moveFocus, pressFocused } from '../input/focus'
import { closeOverlay, overlayStore, type OverlayEntry } from '../state/nav'
import { Focusable, FocusGroup, Button, cx } from '../components/Focusable'
import { Icon } from '../components/Icon'
import { Keyboard } from './Keyboard'
import { dismissToast, toastStore } from '../state/toasts'

export function Overlays(): ReactNode {
  const list = useStore(overlayStore)
  return (
    <>
      {list.map((o, i) => (
        <OverlayView key={o.id} o={o} top={i === list.length - 1} />
      ))}
      <Toasts />
    </>
  )
}

function OverlayView({ o, top }: { o: OverlayEntry; top: boolean }): ReactNode {
  // Overlays handle focus moves and presses themselves (so a screen or the player underneath never sees
  // them), swallow every other key, and let only system keys through.
  useInputLayer(
    LAYER.overlay,
    (action) => {
      if (!top) return false
      switch (action) {
        case 'back':
          closeOverlay(o.id)
          if (o.kind === 'confirm') o.onCancel?.()
          return true
        case 'up':
        case 'down':
        case 'left':
        case 'right':
          moveFocus(action, `ov${o.id}`)
          return true
        case 'select':
          pressFocused(`ov${o.id}`)
          return true
        case 'power':
        case 'recovery':
        case 'home':
        case 'volumeUp':
        case 'volumeDown':
        case 'mute':
          return false
        case 'menu':
          if (o.kind === 'menu') closeOverlay(o.id)
          return true
        default:
          return true
      }
    },
    top,
  )
  switch (o.kind) {
    case 'menu':
      return <MenuOverlay o={o} />
    case 'confirm':
      return <ConfirmOverlay o={o} />
    case 'keyboard':
      return <Keyboard o={o} />
  }
}

function useInitialFocus(key: string): void {
  useEffect(() => {
    focus(key)
  }, [key])
}

function MenuOverlay({ o }: { o: Extract<OverlayEntry, { kind: 'menu' }> }): ReactNode {
  // Choice menus open on the option already chosen, like a TV; other menus open on their first item.
  const first = o.items.find((i) => i.checked && !i.disabled) ?? o.items.find((i) => !i.disabled)
  useInitialFocus(`ov${o.id}:${first?.id ?? ''}`)
  return (
    <div className="scrim" data-testid="menu-overlay">
      <FocusGroup focusKey={`ov${o.id}`} boundary className={cx('panel', o.side ? 'panel-side' : 'panel-centre')} role="dialog" label={o.title}>
        {o.title && <h2 className="panel-title">{o.title}</h2>}
        {o.subtitle && <p className="panel-sub">{o.subtitle}</p>}
        <div className="menu-list" data-scroll="y">
          {o.items.map((item) => (
            <Focusable
              key={item.id}
              focusKey={`ov${o.id}:${item.id}`}
              disabled={item.disabled}
              className={cx('menu-item', item.danger && 'is-danger')}
              label={item.label}
              testId={`menu-${item.id}`}
              onSelect={() => {
                closeOverlay(o.id)
                item.onSelect()
              }}
            >
              <span className="menu-icon">{item.icon && <Icon name={item.icon} size="1.4rem" />}</span>
              <span className="menu-text">
                <span>{item.label}</span>
                {item.detail && <small>{item.detail}</small>}
              </span>
              {item.checked && <Icon name="check" size="1.3rem" className="menu-check" />}
            </Focusable>
          ))}
        </div>
      </FocusGroup>
    </div>
  )
}

function ConfirmOverlay({ o }: { o: Extract<OverlayEntry, { kind: 'confirm' }> }): ReactNode {
  // Dangerous choices start on Cancel so a stray press does nothing.
  useInitialFocus(`ov${o.id}:${o.danger || o.startOnCancel ? 'cancel' : 'ok'}`)
  return (
    <div className="scrim" data-testid="confirm-overlay">
      <FocusGroup focusKey={`ov${o.id}`} boundary className="panel panel-centre panel-confirm" role="alertdialog" label={o.title}>
        <h2 className="panel-title">{o.title}</h2>
        {o.body && <p className="panel-body">{o.body}</p>}
        <div className="panel-actions">
          <Button
            focusKey={`ov${o.id}:cancel`}
            label={o.cancelLabel ?? 'Cancel'}
            testId="confirm-cancel"
            onSelect={() => {
              closeOverlay(o.id)
              o.onCancel?.()
            }}
          />
          <Button
            focusKey={`ov${o.id}:ok`}
            label={o.confirmLabel}
            primary={!o.danger}
            danger={o.danger}
            testId="confirm-ok"
            onSelect={() => {
              closeOverlay(o.id)
              o.onConfirm()
            }}
          />
        </div>
      </FocusGroup>
    </div>
  )
}

function Toasts(): ReactNode {
  const toasts = useStore(toastStore)
  return (
    <div className="toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone && `toast-${t.tone}`)} onClick={() => dismissToast(t.id)} data-testid="toast">
          <Icon name={t.tone === 'error' || t.tone === 'warn' ? 'warning' : t.tone === 'ok' ? 'check' : 'info'} size="1.3rem" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
