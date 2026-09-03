import { useCallback, useMemo, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from './popover'
import { cn } from '@/lib/utils'
import type { ThemePreset } from '@/store/themePresets'

/** Small color swatch — 4×4 rounded square. */
function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('inline-block h-3 w-3 shrink-0 rounded-sm border border-white/10', className)}
      style={{ backgroundColor: color }}
    />
  )
}

interface ThemeSelectProps {
  presets: ThemePreset[]
  /** Currently active preset id, or null for "Custom". */
  value: string | null
  onChange: (presetId: string) => void
  /** Labels for the ANSI palette swatches shown in each row. */
  swatchLabels?: string[]
  className?: string
}

/**
 * A dropdown that shows each theme preset with a name + ANSI color swatch
 * preview. The currently active item is check-marked.
 */
export function ThemeSelect({
  presets,
  value,
  onChange,
  className,
}: ThemeSelectProps) {
  const [open, setOpen] = useState(false)

  const activeName = useMemo(
    () => presets.find((p) => p.id === value)?.name ?? null,
    [presets, value],
  )

  const select = useCallback(
    (id: string) => {
      onChange(id)
      setOpen(false)
    },
    [onChange],
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
            className,
          )}
        >
          <span className={cn('truncate', !activeName && 'text-muted-foreground')}>
            {activeName ?? 'Custom'}
          </span>
          <svg className="h-3 w-3 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="max-h-80 overflow-auto p-0.5">
          {/* Custom option */}
          {!value && (
            <div className="flex items-center gap-2 rounded-sm bg-white/10 px-2 py-1.5">
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span className="text-xs text-popover-foreground">Custom</span>
            </div>
          )}
          {presets.map((preset) => {
            const isActive = preset.id === value
            const t = preset.theme
            return (
              <button
                key={preset.id}
                type="button"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left',
                  'outline-none transition-colors hover:bg-white/10 hover:text-popover-foreground',
                  isActive && 'bg-white/10 text-popover-foreground',
                )}
                onClick={() => select(preset.id)}
              >
                {/* Check mark / spacer */}
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {isActive ? (
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </span>
                {/* Name */}
                <span className="min-w-0 shrink-0 text-xs">{preset.name}</span>
                {/* Color swatches — bg preview + 8 normal ANSI + 8 bright ANSI */}
                <span className="ml-auto flex shrink-0 items-center gap-px">
                  {/* Background swatch (with a subtle border to show it's special) */}
                  <Swatch
                    color={t.background.slice(0, 7)}
                    className="ring-1 ring-white/20"
                  />
                  {/* Normal 8 */}
                  <Swatch color={t.black} />
                  <Swatch color={t.red} />
                  <Swatch color={t.green} />
                  <Swatch color={t.yellow} />
                  <Swatch color={t.blue} />
                  <Swatch color={t.magenta} />
                  <Swatch color={t.cyan} />
                  <Swatch color={t.white} />
                  {/* Bright 8 */}
                  <Swatch color={t.brightBlack} className="opacity-70" />
                  <Swatch color={t.brightRed} className="opacity-70" />
                  <Swatch color={t.brightGreen} className="opacity-70" />
                  <Swatch color={t.brightYellow} className="opacity-70" />
                  <Swatch color={t.brightBlue} className="opacity-70" />
                  <Swatch color={t.brightMagenta} className="opacity-70" />
                  <Swatch color={t.brightCyan} className="opacity-70" />
                  <Swatch color={t.brightWhite} className="opacity-70" />
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
