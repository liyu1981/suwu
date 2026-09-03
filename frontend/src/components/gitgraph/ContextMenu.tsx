import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

interface ContextMenuProps {
  items: (ContextMenuItem | null)[][]
  position: { x: number; y: number }
  onClose: () => void
}

/**
 * Glass-styled context menu positioned at the click coordinates.
 * Items are grouped in arrays; null items render as dividers.
 */
export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Clamp position so menu stays in viewport
  const x = Math.min(position.x, window.innerWidth - 220)
  const y = Math.min(position.y, window.innerHeight - items.flat().length * 32 - 20)

  return (
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[180px] overflow-hidden rounded-2xl border border-white/[0.08] py-1 shadow-2xl menu-glass backdrop-blur-2xl"
      style={{ left: x, top: y }}
    >
      {items.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-1 border-t border-white/[0.06]" />}
          {group.map((item, ii) => {
            if (!item) return null
            return (
              <button
                key={ii}
                type="button"
                disabled={item.disabled}
                onClick={() => { item.onClick(); onClose() }}
                className={`group flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12px] tracking-[-0.01em] transition-all duration-100 active:scale-[0.98] ${
                  item.danger
                    ? 'text-red-400/80 hover:bg-red-500/[0.12] hover:text-red-300'
                    : 'text-white/70 hover:bg-white/[0.08] hover:text-white/90'
                } ${item.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                {item.icon && <span className="w-4 shrink-0 text-white/30 transition-colors group-hover:text-white/50">{item.icon}</span>}
                {item.label}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
