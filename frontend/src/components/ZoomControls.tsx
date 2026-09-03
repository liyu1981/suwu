import { useEffect, type CSSProperties } from 'react'
import { ZOOM_STEP, clampZoom } from '../store/zoom'

/**
 * Apply the zoom level to the iframe's <html> element (CSS zoom).
 * Cleanup resets it; pages unmount on pane close.
 */
export function useHtmlZoom(zoom: number): void {
  useEffect(() => {
    document.documentElement.style.zoom = String(zoom)
    return () => {
      document.documentElement.style.zoom = ''
    }
  }, [zoom])
}

/**
 * Inline style for the tile root that compensates for the html zoom so the
 * page fills the iframe exactly and never overflows with scrollbars. CSS zoom
 * scales rendering without changing viewport units, so we shrink the root's
 * logical size by 1/zoom while zoom renders it back to 100% visually. Content
 * reflows like browser zoom (bigger text + UI) with no page-level scrolling.
 */
export function tileZoomStyle(zoom: number): CSSProperties {
  return {
    width: `calc(100vw / ${zoom})`,
    height: `calc(100vh / ${zoom})`,
    overflow: 'hidden',
  }
}

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white active:scale-90'

const fontLabel = 'text-[9px] font-semibold leading-none'

/**
 * Compact A- / % / A+ zoom controls. The percentage is clickable and resets
 * the zoom to 100%. Mirrors the terminal toolbar's font size buttons.
 */
export function ZoomControls({ zoom, onChange }: { zoom: number; onChange: (z: number) => void }) {
  const pct = Math.round(zoom * 100)

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        disabled={zoom <= 1}
        onClick={() => onChange(clampZoom(zoom - ZOOM_STEP))}
        aria-label="Zoom out"
        title="Zoom out"
        className={`${toolBtn} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300`}
      >
        <span className={fontLabel}>A−</span>
      </button>
      <button
        type="button"
        disabled={zoom === 1}
        onClick={() => onChange(1)}
        aria-label="Reset zoom to 100%"
        title={`Reset zoom to 100% (current ${pct}%)`}
        className={`${toolBtn} w-10 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-300`}
      >
        <span className={fontLabel}>{pct}%</span>
      </button>
      <button
        type="button"
        disabled={zoom >= 5}
        onClick={() => onChange(clampZoom(zoom + ZOOM_STEP))}
        aria-label="Zoom in"
        title="Zoom in"
        className={`${toolBtn} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300`}
      >
        <span className={fontLabel}>A+</span>
      </button>
    </div>
  )
}