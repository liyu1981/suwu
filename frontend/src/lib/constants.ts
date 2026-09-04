/** Shared constants used across plugin pages. */

export const AUTO_REFRESH_INTERVALS = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
] as const

export const TOOLBAR_BTN =
  'grid h-7 w-7 place-items-center rounded-md text-white/40 transition-all duration-150 glass-btn hover:bg-white/[0.08] hover:text-white/80 active:scale-90 disabled:cursor-not-allowed disabled:opacity-20'

/** Make document background transparent for iframe pages. */
export function setPageTransparent(): void {
  document.documentElement.style.backgroundColor = 'transparent'
}
