import { describe, expect, it } from 'vitest'
import { unscaled } from '../../src/renderer/src/input/unscaled'

describe('measuring focus without the focus zoom', () => {
  it('takes a focused key back to its normal size about its centre, so it no longer overlaps Done', () => {
    // The keyboard's Delete key (210 wide) zoomed by 1.08: its right edge passed Done's left edge (1006).
    const zoomed = { left: 791 - 8.4, top: 734 - 1.36, width: 226.8, height: 36.72 }
    const box = unscaled(zoomed, 'matrix(1.08, 0, 0, 1.08, 0, 0)')
    expect(box.left).toBeCloseTo(791)
    expect(box.top).toBeCloseTo(734)
    expect(box.width).toBeCloseTo(210)
    expect(box.height).toBeCloseTo(34)
    expect(box.left + box.width).toBeLessThan(1006)
    const deep = unscaled(zoomed, 'matrix3d(1.08, 0, 0, 0, 0, 1.08, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')
    expect(deep.width).toBeCloseTo(210)
  })
  it('leaves boxes alone with no transform, a rotation or a bad value', () => {
    const box = { left: 10, top: 20, width: 100, height: 50 }
    expect(unscaled(box, 'none')).toBe(box)
    expect(unscaled(box, 'matrix(0.98, 0.17, -0.17, 0.98, 0, 0)')).toBe(box)
    expect(unscaled(box, 'matrix(0, 0, 0, 0, 0, 0)')).toBe(box)
    expect(unscaled(box, 'scale(2)')).toBe(box)
  })
})
