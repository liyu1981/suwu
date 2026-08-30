// Pure functions for a tiling window-manager layout tree.
//
// The tree is made of leaf nodes (one terminal each) and split nodes that
// divide the available space horizontally (side-by-side) or vertically
// (stacked). Each child of a split carries a `size` weight used for flex
// layout and adjusted by dragging the dividers between siblings.

export type Direction = 'horizontal' | 'vertical'

/** Which side of the focused pane the new pane lands on. */
export type SplitSide = 'before' | 'after'

export type TileType = string

export type SplitChild = { node: LayoutNode; size: number }

export type SplitNode = { type: 'split'; id: string; direction: Direction; children: SplitChild[] }

export type LayoutNode =
  | { type: 'leaf'; id: string; tileType?: TileType; fontSize?: number; fontDefault?: number; initialPath?: string; params?: Record<string, string> }
  | SplitNode

let counter = 0

function newId(): string {
  counter = (counter + 1) % 1e9
  return `n${Date.now().toString(36)}${counter.toString(36)}`
}

export function createLeaf(id: string = newId(), tileType?: TileType, fontSize?: number, fontDefault?: number): LayoutNode {
  const leaf: LayoutNode = { type: 'leaf', id }
  if (tileType !== undefined) leaf.tileType = tileType
  if (fontSize !== undefined) leaf.fontSize = fontSize
  if (fontDefault !== undefined) leaf.fontDefault = fontDefault
  return leaf
}

export function createSplit(direction: Direction, a: LayoutNode, b: LayoutNode): LayoutNode {
  return {
    type: 'split',
    id: newId(),
    direction,
    children: [
      { node: a, size: 1 },
      { node: b, size: 1 },
    ],
  }
}

/** Immutably set the tileType (and optional font params) on a leaf node. */
export function setLeafType(
  root: LayoutNode,
  targetId: string,
  tileType: TileType,
  fontSize?: number,
  fontDefault?: number,
  initialPath?: string,
  params?: Record<string, string>,
): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf' && node.id === targetId) {
      const next: LayoutNode = { ...node, tileType }
      if (fontSize !== undefined) next.fontSize = fontSize
      if (fontDefault !== undefined) next.fontDefault = fontDefault
      if (initialPath !== undefined) next.initialPath = initialPath
      if (params !== undefined) next.params = params
      return next
    }
    if (node.type === 'split') {
      return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
    }
    return node
  }
  return walk(root)
}

/** Immutably set the fontSize on a leaf node. */
export function setLeafFontSize(root: LayoutNode, targetId: string, fontSize: number): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf' && node.id === targetId) {
      return { ...node, fontSize }
    }
    if (node.type === 'split') {
      return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
    }
    return node
  }
  return walk(root)
}

/** Immutably set the initialPath on a leaf node (one-shot file path for viewer/filebrowser). */
export function setLeafInitialPath(root: LayoutNode, targetId: string, initialPath: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf' && node.id === targetId) {
      return { ...node, initialPath }
    }
    if (node.type === 'split') {
      return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
    }
    return node
  }
  return walk(root)
}

/** Look up a leaf node by id. */
export function findLeaf(root: LayoutNode | null, id: string): LayoutNode | null {
  if (!root) return null
  if (root.type === 'leaf') return root.id === id ? root : null
  for (const c of root.children) {
    const hit = findLeaf(c.node, id)
    if (hit) return hit
  }
  return null
}

/** Replace the leaf `targetId` with a split containing it plus a new leaf. */
export function splitAt(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
  side: SplitSide = 'after',
): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node
      const peer = createLeaf()
      return side === 'before'
        ? createSplit(direction, peer, node)
        : createSplit(direction, node, peer)
    }
    return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
  }
  return walk(root)
}

/** Like splitAt but also returns the id of the newly created leaf. */
export function splitAtWithId(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
  side: SplitSide = 'after',
): { next: LayoutNode; newLeafId: string } {
  let newLeafId = ''
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node
      const peer = createLeaf()
      newLeafId = peer.id
      return side === 'before'
        ? createSplit(direction, peer, node)
        : createSplit(direction, node, peer)
    }
    return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
  }
  return { next: walk(root), newLeafId }
}

