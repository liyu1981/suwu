import type { BackgroundParam } from '../types'
import { VIDEO_CROSSFADE_SECONDS } from './video-cpu/loop'
import { clearVideoFile, listVideoFiles, storeVideoFile } from './video-cpu/storage'

export type VideoFit = 'cover' | 'stretch'

export const VIDEO_DEFAULT_SOURCE = ''
export const VIDEO_DEFAULT_FIT: VideoFit = 'cover'
export const VIDEO_DEFAULT_SPEED = 1
// Default mask matches the translucent `.apple-panel` background (white 10%).
export const VIDEO_DEFAULT_MASK_COLOR = '#ffffff'
export const VIDEO_DEFAULT_MASK_OPACITY = 0.1

/** Clips longer than this are flagged as too long for a background. */
export const VIDEO_MAX_DURATION_SECONDS = 30

/** User-facing parameters for the Video background. */
export interface VideoParams {
  /** Stored id of the selected clip; the bytes live in OPFS. */
  source: string
  fit: VideoFit
  speed: number
  /** Crossfade the clip's tail into its start to hide the loop jump. */
  crossfade: boolean
  /** Colour of the tint drawn over the video. */
  maskColor: string
  /** Opacity of the tint, 0 (off) to 1. */
  maskOpacity: number
}

export const VIDEO_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'fileList',
    key: 'source',
    label: 'Video clips',
    accept: 'video/mp4,video/webm,video/x-matroska,video/*',
    hint: 'Stored in this browser. Short, muted clips work best.',
    default: VIDEO_DEFAULT_SOURCE,
    store: storeVideoFile,
    list: listVideoFiles,
    clear: clearVideoFile,
  },
  {
    kind: 'select',
    key: 'fit',
    label: 'Fit',
    default: VIDEO_DEFAULT_FIT,
    options: [
      { value: 'cover', label: 'Auto-crop (cover)' },
      { value: 'stretch', label: 'Stretch to fill' },
    ],
  },
  {
    kind: 'number',
    key: 'speed',
    label: 'Playback speed',
    default: VIDEO_DEFAULT_SPEED,
    min: 0.25,
    max: 2,
    step: 0.05,
    format: (value) => `${value.toFixed(2)}×`,
  },
  {
    kind: 'boolean',
    key: 'crossfade',
    label: 'Smooth loop',
    hint: `Crossfade the last ${VIDEO_CROSSFADE_SECONDS}s into the start to hide the loop jump.`,
    default: false,
  },
  {
    kind: 'color',
    key: 'maskColor',
    label: 'Mask colour',
    hint: 'Tint drawn over the video. Defaults to the translucent panel background.',
    default: VIDEO_DEFAULT_MASK_COLOR,
  },
  {
    kind: 'number',
    key: 'maskOpacity',
    label: 'Mask opacity',
    default: VIDEO_DEFAULT_MASK_OPACITY,
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => `${Math.round(value * 100)}%`,
  },
]

function isFit(value: unknown): value is VideoFit {
  return value === 'cover' || value === 'stretch'
}

/** Read the typed Video params out of the opaque subsystem params bag. */
export function resolveVideoParams(params?: Record<string, unknown>): VideoParams {
  const source = params?.source
  const fit = params?.fit
  const speed = params?.speed
  const crossfade = params?.crossfade
  const maskColor = params?.maskColor
  const maskOpacity = params?.maskOpacity
  return {
    source: typeof source === 'string' ? source : VIDEO_DEFAULT_SOURCE,
    fit: isFit(fit) ? fit : VIDEO_DEFAULT_FIT,
    speed:
      typeof speed === 'number' && Number.isFinite(speed) && speed > 0
        ? speed
        : VIDEO_DEFAULT_SPEED,
    crossfade: typeof crossfade === 'boolean' ? crossfade : false,
    maskColor:
      typeof maskColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(maskColor)
        ? maskColor.toLowerCase()
        : VIDEO_DEFAULT_MASK_COLOR,
    maskOpacity:
      typeof maskOpacity === 'number' && Number.isFinite(maskOpacity)
        ? Math.min(1, Math.max(0, maskOpacity))
        : VIDEO_DEFAULT_MASK_OPACITY,
  }
}
