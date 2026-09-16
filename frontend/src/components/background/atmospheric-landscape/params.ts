import type { BackgroundParam } from '../types'

/** User-facing parameters for the Atmospheric Landscape background. */
export interface AtmosphericLandscapeParams {
  /** Multiplier on the animation clock; 1 is the tuned default, 0 freezes it. */
  speed: number
}

export const ATMOSPHERIC_LANDSCAPE_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the fly-over and the fog drift. 0 freezes the scene.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
]

/** Read the typed params out of the opaque subsystem params bag. */
export function resolveAtmosphericLandscapeParams(
  params?: Record<string, unknown>,
): AtmosphericLandscapeParams {
  const speed = params?.speed
  return { speed: typeof speed === 'number' && Number.isFinite(speed) ? speed : 1 }
}
