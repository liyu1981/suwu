/**
 * Shared auto-refresh interval dropdown.
 * Used by GitGraphPage, FileViewerPage, and ForwardPanel.
 */

import { useEffect, useRef, useState } from 'react'
import { AUTO_REFRESH_INTERVALS } from '../lib/constants'

interface AutoRefreshDropdownProps {
  value: number
  onChange: (ms: number) => void
}

export function useAutoRefreshDropdown() {
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!showDropdown) return
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showDropdown])

  const toggle = () => {
    if (showDropdown) {
      setShowDropdown(false)
    } else if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 2, left: rect.left })
      setShowDropdown(true)
    }
  }

  return { showDropdown, dropdownPos, dropdownRef, btnRef, toggle, close: () => setShowDropdown(false) }
}

export function AutoRefreshDropdown({ value, onChange, dropdownRef, dropdownPos }: AutoRefreshDropdownProps & {
  dropdownRef: React.RefObject<HTMLDivElement | null>
  dropdownPos: { top: number; left: number }
}) {
  return (
    <div
      ref={dropdownRef}
      className="fixed z-[9999] w-28 rounded border border-white/10 bg-black/95 py-1 shadow-xl backdrop-blur-xl"
      style={{ top: dropdownPos.top, left: dropdownPos.left }}
    >
      {AUTO_REFRESH_INTERVALS.map((iv) => (
        <button
          key={iv.value}
          type="button"
          onClick={() => onChange(iv.value)}
          className={`flex w-full items-center px-3 py-1 text-left transition hover:bg-white/10 ${
            value === iv.value ? 'text-green-400' : 'text-white/60'
          }`}
        >
          {iv.label}
          {value === iv.value && iv.value > 0 && (
            <span className="ml-auto text-[10px] text-green-400/60">●</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** Trigger button for the auto-refresh dropdown. */
export function AutoRefreshTrigger({ btnRef, isActive, onClick }: {
  btnRef: React.RefObject<HTMLButtonElement | null>
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      onClick={onClick}
      className={`grid h-5 w-4 place-items-center rounded transition hover:bg-white/10 ${
        isActive ? 'text-green-400' : 'text-white/40 hover:text-white/60'
      }`}
      title="Auto-refresh interval"
    >
      ▾
    </button>
  )
}
