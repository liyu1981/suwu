import { useCallback, useMemo, useRef, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { cn } from '@/lib/utils'

export interface ComboboxItem {
  /** Display label. */
  label: string
  /** Stored value. */
  value: string
}

interface ComboboxProps {
  items: ComboboxItem[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** When true the input is editable; otherwise acts as a plain dropdown. */
  editable?: boolean
  className?: string
}

/**
 * A lightweight combobox: Popover + filterable list + optional free-form input.
 *
 * When `editable` is true the user can type a custom value that isn't in the
 * list. The component always calls `onChange` with the confirmed value (on
 * click or Enter).
 */
export function Combobox({
  items,
  value,
  onChange,
  placeholder = 'Select…',
  editable = false,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Find the label for the current value.
  const currentLabel = useMemo(
    () => items.find((i) => i.value === value)?.label ?? (editable ? value : ''),
    [items, value, editable],
  )

  const filtered = useMemo(() => {
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q))
  }, [items, query])

  const select = useCallback(
    (v: string) => {
      onChange(v)
      setOpen(false)
      setQuery('')
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (editable && query) {
          select(query)
        } else if (filtered.length > 0) {
          select(filtered[0].value)
        }
      } else if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
    },
    [editable, query, filtered, select],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded border border-white/10 bg-black/30 px-2',
            'text-xs text-popover-foreground outline-none transition-colors',
            'hover:border-white/20 focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !currentLabel && 'text-muted-foreground')}>
            {currentLabel || placeholder}
          </span>
          <svg className="h-3 w-3 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        {editable && (
          <div className="border-b border-white/10 p-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="h-7 w-full rounded-sm bg-transparent px-2 text-xs text-popover-foreground outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
        )}
        <div className="max-h-60 overflow-auto scrollbar-thin p-0.5">
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {editable ? (
                <span>
                  Press <kbd className="mx-0.5 rounded bg-white/10 px-1 py-0.5 text-[10px]">Enter</kbd> to use &quot;{query}&quot;
                </span>
              ) : (
                'No matches'
              )}
            </div>
          )}
          {filtered.map((item) => (
            <button
              key={item.value}
              type="button"
              className={cn(
                'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs',
                'outline-none transition-colors hover:bg-white/10 hover:text-popover-foreground',
                item.value === value && 'bg-white/10 text-popover-foreground',
              )}
              onClick={() => select(item.value)}
            >
              <span className="mr-2 flex h-3.5 w-3.5 items-center justify-center">
                {item.value === value && (
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
