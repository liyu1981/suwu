import { useBackground } from './useBackground'
import type { BackendKind } from './types'

const DEFAULT_BACKGROUND = 'ambient-blob'
const DEBUG_ID_KEY = 'suwu.bg-id'

/** Debug override: `?bg-id=<id>`, then localStorage, then undefined. */
function debugBackgroundId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const fromQuery = new URLSearchParams(window.location.search).get('bg-id')
  if (fromQuery) return fromQuery
  try {
    return window.localStorage.getItem(DEBUG_ID_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export interface AmbientBackgroundProps {
  /** Registered background id. Defaults to `ambient-blob`. */
  background?: string
  /** Backend override; defaults to auto-detection (GPU, then CPU). */
  force?: BackendKind | 'auto'
}

/**
 * Full-viewport ambient background. Renders the selected background's GPU
 * backend when WebGPU is available and falls back to its CPU backend
 * otherwise (GPU-only backgrounds simply render nothing without WebGPU). The
 * active backend is exposed on `data-backend` for debugging and perf tooling.
 */
export function AmbientBackground({ background, force }: AmbientBackgroundProps) {
  const id = background ?? debugBackgroundId() ?? DEFAULT_BACKGROUND
  const { canvasRef, canvasKey, backend } = useBackground({ id, force })
  return (
    <canvas
      key={canvasKey}
      ref={canvasRef}
      aria-hidden="true"
      data-backend={backend ?? undefined}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  )
}
