import { atom, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { toolbarSuspensionSecondsAtom } from '../store/settings';
import { isSuspended, suspensionMs } from './toolbarSuspension';

/**
 * Per-pane toolbar hiding. The hide button lives on one tile, so the state does
 * too: clicking it on the Excalidraw tile must not disable the toolbar of the
 * terminal next to it.
 *
 * The pure contract lives in ./toolbarSuspension.ts.
 */

/** paneId → timestamp (ms) until which that pane's toolbar stays hidden. */
export const suspendedPanesAtom = atom<Record<string, number>>({});

/**
 * Suspension state for one pane, plus the action the hide button calls.
 *
 * Expiry is scheduled, so the toolbar returns the moment the time is up instead
 * of waiting for the next mouse move. A zero-length suspension (setting = 0) is
 * a no-op, which is how the rollback/disable case behaves without a second flag.
 */
export function useToolbarSuspension(paneId: string): {
  suspended: boolean;
  /** Milliseconds the button hides for; 0 means the feature is off. */
  durationMs: number;
  hide: () => void;
} {
  const seconds = useAtomValue(toolbarSuspensionSecondsAtom);
  const durationMs = suspensionMs(seconds);
  const panes = useAtomValue(suspendedPanesAtom);
  const setPanes = useSetAtom(suspendedPanesAtom);

  const until = panes[paneId] ?? 0;
  const suspended = isSuspended(until, Date.now());

  const hide = useCallback(() => {
    if (durationMs === 0) return;
    setPanes((prev) => ({ ...prev, [paneId]: Date.now() + durationMs }));
  }, [durationMs, paneId, setPanes]);

  useEffect(() => {
    if (!suspended) return;
    const timer = window.setTimeout(
      () => {
        setPanes((prev) => {
          if (!(paneId in prev)) return prev;
          const next = { ...prev };
          delete next[paneId];
          return next;
        });
      },
      Math.max(0, until - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [paneId, suspended, until, setPanes]);

  return { suspended, durationMs, hide };
}
