// A titled horizontal row of tiles (Home, Details "More like this", Search results).
import type { ReactNode } from 'react'
import { FocusGroup } from './Focusable'

export function Row(p: {
  focusKey: string
  title: string
  children: ReactNode
  count?: number
  testId?: string
}): ReactNode {
  return (
    <FocusGroup focusKey={p.focusKey} className="row" revealBlock testId={p.testId ?? 'row'} label={p.title} role="region">
      <h2 className="row-title">
        {p.title}
        {p.count !== undefined && <span className="row-count">{p.count}</span>}
      </h2>
      <div className="row-track" data-scroll="x">
        <div className="row-inner">{p.children}</div>
      </div>
    </FocusGroup>
  )
}

/** Plain message block for empty or failed screens. */
export function Notice(p: { icon?: ReactNode; title: string; body?: string; children?: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="notice" data-testid={p.testId ?? 'notice'}>
      {p.icon}
      <h2>{p.title}</h2>
      {p.body && <p>{p.body}</p>}
      {p.children && <div className="notice-actions">{p.children}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }): ReactNode {
  return (
    <div className="spinner-wrap" role="status" aria-label={label}>
      <div className="spinner" />
    </div>
  )
}
