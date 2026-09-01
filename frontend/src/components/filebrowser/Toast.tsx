import { useEffect, useState } from 'react'

interface ToastProps {
  message: string
  type?: 'success' | 'error' | 'info'
  duration?: number
  onClose: () => void
}

export function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(onClose, 350)
    }, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  const bgColor = {
    success: 'border-green-500/20 text-green-300/90',
    error: 'border-red-500/20 text-red-300/90',
    info: 'border-sky-500/20 text-sky-300/90',
  }[type]

  const iconBg = {
    success: 'bg-green-500/15',
    error: 'bg-red-500/15',
    info: 'bg-sky-500/15',
  }[type]

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-2.5 rounded-xl border border-white/[0.06] px-3.5 py-2.5 shadow-2xl menu-glass backdrop-blur-2xl transition-all duration-300 ${
        visible
          ? 'translate-y-0 opacity-100 scale-100'
          : 'translate-y-2 opacity-0 scale-95'
      } ${bgColor}`}
      style={{
        transitionTimingFunction: visible ? 'cubic-bezier(0.32, 0.72, 0, 1)' : 'cubic-bezier(0.4, 0, 1, 1)',
      }}
    >
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${iconBg}`}>
        {type === 'success' && (
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        {type === 'error' && (
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        )}
        {type === 'info' && (
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
        )}
      </span>
      <span className="text-[12px] font-medium tracking-[-0.01em]">{message}</span>
    </div>
  )
}
