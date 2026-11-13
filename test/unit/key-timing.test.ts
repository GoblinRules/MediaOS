import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { KeyTiming } from '@shared/key-timing'
import type { Action } from '@shared/actions'
import { keyToAction } from '@shared/actions'

describe('KeyTiming', () => {
  let out: string[]
  let kt: KeyTiming
  beforeEach(() => {
    vi.useFakeTimers()
    out = []
    kt = new KeyTiming((a: Action, i) => out.push(i.long ? `${a}!` : a))
  })
  afterEach(() => vi.useRealTimers())

  it('short Back fires back on release', () => {
    kt.down('back')
    expect(out).toEqual([])
    vi.advanceTimersByTime(300)
    kt.up('back')
    expect(out).toEqual(['back'])
  })

  it('long Back (>= 800 ms) fires Home once, at the threshold, and nothing on release', () => {
    kt.down('back')
    vi.advanceTimersByTime(799)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out).toEqual(['home!'])
    kt.down('back', true)
    vi.advanceTimersByTime(2000)
    kt.up('back')
    expect(out).toEqual(['home!'])
  })

  it('long Select opens the menu; short Select selects', () => {
    kt.down('select')
    kt.up('select')
    kt.down('select')
    vi.advanceTimersByTime(600)
    kt.up('select')
    expect(out).toEqual(['select', 'menu!'])
  })

  it('long Home opens recovery; short Home goes home', () => {
    kt.down('home')
    kt.up('home')
    kt.down('home')
    vi.advanceTimersByTime(1500)
    kt.up('home')
    expect(out).toEqual(['home', 'recovery!'])
  })

  it('arrows fire immediately, including auto-repeat', () => {
    kt.down('down')
    kt.down('down', true)
    kt.down('down', true)
    kt.up('down')
    expect(out).toEqual(['down', 'down', 'down'])
  })

  it('another key while Back is held cancels the pending Back', () => {
    kt.down('back')
    kt.down('left')
    vi.advanceTimersByTime(2000)
    kt.up('back')
    expect(out).toEqual(['left'])
  })

  it('cancel() forgets the held key', () => {
    kt.down('select')
    kt.cancel()
    vi.advanceTimersByTime(1000)
    kt.up('select')
    expect(out).toEqual([])
  })
})

describe('keyToAction', () => {
  it('maps dev and remote keys', () => {
    expect(keyToAction('ArrowUp', 'ArrowUp')).toBe('up')
    expect(keyToAction('Enter', 'Enter')).toBe('select')
    expect(keyToAction('Escape', 'Escape')).toBe('back')
    expect(keyToAction('Backspace', 'Backspace')).toBe('back')
    expect(keyToAction('F1', 'F1')).toBe('home')
    expect(keyToAction('BrowserHome', '')).toBe('home')
    expect(keyToAction('ColorF0Red', '')).toBe('home')
    expect(keyToAction('ContextMenu', 'ContextMenu')).toBe('menu')
    expect(keyToAction('m', 'KeyM')).toBe('menu')
    expect(keyToAction('MediaPlayPause', '')).toBe('playPause')
    expect(keyToAction('a', 'KeyA')).toBeUndefined()
    expect(keyToAction(' ', 'Space')).toBeUndefined()
  })
})
