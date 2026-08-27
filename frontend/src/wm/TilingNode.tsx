import { Fragment, type PointerEvent as ReactPointerEvent } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { focusedIdAtom, layoutAtom } from './atoms'
import { clamp, updateSplitAt, type Direction, type LayoutNode, type SplitChild } from './layout'

function LeafPane({ id }: { id: string }) {
  const focused = useAtomValue(focusedIdAtom) === id
  const setFocused = useSetAtom(focusedIdAtom)

  return (
    <div
      className={`relative h-full w-full min-h-0 min-w-0 overflow-hidden rounded-[6px] shadow-[0_8px_32px_rgb(0_0_0/0.25)] transition-shadow ${
        focused ? 'ring-2 ring-inset ring-sky-400/90' : 'ring-1 ring-inset ring-white/15'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setFocused(id)
      }}
    >
      <iframe
        src="/term"
        title={`terminal-${id}`}
        data-pane={id}
        className="h-full w-full border-0 bg-transparent rounded-[6px] overflow-hidden"
      />
    </div>
  )
}

function Divider({ split, index }: { split: { id: string; direction: Direction; children: SplitChild[] }; index: number }) {
  const setLayout = useSetAtom(layoutAtom)
  const horizontal = split.direction === 'horizontal'

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)

    const container = el.parentElement
    if (!container) return

    const start = horizontal ? e.clientX : e.clientY
    const totalPx = horizontal ? container.clientWidth : container.clientHeight
    const a = split.children[index]
    const b = split.children[index + 1]
    const totalFlex = a.size + b.size
    const min = Math.min(0.15, totalFlex / 4)

    const onMove = (ev: PointerEvent) => {
      const delta = (horizontal ? ev.clientX : ev.clientY) - start
      const deltaFlex = totalPx > 0 ? (delta / totalPx) * totalFlex : 0
      const na = clamp(a.size + deltaFlex, min, totalFlex - min)
      const nb = totalFlex - na
      setLayout((layout) =>
        layout ? updateSplitAt(layout, split.id, (children) =>
          children.map((c, i) =>
            i === index ? { ...c, size: na } : i === index + 1 ? { ...c, size: nb } : c,
          ),
        ) : layout,
      )
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`shrink-0 bg-white/5 hover:bg-sky-400/60 active:bg-sky-400 ${
        horizontal ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'
      }`}
      onPointerDown={onPointerDown}
    />
  )
}

function SplitPane({ split }: { split: { id: string; direction: Direction; children: SplitChild[] } }) {
  const horizontal = split.direction === 'horizontal'
  return (
    <div className={`flex h-full w-full min-h-0 min-w-0 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      {split.children.map((child, i) => (
        <Fragment key={child.node.id}>
          {i > 0 && <Divider split={split} index={i - 1} />}
          <div className="min-h-0 min-w-0" style={{ flexGrow: child.size, flexBasis: 0 }}>
            <TilingNode node={child.node} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

export default function TilingNode({ node }: { node: LayoutNode | null }) {
  if (!node) return null
  if (node.type === 'leaf') return <LeafPane id={node.id} />
  return <SplitPane split={node} />
}