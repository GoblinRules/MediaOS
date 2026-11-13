// Focusable building blocks on top of Norigin. Every focusable has an explicit focusKey so focus can be
// remembered and restored by name.
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation'
import { useEffect, useLayoutEffect, type CSSProperties, type ReactNode } from 'react'
import { clickOn, itemGone, noteFocused, pointerChose, reveal, setMenuTarget } from '../input/focus'
import { noteScreenMove } from '../input/input'

type Direction = 'up' | 'down' | 'left' | 'right'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface FocusableProps {
  focusKey: string
  onSelect?: () => void
  onFocused?: () => void
  /** Options for this item (Menu key, or hold Select). */
  onMenu?: () => void
  /** Return false to stop focus moving in that direction (the item used the key itself). */
  onArrow?: (dir: Direction) => boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
  label?: string
  role?: string
  children: ReactNode | ((focused: boolean) => ReactNode)
  testId?: string
}

/** Pointer focus outside menus and other overlays is a move the user made, like an arrow (see useScreenFocus). */
function notePointer(node: HTMLElement): void {
  if (node.closest('.scrim')) return
  noteScreenMove('pointer')
  pointerChose()
}

/**
 * Norigin registers an item once, under the key it first had, and ignores later key changes. React reuses an item
 * when only its key changes (Details swapping Play for Resume, say), which would leave Norigin holding the old key
 * while the screen shows the new one. Keying by focusKey makes a new key a new item.
 */
export function Focusable(p: FocusableProps): ReactNode {
  return <FocusableItem key={p.focusKey} {...p} />
}

function FocusableItem(p: FocusableProps): ReactNode {
  const { ref, focused, focusSelf } = useFocusable<object, HTMLDivElement>({
    focusKey: p.focusKey,
    focusable: !p.disabled,
    onEnterPress: () => p.onSelect?.(),
    onArrowPress: (dir) => (p.onArrow ? p.onArrow(dir as Direction) : true),
    onFocus: (layout) => {
      noteFocused(p.focusKey, layout.node)
      reveal(layout.node)
      setMenuTarget(p.focusKey, p.onMenu)
      p.onFocused?.()
    },
    accessibilityLabel: p.label,
  })
  // Keep the Menu key's target up to date while focused: the item's data (and so its options) can change
  // under the focus ring, e.g. after "Mark as watched".
  useLayoutEffect(() => {
    if (focused) setMenuTarget(p.focusKey, p.onMenu)
  }, [focused, p.focusKey, p.onMenu])
  // If this item had focus when it goes, the item now in its place takes it (see itemGone).
  const key = p.focusKey
  useEffect(() => () => itemGone(key), [key])
  return (
    <div
      ref={ref}
      className={cx('focusable', p.className, focused && 'is-focused', p.disabled && 'is-disabled')}
      style={p.style}
      role={p.role ?? 'button'}
      aria-label={p.label}
      aria-disabled={p.disabled || undefined}
      data-focus-key={p.focusKey}
      data-focused={focused || undefined}
      data-testid={p.testId}
      onMouseMove={(e) => {
        if (focused || p.disabled) return
        notePointer(e.currentTarget)
        focusSelf()
      }}
      onClick={(e) => {
        if (p.disabled) return
        if (!focused) notePointer(e.currentTarget)
        focusSelf()
        // Focus reaches this item asynchronously: whatever the click opens must remember this item, not the last one.
        const select = p.onSelect
        if (select) clickOn(p.focusKey, select)
      }}
    >
      {typeof p.children === 'function' ? p.children(focused) : p.children}
    </div>
  )
}

export interface FocusGroupProps {
  focusKey: string
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** Keep focus inside (overlays). */
  boundary?: boolean
  boundaryDirections?: Direction[]
  preferredChild?: string
  /** Remember the last focused child (default true). */
  remember?: boolean
  /** Scroll direction this element owns (see reveal()). */
  scroll?: 'x' | 'y'
  /** Mark as the block that should be fully revealed when something inside gets focus. */
  revealBlock?: boolean | 'top'
  /** Its child groups are rows: if the focused item's whole row goes, focus goes to the row now in its place. */
  rows?: boolean
  onFocusWithin?: (has: boolean) => void
  role?: string
  label?: string
  testId?: string
}

/** Keyed by focusKey for the same reason as Focusable; a group with a new key brings new children too. */
export function FocusGroup(p: FocusGroupProps): ReactNode {
  return <FocusGroupItem key={p.focusKey} {...p} />
}

function FocusGroupItem(p: FocusGroupProps): ReactNode {
  const { ref, focusKey, hasFocusedChild } = useFocusable<object, HTMLDivElement>({
    focusKey: p.focusKey,
    saveLastFocusedChild: p.remember ?? true,
    trackChildren: true,
    isFocusBoundary: p.boundary ?? false,
    focusBoundaryDirections: p.boundaryDirections,
    preferredChildFocusKey: p.preferredChild,
  })
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx(p.className, hasFocusedChild && 'has-focus')}
        style={p.style}
        role={p.role}
        aria-label={p.label}
        data-scroll={p.scroll}
        data-reveal={p.revealBlock === true ? '' : p.revealBlock || undefined}
        data-focus-group={p.focusKey}
        data-focus-rows={p.rows ? '' : undefined}
        data-testid={p.testId}
      >
        {p.children}
      </div>
    </FocusContext.Provider>
  )
}

/** A plain button-like focusable with an optional icon. */
export function Button(p: {
  focusKey: string
  label: string
  onSelect: () => void
  icon?: ReactNode
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  small?: boolean
  className?: string
  testId?: string
}): ReactNode {
  return (
    <Focusable
      focusKey={p.focusKey}
      onSelect={p.onSelect}
      disabled={p.disabled}
      label={p.label}
      testId={p.testId}
      className={cx('btn', p.primary && 'btn-primary', p.danger && 'btn-danger', p.small && 'btn-small', p.className)}
    >
      {p.icon}
      <span>{p.label}</span>
    </Focusable>
  )
}
