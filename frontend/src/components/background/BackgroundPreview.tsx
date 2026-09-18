import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { fitPreviewBox } from './preview-size'
import { getBackground } from './registry'
import { resolveBackgroundParams } from './params'
import { useBackground } from './useBackground'
import { backgroundAtom, backgroundParamsAtom } from '../../store/settings'

/** Cheap logical render size: the box is a few hundred px wide. */
const PREVIEW_DPR: readonly [number, number] = [1, 1.5]
const PREVIEW_FPS = 24
const DEFAULT_MAX_HEIGHT = 180
/** How long a GPU-only background may stay blank before we explain why. */
const UNAVAILABLE_DELAY_MS = 800

export interface BackgroundPreviewProps {
  /** Registered background id. Defaults to the selected background. */
  background?: string
  /** Cap on the preview's rendered height, in CSS pixels. Defaults to 180. */
  maxHeight?: number
}

/** Current window aspect ratio (height / width), kept in sync on resize. */
function useWindowAspect(): number {
  const [aspect, setAspect] = useState(() =>
    typeof window === 'undefined' || window.innerWidth === 0
      ? 9 / 16
      : window.innerHeight / window.innerWidth,
  )
  useEffect(() => {
    const update = () =>
      setAspect(window.innerWidth === 0 ? 9 / 16 : window.innerHeight / window.innerWidth)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return aspect
}

/** Width of an element's content box, tracked with a resize observer. */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/**
 * A small live preview of a background, rendered into its own canvas so it can
 * sit inside the System Settings panel while the real, full-viewport
 * `AmbientBackground` stays behind the scrim.
 *
 * The canvas box is sized to the window's aspect ratio (capped at `maxHeight`)
 * and the backend renders at that logical size — the GPU backends size from the
 * canvas layout box, and the CPU backends were aligned to do the same (see
 * `canvas-size.ts`). Selecting a background or editing a param restarts the
 * backend through the shared `useBackground` lifecycle.
 *
 * The preview shows exactly the selected background; there is no debug override
 * forcing a different one (the shell no longer has one either).
 */
export function BackgroundPreview({
  background,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: BackgroundPreviewProps) {
  const { t } = useTranslation()
  const selectedId = useAtomValue(backgroundAtom)
  const paramOverrides = useAtomValue(backgroundParamsAtom)
  const id = background ?? selectedId

  const definition = useMemo(() => getBackground(id), [id])
  const overrides = paramOverrides[id]
  const params = useMemo(
    () => (definition ? resolveBackgroundParams(definition, overrides) : undefined),
    [definition, overrides],
  )
  const paramsKey = useMemo(() => (params ? JSON.stringify(params) : ''), [params])

  const { canvasRef, canvasKey, backend } = useBackground({
    id,
    params,
    dpr: PREVIEW_DPR,
    fps: PREVIEW_FPS,
  })

  const [boxRef, containerWidth] = useElementWidth<HTMLDivElement>()
  const aspect = useWindowAspect()
  const box = useMemo(
    () => fitPreviewBox(containerWidth, maxHeight, aspect),
    [containerWidth, maxHeight, aspect],
  )

  // GPU-only backgrounds render nothing without WebGPU, but `useBackground`
  // reports no backend until one starts — so wait a beat before blaming the
  // browser.
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    setUnavailable(false)
    if (backend !== null) return
    const timer = setTimeout(() => setUnavailable(true), UNAVAILABLE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [backend, id, paramsKey])

  return (
    <div ref={boxRef} className="w-full">
      <div
        className="relative overflow-hidden rounded-[6px] border border-white/10 bg-black/20"
        style={{ width: box.width, height: box.height }}
      >
        <canvas
          key={`${id}-${paramsKey}-${canvasKey}`}
          ref={canvasRef}
          aria-hidden="true"
          data-backend={backend ?? undefined}
          className="pointer-events-none block h-full w-full"
        />
        {unavailable && definition && !definition.cpu && (
          <span className="absolute inset-0 grid place-items-center px-3 text-center text-[11px] text-muted-foreground">
            {t('settings.backgroundPreviewNeedsWebGPU')}
          </span>
        )}
      </div>
    </div>
  )
}
