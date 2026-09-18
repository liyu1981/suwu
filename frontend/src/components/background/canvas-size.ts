/**
 * Canvas sizing shared by the CPU backends.
 *
 * GPU backends get this for free from vgpu (its `surface()` treats a canvas
 * with a numeric `clientWidth` as layout-backed and sizes itself from
 * `clientWidth/clientHeight × dpr`). CPU backends must follow the same rule so
 * a canvas renders at whatever CSS box the React layer gives it — the
 * full-viewport canvas and a small System Settings preview alike.
 *
 * The invariant: backends never read `window.innerWidth/innerHeight` and never
 * write `canvas.style.*`. The layout box is the single source of truth.
 */

/** Logical CSS size of a canvas, from its layout box. Clamped to ≥1px. */
export function layoutSize(canvas: HTMLCanvasElement): [number, number] {
  return [
    Math.max(1, Math.round(canvas.clientWidth)),
    Math.max(1, Math.round(canvas.clientHeight)),
  ];
}

/**
 * Size `canvas`'s backing store to its layout box × `dpr` and install the dpr
 * transform on `context`. Returns the new logical (CSS-pixel) size.
 *
 * The backing store is only reassigned when the target size actually changes,
 * so a resize observer never clears the surface for a no-op. Callers that need
 * a repaint after a real resize should redraw in their observer.
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  dpr: number,
): [number, number] {
  const [width, height] = layoutSize(canvas);
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [width, height];
}
