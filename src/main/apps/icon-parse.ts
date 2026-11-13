/** Discovery hints only: the store checks the downloaded bytes before serving an icon. */
export interface IconCandidate {
  url: string
  sizes: string
  type: string
  purpose: 'any' | 'maskable'
  fallback?: boolean
}

function absolute(value: string, base: string): string | undefined {
  try { return new URL(value, base).href } catch { return undefined }
}

function entities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw: string, code: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
    if (!code.startsWith('#')) return named[code.toLowerCase()] ?? raw
    const number = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : raw
  })
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  let i = 0
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i]!)) i++
    const start = i
    while (i < tag.length && !/[\s=/'"<>]/.test(tag[i]!)) i++
    if (start === i) { i++; continue }
    const name = tag.slice(start, i).toLowerCase()
    while (i < tag.length && /\s/.test(tag[i]!)) i++
    let value = ''
    if (tag[i] === '=') {
      i++
      while (i < tag.length && /\s/.test(tag[i]!)) i++
      const quote = tag[i] === '"' || tag[i] === "'" ? tag[i++] : undefined
      const from = i
      while (i < tag.length && (quote ? tag[i] !== quote : !/\s/.test(tag[i]!))) i++
      value = tag.slice(from, i)
      if (quote) i++
    }
    if (!(name in result)) result[name] = entities(value)
  }
  return result
}

/** One forward pass, including for broken tags such as <link<link<link. Scripts are never interpreted. */
export function parseIconHtml(html: string, pageUrl: string): { icons: IconCandidate[]; manifests: string[] } {
  const icons: IconCandidate[] = [], manifests: string[] = []
  const lower = html.toLowerCase()
  let i = 0
  while (i < html.length) {
    const start = html.indexOf('<', i)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    i = start + 1
    let quote: string | undefined
    while (i < html.length) {
      const ch = html[i]!
      if (quote) { if (ch === quote) quote = undefined }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '<' || ch === '>') break
      i++
    }
    if (html[i] !== '>') continue
    const tag = html.slice(start + 1, i++)
    const name = /^[a-z][a-z0-9:-]*/i.exec(tag)?.[0].toLowerCase()
    if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
      const end = lower.indexOf(`</${name}`, i)
      i = end < 0 ? html.length : end
    }
    if (name !== 'link') continue
    const attr = attributes(tag.slice(4))
    const rels = (attr.rel ?? '').toLowerCase().split(/\s+/)
    const url = attr.href?.trim() ? absolute(attr.href.trim(), pageUrl) : undefined
    if (!url || rels.includes('mask-icon')) continue
    if (rels.includes('manifest')) manifests.push(url)
    if (rels.some((rel) => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'].includes(rel))) {
      // Apple's touch icons are 180 px unless they say otherwise, so one without sizes beats a small favicon.
      const touch = !rels.includes('icon') && !attr.sizes?.trim()
      icons.push({ url, sizes: touch ? '180x180' : attr.sizes ?? '', type: attr.type ?? '', purpose: 'any' })
    }
  }
  return { icons, manifests }
}

export function parseIconManifest(json: string, manifestUrl: string): IconCandidate[] {
  let document: unknown
  try { document = JSON.parse(json) } catch { return [] }
  if (!record(document) || !Array.isArray(document.icons)) return []
  const result: IconCandidate[] = []
  for (const icon of document.icons) {
    if (!record(icon) || typeof icon.src !== 'string' || !icon.src.trim()) continue
    const purposes = typeof icon.purpose === 'string' ? icon.purpose.toLowerCase().split(/\s+/) : ['any']
    if (!purposes.includes('any') && !purposes.includes('maskable')) continue
    const url = absolute(icon.src, manifestUrl)
    if (url) result.push({ url, sizes: typeof icon.sizes === 'string' ? icon.sizes : '',
      type: typeof icon.type === 'string' ? icon.type : '', purpose: purposes.includes('any') ? 'any' : 'maskable' })
  }
  return result
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function rank(icon: IconCandidate): { group: number; size: number } {
  const path = new URL(icon.url).pathname.toLowerCase()
  if (icon.fallback || path.endsWith('/favicon.ico')) return { group: 4, size: 0 }
  if (icon.type.toLowerCase() === 'image/svg+xml' || path.endsWith('.svg')) return { group: 2, size: 0 }
  let square = 0, largest = 0
  for (const size of icon.sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) continue
    const w = Number(match[1]), h = Number(match[2])
    if (!Number.isFinite(w * h)) continue
    largest = Math.max(largest, Math.max(w, h))
    if (w === h) square = Math.max(square, w)
  }
  if (square >= 120) return { group: 0, size: square }
  return { group: largest >= 120 ? 1 : 3, size: largest }
}

export function orderIconCandidates(icons: readonly IconCandidate[]): IconCandidate[] {
  const ranked = icons.map((icon) => ({ icon, ...rank(icon) }))
  ranked.sort((a, b) => a.group - b.group || Number(a.icon.purpose === 'maskable') - Number(b.icon.purpose === 'maskable') ||
    b.size - a.size)
  const seen = new Set<string>()
  return ranked.filter(({ icon }) => !seen.has(icon.url) && !!seen.add(icon.url)).map(({ icon }) => icon)
}
