// Pure functions for a tiling window-manager layout tree.
//
// The tree is made of leaf nodes (one terminal each) and split nodes that
// divide the available space horizontally (side-by-side) or vertically
// (stacked). Each child of a split carries a `size` weight used for flex
// layout and adjusted by dragging the dividers between siblings.

export type Direction = 'horizontal' | 'vertical'

export type SplitChild = { node: LayoutNode; size: number }

export type LayoutNode =
  | { type: 'leaf'; id: string }
  | { type: 'split'; id: string; direction: Direction; children: SplitChild[] }

let counter = 0

export function newId(): string {
  counter = (counter + 1) % 1e9
  return `n${Date.now().toString(36)}${counter.toString(36)}`
}

export function createLeaf(id: string = newId()): LayoutNode {
  return { type: 'leaf', id }
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

/** Replace the leaf `targetId` with a split containing it plus a new leaf. */
export function splitAt(root: LayoutNode, targetId: string, direction: Direction): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      if (node.id !== targetId) return node
      return createSplit(direction, node, createLeaf())
    }
    return { ...node, children: node.children.map((c) => ({ ...c, node: walk(c.node) })) }
  }
  return walk(root)
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

/** Focus a sibling of `currentId`, wrapping around; -1 / +1 offset. */
export function focusByOffset(root: LayoutNode | null, currentId: string, offset: number): string {
  const ids = leaves(root)
  if (ids.length === 0) return ''
  const idx = ids.indexOf(currentId)
  if (idx === -1) return ids[0]
  return ids[(idx + offset + ids.length) % ids.length]
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

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
