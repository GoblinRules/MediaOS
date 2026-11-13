import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { orderIconCandidates, parseIconHtml, parseIconManifest, type IconCandidate } from '../../src/main/apps/icon-parse'

const pageUrl = 'https://service.test/watch/start'
const fixture = (name: string): string => readFileSync(`test/fixtures/app-icons/${name}`, 'utf8')

describe('site icon discovery parsing', () => {
  it('accepts mixed case rels and attributes in any order, including lists, quotes and entities', () => {
    const parsed = parseIconHtml(`
      <LINK SIZES='180x180' HREF='../touch.png?a=1&amp;b=2' REL='alternate APPLE-TOUCH-ICON'>
      <link href=//cdn.test/icon.png rel='shortcut ICON' sizes=any>
      <link rel=apple-touch-icon-precomposed href=https://static.test/old.png>
      <link rel='mask-icon icon' href='/mask.svg'>
      <link href='/app.webmanifest' rel='alternate MANIFEST'>`, pageUrl)
    expect(parsed.icons).toEqual([
      { url: 'https://service.test/touch.png?a=1&b=2', sizes: '180x180', type: '', purpose: 'any' },
      { url: 'https://cdn.test/icon.png', sizes: 'any', type: '', purpose: 'any' },
      { url: 'https://static.test/old.png', sizes: '180x180', type: '', purpose: 'any' },
    ])
    expect(parsed.manifests).toEqual(['https://service.test/app.webmanifest'])
  })
  it('ignores comments, scripts, style and text content that only resembles a link', () => {
    const fake = '<link rel="icon" href="/wrong.png">'
    const parsed = parseIconHtml(`<!-- ${fake} --><script>${fake}</script><style>${fake}</style>
      <textarea>${fake}</textarea><title>${fake}</title><link rel=icon href='/right.png'>`, pageUrl)
    expect(parsed.icons.map((i) => i.url)).toEqual(['https://service.test/right.png'])
  })
  it('recovers from broken tags, ignores incomplete tags and refuses missing or invalid hrefs', () => {
    const parsed = parseIconHtml(`<link<link<link href='/ok.png' rel=icon><link rel=icon><link rel=icon href=''>
      <link rel=icon href='https://['><link rel=not-icon href='/no.png'><link rel=icon href='/unfinished`, pageUrl)
    expect(parsed.icons.map((i) => i.url)).toEqual(['https://service.test/ok.png'])
  })
  it('scans a hostile 2 MB page in well under a second', () => {
    const html = '<link'.repeat(Math.ceil(2 * 1024 * 1024 / 5))
    const start = performance.now()
    expect(parseIconHtml(html, pageUrl)).toEqual({ icons: [], manifests: [] })
    expect(performance.now() - start).toBeLessThan(750)
  })
  it('resolves manifest icons against the manifest and prefers any when purposes are mixed', () => {
    const parsed = parseIconHtml(fixture('page.html'), pageUrl)
    expect(parsed.manifests).toEqual(['https://service.test/assets/site.webmanifest'])
    const icons = parseIconManifest(fixture('site.webmanifest'), parsed.manifests[0]!)
    expect(icons).toEqual([
      { url: 'https://service.test/assets/mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { url: 'https://service.test/assets/large.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    ])
    expect(orderIconCandidates(icons)[0]?.url).toBe('https://service.test/assets/large.png')
  })
  it.each(['{', 'null', '[]', '{"icons":{}}', '{"icons":[null,{}, {"src":1}, {"src":""}, {"src":"https://["}]}']) (
    'tolerates invalid or incomplete manifest %s', (value) => { expect(parseIconManifest(value, pageUrl)).toEqual([]) },
  )
  it('accepts relative, protocol-relative and absolute manifest sources and a default purpose', () => {
    const icons = parseIconManifest(JSON.stringify({ icons: [
      { src: 'icon.png', sizes: 'any' }, { src: '//cdn.test/icon.png', purpose: 'maskable monochrome' },
      { src: 'https://other.test/icon.svg', type: 'image/svg+xml' },
    ] }), 'https://service.test/assets/app.json')
    expect(icons.map((i) => i.url)).toEqual([
      'https://service.test/assets/icon.png', 'https://cdn.test/icon.png', 'https://other.test/icon.svg',
    ])
    expect(icons[0]).toMatchObject({ purpose: 'any', sizes: 'any' })
  })
})

describe('icon candidate preference', () => {
  it('orders large square rasters, other large rasters, SVG, small rasters and favicon; deduplicates URLs', () => {
    const candidate = (file: string, sizes = '', type = ''): IconCandidate =>
      ({ url: `https://service.test/${file}`, sizes, type, purpose: 'any' })
    const icons = [candidate('favicon.ico', '256x256'), candidate('small.png', '64x64'), candidate('icon.svg', 'any'),
      candidate('rectangle.png', '600x400'), candidate('medium.png', '180x180'), candidate('largest.png', '32x32 512x512'),
      candidate('tiny.png', '16x16'), candidate('unknown.png'), candidate('vector', 'any', 'image/svg+xml'),
      candidate('largest.png', '512x512'), candidate('wide.png', '1000x500')]
    expect(orderIconCandidates(icons).map((i) => new URL(i.url).pathname)).toEqual([
      '/largest.png', '/medium.png', '/wide.png', '/rectangle.png', '/icon.svg', '/vector',
      '/small.png', '/tiny.png', '/unknown.png', '/favicon.ico',
    ])
  })
  it('counts a touch icon without sizes as 180 px, so it beats a size-less shortcut icon listed first', () => {
    const parsed = parseIconHtml(`<link rel="shortcut icon" href="/site.ico"><link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon apple-touch-icon" href="/both.png">`, pageUrl)
    expect(parsed.icons.map((i) => i.sizes)).toEqual(['', '180x180', ''])
    expect(orderIconCandidates(parsed.icons).map((i) => new URL(i.url).pathname)).toEqual(['/touch.png', '/site.ico', '/both.png'])
  })
  it('uses a smaller maskable raster if all preferred any-purpose candidates fail', () => {
    const icons: IconCandidate[] = [
      { url: 'https://service.test/mask.png', sizes: '180x180', type: '', purpose: 'maskable' },
      { url: 'https://service.test/any.png', sizes: '180x180', type: '', purpose: 'any' },
    ]
    expect(orderIconCandidates(icons).map((i) => i.purpose)).toEqual(['any', 'maskable'])
  })
})
