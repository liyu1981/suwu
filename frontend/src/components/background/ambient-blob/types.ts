/** Palette selection for the ambient blob background. */
export type AmbientBlobPalette = 'auto' | 'light' | 'dark'

/** User-facing parameters for the ambient blob background. */
export type AmbientBlobParams = {
  palette: AmbientBlobPalette
}

/** A blob's fixed, randomly-generated seed values. */
export interface BlobSeed {
  rx: number
  ry: number
  radius: number
  hue: number
  sat: number
  light: number
  alpha: number
  vx: number
  vy: number
  ampX: number
  ampY: number
  phase: number
  freq: number
}

/** A blob's per-frame, render-ready values. */
export interface RenderBlob {
  x: number
  y: number
  radius: number
  /** sRGB colour in [0, 1]. */
  color: readonly [number, number, number]
  alpha: number
}
