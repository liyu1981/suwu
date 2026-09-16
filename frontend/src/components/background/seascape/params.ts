import type { BackgroundParam } from '../types'

/** Speed shown as the default in System Settings. */
export const SEASCAPE_DEFAULT_SPEED = 1

/**
 * Time-scale that a UI speed of 1.0× maps to. The Shadertoy original is brisk
 * for an always-on backdrop, so Suwu runs it at a quarter speed; the user's
 * setting multiplies this base.
 */
export const SEASCAPE_SPEED_BASE = 0.25

/** User-facing parameters for the Seascape background. */
export interface SeascapeParams {
  /** UI multiplier on the base animation clock; 1 is the default, 0 freezes it. */
  speed: number
}

export const SEASCAPE_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'number',
    key: 'speed',
    label: 'Animation speed',
    hint: 'Scales the drift of the camera and the waves. 0 freezes the scene.',
    default: SEASCAPE_DEFAULT_SPEED,
    min: 0,
    max: 3,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
]

/** Read the typed Seascape params out of the opaque subsystem params bag. */
export function resolveSeascapeParams(params?: Record<string, unknown>): SeascapeParams {
  const speed = params?.speed
  return {
    speed:
      typeof speed === 'number' && Number.isFinite(speed) ? speed : SEASCAPE_DEFAULT_SPEED,
  }
}
