/**
 * Image-lightbox geometry — the pure part of the dropbox image preview.
 *
 * The picture is drawn centred in a viewport and transformed with
 * `translate(offset) scale(scale)`, so at scale 1 it is fitted (contain) and
 * never upscaled beyond its own pixels. Panning is bounded so the image can
 * never be dragged out of sight, and zooming keeps the point under the cursor
 * still.
 *
 * Kept free of React so the maths can be checked by a Node script
 * (scripts/check-dropbox-lightbox.mjs).
 */

/** Fitted size: never larger than the viewport, never larger than the pixels. */
export const LIGHTBOX_MIN_SCALE = 1;
export const LIGHTBOX_MAX_SCALE = 8;
/** One click of +/−. */
export const LIGHTBOX_STEP = 1.25;

export interface Vec {
  x: number;
  y: number;
}

/** Clamp a zoom factor into the supported range. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return LIGHTBOX_MIN_SCALE;
  return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, scale));
}

/** The next zoom factor for a +1 (in) or −1 (out) step. */
export function nextScale(scale: number, direction: 1 | -1): number {
  const base = clampScale(scale);
  return clampScale(direction > 0 ? base * LIGHTBOX_STEP : base / LIGHTBOX_STEP);
}

/** How far the image may be moved from centre, per axis (0 = pinned). */
export function panLimit(
  scale: number,
  fitW: number,
  fitH: number,
  viewW: number,
  viewH: number,
): Vec {
  const s = clampScale(scale);
  return {
    x: Math.max(0, (fitW * s - viewW) / 2),
    y: Math.max(0, (fitH * s - viewH) / 2),
  };
}

/** Clamp an offset into the pan limit, so the image always covers the view. */
export function clampPan(
  offset: Vec,
  scale: number,
  fitW: number,
  fitH: number,
  viewW: number,
  viewH: number,
): Vec {
  const limit = panLimit(scale, fitW, fitH, viewW, viewH);
  return {
    x: Math.min(limit.x, Math.max(-limit.x, offset.x)),
    y: Math.min(limit.y, Math.max(-limit.y, offset.y)),
  };
}

/**
 * The offset that keeps the image point under `cursor` fixed while zooming from
 * `from` to `to`. `cursor` is relative to the viewport centre, like the offset.
 *
 * The invariant: (cursor − offset) / scale is the image point under the cursor;
 * it must be the same before and after.
 */
export function zoomAround(cursor: Vec, offset: Vec, from: number, to: number): Vec {
  const a = clampScale(from);
  const b = clampScale(to);
  if (a === b) return offset;
  const ratio = b / a;
  return {
    x: cursor.x - (cursor.x - offset.x) * ratio,
    y: cursor.y - (cursor.y - offset.y) * ratio,
  };
}

/** The scale to fit the picture inside the viewport (used once, on load). */
export function fitSize(naturalW: number, naturalH: number, viewW: number, viewH: number): Vec {
  const nw = Math.max(1, naturalW);
  const nh = Math.max(1, naturalH);
  const scale = Math.min(viewW / nw, viewH / nh, 1);
  return { x: nw * scale, y: nh * scale };
}
