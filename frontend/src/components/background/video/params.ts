import type { BackgroundParam } from '../types';
import { VIDEO_CROSSFADE_SECONDS } from './video-cpu/loop';
import { clearVideoFile, listVideoFiles, storeVideoFile } from './video-cpu/storage';

type VideoFit = 'cover' | 'stretch';

const VIDEO_DEFAULT_SOURCE = '';
const VIDEO_DEFAULT_FIT: VideoFit = 'cover';
const VIDEO_DEFAULT_SPEED = 1;
// Default mask matches the translucent `.apple-panel` background (white 10%).
const VIDEO_DEFAULT_MASK_COLOR = '#ffffff';
const VIDEO_DEFAULT_MASK_OPACITY = 0.1;

/** Clips longer than this are flagged as too long for a background. */
export const VIDEO_MAX_DURATION_SECONDS = 30;

/** Default minutes between auto-rotations. */
export const VIDEO_ROTATE_MINUTES_DEFAULT = 10;
const VIDEO_ROTATE_MINUTES_MIN = 1;
const VIDEO_ROTATE_MINUTES_MAX = 120;

/** User-facing parameters for the Video background. */
export interface VideoParams {
  /** Stored id of the selected clip; the bytes live in OPFS. */
  source: string;
  fit: VideoFit;
  speed: number;
  /** Crossfade the clip's tail into its start to hide the loop jump. */
  crossfade: boolean;
  /** Colour of the tint drawn over the video. */
  maskColor: string;
  /** Opacity of the tint, 0 (off) to 1. */
  maskOpacity: number;
  /** Cycle through every clip in the family library (2D Lives). */
  rotate: boolean;
  /** Minutes each clip stays on screen before rotating. */
  rotateMinutes: number;
}

/**
 * The playback parameters shared with other video-backed backgrounds (see the
 * `2d-lives` family). They only depend on the `source` key, so any background
 * that stores a clip in OPFS can reuse them and the video renderer as-is.
 */
export const VIDEO_PLAYBACK_PARAMS: readonly BackgroundParam[] = [
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
];

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
  ...VIDEO_PLAYBACK_PARAMS,
];

function isFit(value: unknown): value is VideoFit {
  return value === 'cover' || value === 'stretch';
}

/** Read the typed Video params out of the opaque subsystem params bag. */
export function resolveVideoParams(params?: Record<string, unknown>): VideoParams {
  const source = params?.source;
  const fit = params?.fit;
  const speed = params?.speed;
  const crossfade = params?.crossfade;
  const maskColor = params?.maskColor;
  const maskOpacity = params?.maskOpacity;
  const rotate = params?.rotate;
  const rotateMinutes = params?.rotateMinutes;
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
    rotate: typeof rotate === 'boolean' ? rotate : false,
    rotateMinutes:
      typeof rotateMinutes === 'number' && Number.isFinite(rotateMinutes)
        ? Math.min(VIDEO_ROTATE_MINUTES_MAX, Math.max(VIDEO_ROTATE_MINUTES_MIN, rotateMinutes))
        : VIDEO_ROTATE_MINUTES_DEFAULT,
  };
}
