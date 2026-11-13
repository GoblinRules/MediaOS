// On-screen keyboard for remotes (Wi-Fi passwords, server addresses, names). Physical keyboards and the phone
// remote type straight into it too. `pad: 'ip'` swaps the letters for a number pad (network addresses).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Focusable, FocusGroup, cx } from '../components/Focusable'
import { Icon } from '../components/Icon'
import { focus } from '../input/focus'
import { setTextSink } from '../input/input'
import { closeOverlay, type OverlayEntry } from '../state/nav'

type Layout = 'abc' | 'ABC' | '123'

const LAYOUTS: Record<Layout, string[]> = {
  abc: ['1234567890', 'qwertyuiop', 'asdfghjkl-', 'zxcvbnm._@'],
  ABC: ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL-', 'ZXCVBNM._@'],
  '123': ['1234567890', '!#$%&*+=?/', ':;,\'"()[]~', '<>{}|\\^`_@'],
}

const IP_ROWS = ['123', '456', '789']

type KeyboardOverlay = Extract<OverlayEntry, { kind: 'keyboard' }>

/** Only the characters `allowed` lets through (all of them when there is no rule). */
function filtered(text: string, allowed: RegExp | undefined): string {
  if (!allowed) return text
  return [...text].filter((ch) => allowed.test(ch)).join('')
}

export function Keyboard({ o }: { o: KeyboardOverlay }): ReactNode {
  const [value, setValue] = useState(o.initial)
  const [problem, setProblem] = useState<string>()
  const [reveal, setReveal] = useState(false)
  const max = o.maxLength ?? (o.pad === 'ip' ? 15 : 200)
  // Mirror of value for the text sink (it must answer "was there anything to delete?" straight away).
  const current = useRef(value)
  useEffect(() => {
    current.current = value
  })

  useEffect(() => {
    focus(`ov${o.id}:k:0:0`)
  }, [o.id])

  const change = (next: string): void => {
    current.current = next
    setValue(next)
    setProblem(undefined)
  }
  const add = (text: string): void => {
    const ok = filtered(text, o.allowed)
    if (ok) change((current.current + ok).slice(0, max))
  }
  const del = (): boolean => {
    if (!current.current) return false
    change(current.current.slice(0, -1))
    return true
  }
  // Kept up to date after each render so the text sink always uses the latest add/del.
  const sink = useRef({ add, del })
  useEffect(() => {
    sink.current = { add, del }
  })
  useEffect(() => setTextSink({ insert: (text) => sink.current.add(text), backspace: () => sink.current.del() }), [])

  const done = (): void => {
    const message = o.validate?.(current.current)
    if (message) {
      setProblem(message)
      return
    }
    closeOverlay(o.id)
    o.onDone(current.current)
  }

  return (
    <div className="scrim scrim-keyboard" data-testid="keyboard-overlay">
      <FocusGroup focusKey={`ov${o.id}`} boundary className={cx('keyboard', o.pad === 'ip' && 'keyboard-pad')} role="dialog" label={o.title}>
        <h2 className="panel-title">{o.title}</h2>
        <Field o={o} value={value} reveal={reveal} />
        {problem && (
          <p className="kb-problem" role="alert" data-testid="keyboard-problem">
            <Icon name="warning" size="1.2rem" /> {problem}
          </p>
        )}
        {o.pad === 'ip' ? (
          <IpPad id={o.id} add={add} del={del} clear={() => change('')} done={done} />
        ) : (
          <TextKeys o={o} add={add} del={del} done={done} reveal={reveal} toggleReveal={() => setReveal((r) => !r)} />
        )}
      </FocusGroup>
    </div>
  )
}

function Field({ o, value, reveal }: { o: KeyboardOverlay; value: string; reveal: boolean }): ReactNode {
  const shown = o.secret && !reveal ? '•'.repeat(value.length) : value
  return (
    <div className={cx('kb-field', !value && 'is-empty')} data-testid="keyboard-value">
      {shown || <span className="kb-placeholder">{o.hint ?? 'Type with the remote or a keyboard'}</span>}
      <span className="kb-caret" />
    </div>
  )
}