/** Remove the leaf `targetId`, collapsing splits that drop below two children. Returns null when empty. */
export function closeAt(root: LayoutNode, targetId: string): LayoutNode | null {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'leaf') {
      return node.id === targetId ? null : node
    }
    const children: SplitChild[] = []
    for (const c of node.children) {
      const n = walk(c.node)
      if (n) children.push({ node: n, size: c.size })
    }
    if (children.length === 0) return null
    if (children.length === 1) return children[0].node
    return { type: 'split', id: node.id, direction: node.direction, children }
  }
  return walk(root)
}

/** Leaf ids in rendering order (for focus navigation). */
export function leaves(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.id]
  return node.children.flatMap((c) => leaves(c.node))
}

/**
 * Split the focused leaf (or the first leaf when none/focused is gone) and
 * return the new tree plus the leaf id to focus (the newly created one).
 * An empty tree yields a single new leaf. Shared by the header split buttons
 * and the keyboard/hover split actions.
 */
export function splitAndFocus(
  root: LayoutNode | null,
  focusedId: string,
  direction: Direction,
  side: SplitSide = 'after',
): { next: LayoutNode; focus: string } {
  if (!root) {
    const leaf = createLeaf()
    return { next: leaf, focus: leaf.id }
  }
  const ids = leaves(root)
  const target = focusedId && ids.includes(focusedId) ? focusedId : ids[0]
  if (!target) return { next: root, focus: focusedId }
  const { next, newLeafId } = splitAtWithId(root, target, direction, side)
  return { next, focus: newLeafId }
}

/** Focus a sibling of `currentId`, wrapping around; -1 / +1 offset. */
export function focusByOffset(root: LayoutNode | null, currentId: string, offset: number): string {
  const ids = leaves(root)
  if (ids.length === 0) return ''
  const idx = ids.indexOf(currentId)
  if (idx === -1) return ids[0]
  return ids[(idx + offset + ids.length) % ids.length]
}

/** Direction to move a tile in. */
export type MoveDir = 'left' | 'right' | 'up' | 'down'

/**
 * Swap the positions of two leaves anywhere in the tree, keeping the size
 * weights attached to their slots: after a swap each leaf occupies the
 * other's exact rect. Only leaf ids change, so the pane renderer (keyed by
 * leaf id) repositions the existing iframes instead of remounting them.
 */
export function swapLeaves(root: LayoutNode, a: string, b: string): LayoutNode {
  // Collect full leaf data for both targets so we can swap everything.
  const leafA = findLeaf(root, a)
  const leafB = findLeaf(root, b)
  if (!leafA || !leafB || leafA.type !== 'leaf' || leafB.type !== 'leaf') return root

  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id === a) return { ...leafB, id: a }
      if (node.id === b) return { ...leafA, id: b }
      return node
    }
    return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
  }
  return walk(root)
}

/**
 * Find the nearest tile geometrically adjacent to `id` in the given
 * direction: entirely beyond its edge, overlapping it along the perpendicular
 * axis, with the smallest gap. Returns null when no neighbor exists (the
 * tile is already at that edge), which callers treat as a no-op.
 */
