import type { BackgroundParam } from '../types'

/** Default animation speed; 1 is the original iTime rate. */
export const RAINFOREST_DEFAULT_SPEED = 1

/**
 * Render-resolution presets. The scene is expensive (a 400-step terrain march
 * into 9-octave fbm plus tree and cloud marches), so it renders into a smaller
 * offscreen target and is upscaled; higher detail means more scene pixels.
 */
export type RainforestDetail = 'low' | 'medium' | 'high' | 'ultra' | 'native'

/** Default detail: sharp enough to read tree silhouettes without tanking fps. */
export const RAINFOREST_DEFAULT_DETAIL: RainforestDetail = 'high'

/** Scene render budget, in megapixels (`Infinity` = the full canvas backing). */
export const RAINFOREST_DETAIL_BUDGETS: Record<RainforestDetail, number> = {
  low: 0.4,
  medium: 1.0,
  high: 2.5,
  ultra: 5.0,
  native: Number.POSITIVE_INFINITY,
}

/** User-facing parameters for the Rainforest background. */
export interface RainforestParams {
  /** Multiplier on the animation clock; 1 is the original speed, 0 freezes it. */
  speed: number
  /** Offscreen render budget / sharpness. */
  detail: RainforestDetail
}

export const RAINFOREST_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the slow camera drift. 0 freezes the scene.',
    default: RAINFOREST_DEFAULT_SPEED,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    kind: 'select',
    key: 'detail',
    label: 'Detail',
    hint: 'Higher detail renders more scene pixels — sharper, but heavier.',
    default: RAINFOREST_DEFAULT_DETAIL,
    options: [
      { value: 'low', label: 'Low (0.4 MP)' },
      { value: 'medium', label: 'Medium (1 MP)' },
      { value: 'high', label: 'High (2.5 MP)' },
      { value: 'ultra', label: 'Ultra (5 MP)' },
      { value: 'native', label: 'Native (canvas)' },
    ],
  },
]

function isDetail(value: unknown): value is RainforestDetail {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'ultra' ||
    value === 'native'
  )
}

/** Read the typed Rainforest params out of the opaque subsystem params bag. */
export function resolveRainforestParams(params?: Record<string, unknown>): RainforestParams {
  const speed = params?.speed
  const detail = params?.detail
  return {
    speed:
      typeof speed === 'number' && Number.isFinite(speed)
        ? speed
        : RAINFOREST_DEFAULT_SPEED,
    detail: isDetail(detail) ? detail : RAINFOREST_DEFAULT_DETAIL,
  }
}
