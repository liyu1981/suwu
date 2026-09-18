/**
 * Largest box that fits inside `containerWidth × maxHeight` while keeping the
 * window's aspect ratio (`height / width`), so the preview mirrors the real
 * full-viewport background's framing at a fraction of the pixels.
 *
 * Pure and dependency-free so the fit math can be unit-tested without a DOM.
 */
export function fitPreviewBox(
  containerWidth: number,
  maxHeight: number,
  aspect: number,
): { width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 9 / 16
  const available = Math.floor(containerWidth)
  if (available <= 0 || !Number.isFinite(maxHeight) || maxHeight <= 0) {
    return { width: 0, height: 0 }
  }

  const heightAtFullWidth = available * safeAspect
  if (heightAtFullWidth <= maxHeight) {
    return { width: available, height: Math.max(1, Math.round(heightAtFullWidth)) }
  }
  return {
    width: Math.max(1, Math.round(maxHeight / safeAspect)),
    height: Math.max(1, Math.round(maxHeight)),
  }
}