interface KeysProps {
  add: (text: string) => void
  del: () => boolean
  done: () => void
}

function DoneKey({ id, done }: { id: number; done: () => void }): ReactNode {
  return (
    <Focusable focusKey={`ov${id}:done`} className="kb-key kb-wide kb-done" label="Done" onSelect={done} testId="keyboard-done">
      <Icon name="check" size="1.2rem" /> Done
    </Focusable>
  )
}

function DeleteKey({ id, del }: { id: number; del: () => boolean }): ReactNode {
  return (
    <Focusable focusKey={`ov${id}:del`} className="kb-key kb-wide" label="Delete" onSelect={() => void del()}>
      <Icon name="back" size="1.2rem" /> Delete
    </Focusable>
  )
}

/** Digits and a dot: 1 2 3 / 4 5 6 / 7 8 9 / . 0 Delete / Clear Done. Keys keep the k:{row}:{col} keys. */
function IpPad({ id, add, del, clear, done }: KeysProps & { id: number; clear: () => void }): ReactNode {
  return (
    <div className="kb-keys kb-pad" data-testid="keyboard-pad">
      {IP_ROWS.map((row, r) => (
        <div className="kb-row" key={r}>
          {[...row].map((ch, c) => (
            <Focusable key={ch} focusKey={`ov${id}:k:${r}:${c}`} className="kb-key" label={ch} onSelect={() => add(ch)}>
              {ch}
            </Focusable>
          ))}
        </div>
      ))}
      <div className="kb-row">
        <Focusable focusKey={`ov${id}:k:3:0`} className="kb-key" label="Dot" onSelect={() => add('.')}>
          .
        </Focusable>
        <Focusable focusKey={`ov${id}:k:3:1`} className="kb-key" label="0" onSelect={() => add('0')}>
          0
        </Focusable>
        <DeleteKey id={id} del={del} />
      </div>
      <div className="kb-row">
        <Focusable focusKey={`ov${id}:clear`} className="kb-key kb-wide" label="Clear" onSelect={clear}>
          Clear
        </Focusable>
        <DoneKey id={id} done={done} />
      </div>
    </div>
  )
}

interface TextKeysProps extends KeysProps {
  o: KeyboardOverlay
  reveal: boolean
  toggleReveal: () => void
}

function TextKeys({ o, add, del, done, reveal, toggleReveal }: TextKeysProps): ReactNode {
  const [layout, setLayout] = useState<Layout>('abc')
  const rows = LAYOUTS[layout]
  return (
    <div className="kb-keys">
      {rows.map((row, r) => (
        <div className="kb-row" key={r}>
          {[...row].map((ch, c) => (
            <Focusable key={`${layout}${r}${c}`} focusKey={`ov${o.id}:k:${r}:${c}`} className="kb-key" label={ch} onSelect={() => add(ch)}>
              {ch}
            </Focusable>
          ))}
        </div>
      ))}
      <div className="kb-row">
        <Focusable focusKey={`ov${o.id}:shift`} className="kb-key kb-wide" label="Change letters"
          onSelect={() => setLayout((l) => (l === 'abc' ? 'ABC' : l === 'ABC' ? '123' : 'abc'))}>
          {layout === 'abc' ? 'ABC' : layout === 'ABC' ? '#+=' : 'abc'}
        </Focusable>
        <Focusable focusKey={`ov${o.id}:space`} className="kb-key kb-space" label="Space" onSelect={() => add(' ')}>
          Space
        </Focusable>
        <DeleteKey id={o.id} del={del} />
        {o.secret && (
          <Focusable focusKey={`ov${o.id}:show`} className="kb-key kb-wide" label={reveal ? 'Hide' : 'Show'} onSelect={toggleReveal}>
            <Icon name={reveal ? 'eyeOff' : 'eye'} size="1.2rem" /> {reveal ? 'Hide' : 'Show'}
          </Focusable>
        )}
        <DoneKey id={o.id} done={done} />
      </div>
    </div>
  )
}
