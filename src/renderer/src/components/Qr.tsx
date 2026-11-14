// A QR code drawn as one SVG path: black squares on a white card with the standard 4-module quiet zone, so phone
// cameras read it even on a dark TV screen. If the text is too long for the encoder, nothing is drawn and the caller's
// written address is still there to type.
import { useMemo, type ReactNode } from 'react'
import { encodeQr } from '@shared/qr'

const QUIET = 4

export function Qr({ text, size = '16rem', testId }: { text: string; size?: string; testId?: string }): ReactNode {
  const drawing = useMemo(() => {
    try {
      const qr = encodeQr(text)
      const parts: string[] = []
      qr.modules.forEach((row, y) => {
        row.forEach((dark, x) => {
          if (dark) parts.push(`M${x + QUIET} ${y + QUIET}h1v1h-1z`)
        })
      })
      return { side: qr.size + QUIET * 2, path: parts.join('') }
    } catch {
      return null
    }
  }, [text])
  if (!drawing) return null
  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${drawing.side} ${drawing.side}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
      data-testid={testId}
    >
      <rect width={drawing.side} height={drawing.side} fill="#fff" />
      <path d={drawing.path} fill="#000" />
    </svg>
  )
}
