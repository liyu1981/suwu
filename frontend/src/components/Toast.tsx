import { useEffect, useState } from 'react'

/**
 * A lightweight, auto-dismissing toast that slides up from the bottom of the
 * terminal pane. Used for copy confirmation and selection-mode feedback.
 */
export function Toast({ message, duration = 1500 }: { message: string; duration?: number }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), duration)
    return () => clearTimeout(t)
  }, [duration])

  if (!visible) return null

  return (
    <div className="pointer-events-none absolute bottom-8 left-1/2 z-50 -translate-x-1/2 animate-toast-in">
      <div className="glass-control menu-glass rounded-[6px] px-3 py-1.5 text-xs font-medium text-white/90 shadow-lg">
        {message}
      </div>
    </div>
  )
}
