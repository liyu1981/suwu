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
 */
export function useVisualViewportVar(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;

    const apply = () => {
      frame = 0;
      root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);
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
