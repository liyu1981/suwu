import { useBackground } from './useBackground'
import type { BackendKind } from './types'

export interface AmbientBackgroundProps {
  /** Backend override; defaults to auto-detection (GPU, then CPU). */
  force?: BackendKind | 'auto'
}

/**
 * Full-viewport ambient background. Renders the WebGPU (vgpu) blob field when
 * the browser supports it and transparently falls back to the canvas-2D
 * implementation. The current backend is exposed on `data-backend` for
 * debugging and perf tooling.
 */
export function AmbientBackground({ force }: AmbientBackgroundProps) {
  const { canvasRef, canvasKey, backend } = useBackground({ id: 'ambient-blob', force })
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
