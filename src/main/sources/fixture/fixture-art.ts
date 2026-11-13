// Procedural SVG artwork for the demo library (no copyrighted images are shipped).
import type { ImageKind } from '@shared/media-types'
import { hash, rng } from './fixture-data'

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`
}

/** Break a title into at most 3 lines of roughly `max` characters. */
function wrap(title: string, max: number): string[] {
  const words = title.toUpperCase().split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur)
      cur = w
    } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3)
}

/** Scene drawn in a W x H box. `seed` picks style and colours; `variant` nudges it (episodes of one show). */
function scene(seed: number, W: number, H: number, variant = 0): string {
  const r = rng(seed + variant * 7919)
  const base = hash(String(seed)) % 360
  const hue = base
  const hue2 = base + 30 + (seed % 90)
  const style = seed % 4
  const parts: string[] = []
  parts.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="${hsl(hue, 55, 22)}"/><stop offset="1" stop-color="${hsl(hue2, 60, 9)}"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${hsl(hue + 40, 90, 70)}" stop-opacity="0.9"/>
    <stop offset="1" stop-color="${hsl(hue + 40, 90, 60)}" stop-opacity="0"/></radialGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient></defs>`)
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`)
  const sunX = W * (0.3 + r() * 0.4)
  const sunY = H * (0.25 + r() * 0.2)
  const sunR = Math.min(W, H) * (0.16 + r() * 0.1)
  if (style === 0) {
    // Sun over layered hills.
    parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${sunR * 2.2}" fill="url(#glow)"/>`)
    parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="${hsl(hue + 40, 85, 66)}"/>`)
    for (let layer = 0; layer < 4; layer++) {
      const y0 = H * (0.5 + layer * 0.1)
      let d = `M0 ${H} L0 ${y0}`
      const steps = 6
      for (let k = 1; k <= steps; k++) d += ` L${(W * k) / steps} ${y0 - r() * H * 0.12}`
      d += ` L${W} ${H} Z`
      parts.push(`<path d="${d}" fill="${hsl(hue2 + layer * 8, 45, 18 - layer * 3)}"/>`)
    }
  } else if (style === 1) {
    // Rolling waves.
    parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${sunR * 0.7}" fill="${hsl(hue + 180, 30, 85)}" opacity="0.85"/>`)
    for (let layer = 0; layer < 6; layer++) {
      const y0 = H * (0.45 + layer * 0.09)
      const amp = H * (0.02 + r() * 0.03)
      const len = W / (1.5 + r() * 2)
      let d = `M0 ${y0}`
      for (let x = 0; x <= W + len; x += len / 2) d += ` Q${x + len / 4} ${y0 + (Math.round(x / (len / 2)) % 2 ? amp : -amp)} ${x + len / 2} ${y0}`
      d += ` L${W} ${H} L0 ${H} Z`
      parts.push(`<path d="${d}" fill="${hsl(hue + 160 + layer * 6, 50, 30 - layer * 4)}" opacity="0.92"/>`)
    }
  } else if (style === 2) {
    // Orbits.
    const cx = W * 0.5
    const cy = H * 0.42
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${Math.min(W, H) * 0.5}" fill="url(#glow)" opacity="0.5"/>`)
    for (let k = 0; k < 7; k++) {
      const rr = Math.min(W, H) * (0.1 + k * 0.07)
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rr * 1.5}" ry="${rr * 0.55}" fill="none" stroke="${hsl(hue + k * 12, 70, 70)}"
        stroke-opacity="${0.75 - k * 0.08}" stroke-width="${2 + (k % 3)}" transform="rotate(${-18 + r() * 8} ${cx} ${cy})"/>`)
      const a = r() * Math.PI * 2
      parts.push(`<circle cx="${cx + Math.cos(a) * rr * 1.5}" cy="${cy + Math.sin(a) * rr * 0.55}" r="${3 + r() * 6}" fill="${hsl(hue + 60, 90, 80)}"/>`)
    }
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${Math.min(W, H) * 0.07}" fill="${hsl(hue + 30, 90, 75)}"/>`)
  } else {
    // Skyline at dusk.
    parts.push(`<circle cx="${sunX}" cy="${sunY + H * 0.1}" r="${sunR * 2.5}" fill="url(#glow)"/>`)
    let x = 0
    while (x < W) {
      const bw = W * (0.05 + r() * 0.08)
      const bh = H * (0.18 + r() * 0.35)
      parts.push(`<rect x="${x}" y="${H - bh}" width="${bw + 1}" height="${bh}" fill="${hsl(hue2, 35, 11 + r() * 6)}"/>`)
      for (let wy = H - bh + 10; wy < H - 10; wy += 16) {
        for (let wx = x + 6; wx < x + bw - 8; wx += 12) {
          if (r() < 0.22) parts.push(`<rect x="${wx}" y="${wy}" width="5" height="7" fill="${hsl(hue + 45, 95, 72)}" opacity="0.85"/>`)
        }
      }
      x += bw
    }
  }
  parts.push(`<rect width="${W}" height="${H}" fill="url(#shade)"/>`)
  return parts.join('')
}

export interface ArtSubject {
  /** Stable seed text, usually the show or movie id plus title. */
  seedText: string
  title: string
  /** Small line above the title on posters, e.g. "SEASON 2". */
  kicker?: string
  variant?: number
}

export function renderArt(subject: ArtSubject, kind: ImageKind, w: number, h: number): string {
  const seed = hash(subject.seedText)
  const wide = kind === 'backdrop' || kind === 'thumb'
  const W = wide ? 1280 : 400
  const H = wide ? 720 : 600
  let body = scene(seed, W, H, subject.variant ?? 0)
  if (kind === 'poster') {
    const lines = wrap(subject.title, 13)
    // Georgia bold capitals are about 0.8em wide plus letter spacing; keep the longest line inside a 360px band.
    const longest = Math.max(...lines.map((l) => l.length))
    const size = Math.max(22, Math.min(48, Math.floor(360 / (longest * 0.8 + 0.1))))
    const startY = H - 50 - (lines.length - 1) * (size + 6)
    if (subject.kicker) {
      body += `<text x="${W / 2}" y="${startY - size - 6}" text-anchor="middle" font-family="Segoe UI, Inter, Arial, sans-serif"
        font-size="18" letter-spacing="6" fill="#fff" fill-opacity="0.8">${esc(subject.kicker.toUpperCase())}</text>`
    }
    lines.forEach((line, i) => {
      body += `<text x="${W / 2}" y="${startY + i * (size + 6)}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-weight="700" font-size="${size}" letter-spacing="2" fill="#fff">${esc(line)}</text>`
    })
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${W} ${H}"
    preserveAspectRatio="xMidYMid slice">${body}</svg>`
}
