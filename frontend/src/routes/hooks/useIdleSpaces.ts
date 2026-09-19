import { useEffect } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { spacesAutoHiddenAtom, spacesHiddenAtom } from '../../wm/atoms';
import {
  SPACES_IDLE_MAX_MINUTES,
  SPACES_IDLE_MIN_MINUTES,
  spacesIdleAtom,
} from '../../store/settings';

function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return SPACES_IDLE_MIN_MINUTES;
  return Math.min(SPACES_IDLE_MAX_MINUTES, Math.max(SPACES_IDLE_MIN_MINUTES, Math.round(minutes)));
}

/** Same-origin document for an iframe, or null when it is inaccessible. */
function frameDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    return iframe.contentDocument;
  } catch {
    return null;
  }
}

/**
 * Screensaver-style auto-hide for the tiling spaces. When enabled in System
 * Settings, spaces hide after the configured idle time and come back on the
 * next interaction.
 *
 * A hide is only remembered as idle-driven (`spacesAutoHiddenAtom`), so a
 * deliberate hide via Alt+L is never undone by movement. Window-manager
 * shortcut keys (Alt/Ctrl/Cmd) are ignored here so the idle watcher does not
 * race the shortcut that toggles spaces.
 *
 * Tiles render in same-origin iframes, whose events never reach the parent
 * window. Their documents are therefore observed directly, re-attached as
 * tiles mount and as iframes finish loading.
 */
export function useIdleSpaces(): void {
  const store = useStore();
  const settings = useAtomValue(spacesIdleAtom);

  useEffect(() => {
    const reveal = () => {
      if (!store.get(spacesAutoHiddenAtom)) return;
      store.set(spacesAutoHiddenAtom, false);
      store.set(spacesHiddenAtom, false);
    };

    if (!settings.enabled) {
      reveal();
      return;
    }

    const timeoutMs = clampMinutes(settings.minutes) * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        // Never stack on top of a hide the user asked for.
        if (store.get(spacesHiddenAtom)) return;
        store.set(spacesAutoHiddenAtom, true);
        store.set(spacesHiddenAtom, true);
      }, timeoutMs);
    };

    const onActivity = () => {
      reveal();
      schedule();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      onActivity();
    };

    const onVisibility = () => {
      if (!document.hidden) onActivity();
    };

    // ── Tile iframes ────────────────────────────────────────────────
    const frameDocs = new Set<Document>();

    const attachFrame = (doc: Document) => {
      if (frameDocs.has(doc)) return;
      frameDocs.add(doc);
      doc.addEventListener('pointermove', onActivity, { passive: true });
      doc.addEventListener('pointerdown', onActivity, { passive: true });
      doc.addEventListener('wheel', onActivity, { passive: true });
      doc.addEventListener('touchstart', onActivity, { passive: true });
      doc.addEventListener('keydown', onKeyDown);
    };

    const attachAllFrames = () => {
      for (const iframe of document.querySelectorAll('iframe')) {
        const doc = frameDocument(iframe as HTMLIFrameElement);
        if (doc) attachFrame(doc);
      }
    };

    // Re-attach when an iframe navigates to its real document.
    const onFrameLoad = (event: Event) => {
      if (!(event.target instanceof HTMLIFrameElement)) return;
      const doc = frameDocument(event.target);
      if (doc) attachFrame(doc);
    };

    const observer = new MutationObserver(attachAllFrames);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('load', onFrameLoad, true);
    attachAllFrames();

    window.addEventListener('pointermove', onActivity);
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('wheel', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);

    schedule();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('load', onFrameLoad, true);
      for (const doc of frameDocs) {
        doc.removeEventListener('pointermove', onActivity);
        doc.removeEventListener('pointerdown', onActivity);
        doc.removeEventListener('wheel', onActivity);
        doc.removeEventListener('touchstart', onActivity);
        doc.removeEventListener('keydown', onKeyDown);
      }
      frameDocs.clear();
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('wheel', onActivity);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [settings.enabled, settings.minutes, store]);
}
