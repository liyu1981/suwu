/**
 * Source crop rect for the `cover` fit: scale the video up so it fills the
 * destination on both axes, then centre the (overflowing) source. The
 * destination is always the full render surface.
 */
export interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

export function coverSourceRect(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): SourceRect {
  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight)
  const sw = canvasWidth / scale
  const sh = canvasHeight / scale
  return { sx: (videoWidth - sw) / 2, sy: (videoHeight - sh) / 2, sw, sh }
}
