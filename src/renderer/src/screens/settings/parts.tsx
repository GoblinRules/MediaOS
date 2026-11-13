// Building blocks for Settings pages: a titled section, a row that shows a value, an on/off row, a row that
// opens a list of choices, and a row whose value changes with left/right.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Focusable, cx } from '../../components/Focusable'
import { Icon } from '../../components/Icon'
import { menu } from '../../state/nav'

export function Section(p: { title: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <section className="set-section">
      <h2 className="set-section-title">{p.title}</h2>
      {p.hint && <p className="set-section-hint">{p.hint}</p>}
      <div className="set-rows" data-focus-section="">{p.children}</div>
    </section>
  )
}

export interface RowProps {
  focusKey: string
  label: string
  /** Short value on the right ("On", "1920 × 1080"). */
  value?: ReactNode
  /** Smaller explanation under the label. */
  detail?: ReactNode
  icon?: string
  onSelect?: () => void
  onMenu?: () => void
  onArrow?: (dir: 'up' | 'down' | 'left' | 'right') => boolean
  danger?: boolean
  disabled?: boolean
  /** Shows a ">" to say the row opens something. */
  opens?: boolean
  testId?: string
}

export function SettingRow(p: RowProps): ReactNode {
  return (
    <Focusable
      focusKey={p.focusKey}
      onSelect={p.onSelect}
      onMenu={p.onMenu}
      onArrow={p.onArrow}
      disabled={p.disabled}
      label={p.label}
      testId={p.testId}
      className={cx('set-row', p.danger && 'is-danger', !p.onSelect && 'is-info')}
    >
      {p.icon && <Icon name={p.icon} size="1.6rem" className="set-row-icon" />}
      <div className="set-row-text">
        <div className="set-row-label">{p.label}</div>
        {p.detail && <div className="set-row-detail">{p.detail}</div>}
      </div>
      {p.value !== undefined && <div className="set-row-value">{p.value}</div>}
      {p.opens && <Icon name="next" size="1.2rem" className="set-row-chevron" />}
    </Focusable>
  )
}

export function ToggleRow(p: Omit<RowProps, 'value' | 'onSelect'> & { on: boolean; onChange: (on: boolean) => void }): ReactNode {
  return (
    <SettingRow
      {...p}
      onSelect={() => p.onChange(!p.on)}
      value={
        <span className={cx('switch', p.on && 'is-on')} role="switch" aria-checked={p.on}>
          <span className="switch-knob" />
        </span>
      }
    />
  )
}

export interface Choice<T> {
  value: T
  label: string
  detail?: string
}

/** A row whose value is picked from a side menu. */
export function ChoiceRow<T extends string | number>(
  p: Omit<RowProps, 'value' | 'onSelect' | 'opens'> & { value: T | undefined; choices: Choice<T>[]; onChange: (v: T) => void; title?: string },
): ReactNode {
  const current = p.choices.find((c) => c.value === p.value)
  const open = (): void =>
    menu(
      p.title ?? p.label,
      p.choices.map((c) => ({
        id: String(c.value),
        label: c.label,
        detail: c.detail,
        checked: c.value === p.value,
        onSelect: () => {
          if (c.value !== p.value) p.onChange(c.value)
        },
      })),
    )
  return <SettingRow {...p} value={current?.label ?? '—'} onSelect={p.choices.length > 0 ? open : undefined} opens />
}

const COMMIT_MS = 400
/** How long a sent value stays on screen waiting for the saved one; after that the row shows what is really saved. */
const SETTLE_MS = 3000

/**
 * A number changed with left/right (volume, text size). The value shown follows presses at once; the
 * change is sent a moment after the last press so holding the button doesn't flood the system.
 */
export function StepperRow(
  p: Omit<RowProps, 'value' | 'onArrow' | 'onSelect'> & {
    value: number
    min: number
    max: number
    step: number
    format: (v: number) => string
    onChange: (v: number) => void
  },
): ReactNode {
  const [draft, setDraft] = useState<number>()
  const pending = useRef<{ value: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  // After a send, keep showing the new number until it is the saved one (or SETTLE_MS passes, e.g. if it failed or
  // was rounded), so it does not flick back and a quick second press steps from the right place.
  const [sent, setSent] = useState<{ value: number; timer: ReturnType<typeof setTimeout> }>()
  if (sent && p.value === sent.value) {
    clearTimeout(sent.timer)
    setSent(undefined)
    // A newer press that is still waiting to be sent keeps its own number.
    if (draft === sent.value) setDraft(undefined)
  }
  useEffect(() => () => clearTimeout(sent?.timer), [sent])
  const onChange = useRef(p.onChange)
  useEffect(() => {
    onChange.current = p.onChange
  }, [p.onChange])

  // Send a change that is still waiting if the row goes away (page switched).
  useEffect(
    () => () => {
      const w = pending.current
      if (!w) return
      clearTimeout(w.timer)
      onChange.current(w.value)
    },
    [],
  )

  const shown = draft ?? p.value
  const nudge = (dir: number): void => {
    const next = Math.min(p.max, Math.max(p.min, Math.round((shown + dir * p.step) * 1000) / 1000))
    if (next === shown) return
    if (pending.current) clearTimeout(pending.current.timer)
    const timer = setTimeout(() => {
      pending.current = undefined
      onChange.current(next)
      const settle = setTimeout(() => {
        setSent(undefined)
        setDraft((d) => (d === next ? undefined : d))
      }, SETTLE_MS)
      setSent({ value: next, timer: settle })
    }, COMMIT_MS)
    pending.current = { value: next, timer }
    setDraft(next)
  }
  const pct = ((shown - p.min) / (p.max - p.min)) * 100

  return (
    <SettingRow
      {...p}
      onArrow={(dir) => {
        if (dir === 'left' || dir === 'right') {
          nudge(dir === 'left' ? -1 : 1)
          return false
        }
        return true
      }}
      value={
        <span className="stepper">
          <Icon name="back" size="1rem" className={cx('stepper-arrow', shown <= p.min && 'is-off')} />
          <span className="stepper-bar">
            <span className="stepper-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="stepper-value">{p.format(shown)}</span>
          <Icon name="next" size="1rem" className={cx('stepper-arrow', shown >= p.max && 'is-off')} />
        </span>
      }
    />
  )
}

/** Shown in place of a section's rows while they load or when they failed. */
export function RowsState(p: { loading: boolean; error?: string; focusKey: string; onRetry: () => void }): ReactNode {
  if (p.error) {
    return <SettingRow focusKey={p.focusKey} label="This could not load" detail={p.error} icon="warning" value="Try again" onSelect={p.onRetry} />
  }
  if (p.loading) return <div className="set-loading">Loading…</div>
  return null
}