export function findNeighborRect(
  panes: PaneLayout[],
  id: string,
  dir: MoveDir,
): PaneLayout | null {
  const self = panes.find((p) => p.id === id)
  if (!self) return null
  // Rounding tolerance: computeTiling rounds shared seams to identical px.
  const EPS = 1
  let best: PaneLayout | null = null
  let bestDist = Infinity
  for (const r of panes) {
    if (r.id === id) continue
    let ok = false
    let dist = 0
    switch (dir) {
      case 'left':
        ok = r.x + r.w <= self.x + EPS && r.y < self.y + self.h - EPS && r.y + r.h > self.y + EPS
        dist = self.x - (r.x + r.w)
        break
      case 'right':
        ok = r.x >= self.x + self.w - EPS && r.y < self.y + self.h - EPS && r.y + r.h > self.y + EPS
        dist = r.x - (self.x + self.w)
        break
      case 'up':
        ok = r.y + r.h <= self.y + EPS && r.x < self.x + self.w - EPS && r.x + r.w > self.x + EPS
        dist = self.y - (r.y + r.h)
        break
      case 'down':
        ok = r.y >= self.y + self.h - EPS && r.x < self.x + self.w - EPS && r.x + r.w > self.x + EPS
        dist = r.y - (self.y + self.h)
        break
    }
    if (ok && dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  return best
}

/** Apply `fn` to the children of the split with the given id. */
export function updateSplitAt(
  root: LayoutNode,
  splitId: string,
  fn: (children: SplitChild[]) => SplitChild[],
): LayoutNode {
  if (root.type === 'leaf') return root
  if (root.id === splitId) return { ...root, children: fn(root.children) }
  return { ...root, children: root.children.map((c) => ({ ...c, node: updateSplitAt(c.node, splitId, fn) })) }
}

/** Width of the draggable strip between two siblings, in px. */
export const GUTTER = 8

/** Pixel-space rectangle relative to the tiling viewport. */
export type Rect = { x: number; y: number; w: number; h: number }

export type PaneLayout = Rect & { id: string }

export type DividerSpec = {
  splitId: string
  /** Index of the left/top sibling of this divider inside its split. */
  index: number
  /** Main axis of the owning split: 'x' = side-by-side, 'y' = stacked. */
  axis: 'x' | 'y'
  rect: Rect
  /** Full main-axis extent of the owning split in px (for drag deltas). */
  length: number
}

/** Find the split node with the given id anywhere in the tree. */
export function findSplit(root: LayoutNode | null, id: string): SplitNode | null {
  if (!root) return null
  if (root.type === 'split') {
    if (root.id === id) return root
    for (const c of root.children) {
      const hit = findSplit(c.node, id)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Flatten the layout tree into absolute pixel rects for rendering.
 *
 * Panes and dividers are positioned absolutely relative to a viewport of the
 * given size; edge coordinates are rounded so neighboring rects share exact
 * seams instead of leaving sub-pixel gaps or overlaps.
 */
export function computeTiling(
  root: LayoutNode | null,
  width: number,
  height: number,
): { panes: PaneLayout[]; dividers: DividerSpec[] } {
  const panes: PaneLayout[] = []
  const dividers: DividerSpec[] = []
  if (!root || width <= 0 || height <= 0) return { panes, dividers }

  const rd = Math.round
  const walk = (node: LayoutNode, x: number, y: number, w: number, h: number) => {
    if (node.type === 'leaf') {
      panes.push({
        id: node.id,
        x: rd(x),
        y: rd(y),
        w: rd(x + w) - rd(x),
        h: rd(y + h) - rd(y),
      })
      return
    }

    const kids = node.children
    const n = kids.length
    if (n === 0) return
    // 'horizontal' means side-by-side siblings, i.e. the main axis is x.
    const horizontal = node.direction === 'horizontal'
    const start = horizontal ? x : y
    const span = horizontal ? w : h
    const totalWeight = kids.reduce((acc, k) => acc + k.size, 0)
    if (totalWeight <= 0) return

    let used = 0
    kids.forEach((child, i) => {
      const offset = start + used
      const share =
        i === n - 1
          ? start + span - offset
          : ((span - (n - 1) * GUTTER) * child.size) / totalWeight

      walk(child.node, horizontal ? offset : x, horizontal ? y : offset, horizontal ? share : w, horizontal ? h : share)

      used += share + GUTTER

      if (i < n - 1) {
        const bx = horizontal ? offset + share : x
        const by = horizontal ? y : offset + share
        const bw = horizontal ? rd(offset + share + GUTTER) - rd(offset + share) : rd(x + w) - rd(x)
        const bh = horizontal ? rd(y + h) - rd(y) : rd(offset + share + GUTTER) - rd(offset + share)
        dividers.push({ splitId: node.id, index: i, axis: horizontal ? 'x' : 'y', rect: { x: rd(bx), y: rd(by), w: bw, h: bh }, length: span })
      }
    })
  }
  walk(root, 0, 0, width, height)
  return { panes, dividers }
}
