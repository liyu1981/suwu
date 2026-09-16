import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { getBackground } from './registry'
import { startBackground } from './select'
import type { BackendKind, BackgroundHandle } from './types'

const DEFAULT_DPR: readonly [number, number] = [1, 2]

export interface UseBackgroundOptions {
  /** Registered background id. */
  id: string
  /** Backend override; defaults to `'auto'` (GPU, then CPU). */
  force?: BackendKind | 'auto'
  /** Allowed device-pixel-ratio range. */
  dpr?: readonly [number, number]
  /** Target frame rate for animated backgrounds. */
  fps?: number
}

export interface UseBackgroundResult {
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Bump target for the canvas `key`; changes when the canvas must remount. */
  canvasKey: number
  /** The backend that is actually running, once started. */
  backend: BackendKind | null
}

/**
 * Owns the lifecycle of a background renderer for a `<canvas>`:
 * capability detection, start/stop on mount, reduced-motion changes, and a
 * canvas remount when a backend reports a fatal error.
 */
export function useBackground(options: UseBackgroundOptions): UseBackgroundResult {
  const { id, force = 'auto', dpr = DEFAULT_DPR, fps = 30 } = options
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [canvasKey, setCanvasKey] = useState(0)
  const [gpuDisabled, setGpuDisabled] = useState(false)
  const [backend, setBackend] = useState<BackendKind | null>(null)
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  // Track the user's motion preference for the lifetime of the mount.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReducedMotion(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // A failed backend cannot reuse this canvas (its context type is locked),
  // so remount it and disable the GPU path to avoid a retry loop.
  const onFatal = useCallback((error: unknown) => {
    console.warn('[background] renderer failed; remounting canvas', error)
    setGpuDisabled(true)
    setBackend(null)
    setCanvasKey((key) => key + 1)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const definition = getBackground(id)
    if (!definition) {
      console.warn(`[background] no background registered with id "${id}"`)
      return
    }

    let cancelled = false
    let handle: BackgroundHandle | null = null
    const effectiveForce: BackendKind | 'auto' = gpuDisabled ? 'cpu' : force
    const ctx = { canvas, dpr, fps, reducedMotion, onFatal }

    void startBackground(definition, ctx, { force: effectiveForce })
      .then((started) => {
        if (cancelled) {
          started.dispose()
          return
        }
        handle = started
        setBackend(started.backend)
      })
      .catch((error) => {
        console.error('[background] failed to start', error)
      })

    return () => {
      cancelled = true
      setBackend(null)
      handle?.dispose()
    }
  }, [id, force, dpr, fps, reducedMotion, gpuDisabled, canvasKey, onFatal])

  return { canvasRef, canvasKey, backend }
}
