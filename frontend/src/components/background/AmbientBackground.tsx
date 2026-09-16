import { DEFAULT_BACKGROUND_ID } from './constants'
import { getBackground } from './registry'
import { useBackground } from './useBackground'
import type { BackendKind } from './types'

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

/** Debug override, then the chosen id, then default — falling back if unregistered. */
function resolveBackgroundId(preferred?: string): string {
  const candidate = debugBackgroundId() ?? preferred ?? DEFAULT_BACKGROUND_ID
  return getBackground(candidate) ? candidate : DEFAULT_BACKGROUND_ID
}

export interface AmbientBackgroundProps {
  /** Registered background id. Defaults to the user's choice, then `ambient-blob`. */
  background?: string
  /** Backend override; defaults to auto-detection (GPU, then CPU). */
  force?: BackendKind | 'auto'
}

/**
 * Full-viewport ambient background. Renders the selected background's GPU
 * backend when WebGPU is available and falls back to its CPU backend
 * otherwise (GPU-only backgrounds simply render nothing without WebGPU). The
 * active backend is exposed on `data-backend` for debugging and perf tooling.
 *
 * The canvas is keyed by the background id: a canvas context type is permanent,
 * so switching backgrounds must start on a fresh element.
 */
export function AmbientBackground({ background, force }: AmbientBackgroundProps) {
  const id = resolveBackgroundId(background)
  const { canvasRef, canvasKey, backend } = useBackground({ id, force })
  return (
    <canvas
      key={`${id}-${canvasKey}`}
      ref={canvasRef}
      aria-hidden="true"
      data-backend={backend ?? undefined}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  )
}
