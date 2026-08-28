import { useEffect, useRef, useState } from 'react'
import type { PaneLayout, Rect } from './layout'

/** A vanished tile rendered at its last rect while it fades out. */
export type PaneGhost = { key: string; rect: Rect }

/**
 * Tracks the rects of the current panes; when tiles vanish (close), yields
 * ghosts at their last rects that fade out. React unmounts instantly, so the
 * ghost is what animates the exit. Ghosts clean themselves up on animation
 * end (the caller wires onAnimationEnd to the returned remover).
 */
export function usePaneGhosts(panes: PaneLayout[]) {
  const prevRectsRef = useRef(new Map<string, Rect>())
  const [ghosts, setGhosts] = useState<PaneGhost[]>([])

  useEffect(() => {
    const cur = new Map(panes.map((p) => [p.id, { x: p.x, y: p.y, w: p.w, h: p.h }]))
    const vanished: PaneGhost[] = []
    for (const [id, rect] of prevRectsRef.current) {
      if (!cur.has(id)) vanished.push({ key: `${id}-${Date.now()}-${Math.random()}`, rect })
    }
    prevRectsRef.current = cur
    if (vanished.length > 0) setGhosts((all) => [...all, ...vanished])
  }, [panes])

  const removeGhost = (key: string) => setGhosts((all) => all.filter((g) => g.key !== key))

  return { ghosts, removeGhost }
}
