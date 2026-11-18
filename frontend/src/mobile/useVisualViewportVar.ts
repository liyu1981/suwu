import { useEffect } from 'react';

/**
 * Publish the visual viewport's height as `--vvh`.
 *
 * `dvh` follows the *layout* viewport. Android resizes that when the keyboard
 * opens (the `interactive-widget=resizes-content` viewport flag), but iOS Safari
 * does not: it keeps the layout viewport and shrinks the visual one instead, so
 * a `100dvh` shell would sit under the keyboard. `visualViewport.height` is the
 * only number that is right on both, so the shell's height reads
 * `var(--vvh, 100dvh)`.
 *
 * The listener is coalesced into a frame: iOS fires `resize` for every pixel of
 * a keyboard animation.
 *
 * Two guards matter more than they look. A height of a few pixels arrives while
 * the browser UI animates (and `0` when the page is being torn down); writing it
 * would collapse the shell, resize every iframe and leave a terminal fitted to
 * zero rows. And rewriting an unchanged value would resize nothing but still
 * invalidate layout on every scroll event, so only real changes are applied.
 */
const MIN_HEIGHT = 100;
export function useVisualViewportVar(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;

    let applied = '';

    const apply = () => {
      frame = 0;
      const height = Math.round(viewport.height);
      if (height < MIN_HEIGHT) return;
      const next = `${height}px`;
      if (next === applied) return;
      applied = next;
      root.style.setProperty('--vvh', next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);

    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--vvh');
    };
  }, []);
}
