// Focus-zoom-free measuring for spatial focus. A focused key or button grows a little (CSS scale) and can then
// overlap its neighbour; measured that way, Norigin skips the neighbour (Right from the keyboard's Delete went to
// "@", never Done). Only the item's own scale is taken out: a parent's move (a scrolled row) still counts.

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The box without the node's own scale, kept centred where it is (CSS scales about the centre by default). */
export function unscaled(box: Box, transform: string): Box {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim())
  if (!m) return box
  const v = m[2]!.split(',').map(Number)
  // matrix(a, b, c, d, e, f) / matrix3d(a, b, 0, 0, c, d, ...): only a plain scale (no rotation or skew) is undone.
  const [sx, b, c, sy] = m[1] ? [v[0], v[1], v[4], v[5]] : [v[0], v[1], v[2], v[3]]
  if (!sx || !sy || b || c || !Number.isFinite(sx) || !Number.isFinite(sy)) return box
  const width = box.width / sx, height = box.height / sy
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
}
