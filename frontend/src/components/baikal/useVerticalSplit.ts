import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from '../../lib/utils';

/**
 * A vertical split with a draggable divider, remembered per tile.
 *
 * The baikal panel is two lists that want the same space — spaces (where you
 * work) and agents (what needs you) — so the split is 50/50 until the user says
 * otherwise, and the divider is dragged rather than set from a menu. The ratio is
 * stored in local storage so the panel feels the same on the next visit.
 */
export interface VerticalSplit {
  /** Attach to the element whose height the ratio is a fraction of. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The top pane's share, 0..1. */
  ratio: number;
  /** Attach to the divider: pointer handlers + keyboard nudging. */
  handleProps: React.HTMLAttributes<HTMLDivElement> & {
    role: 'separator';
    tabIndex: number;
    'aria-orientation': 'horizontal';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
  };
  dragging: boolean;
}

const STORAGE_KEY = 'suwu.baikal.split';
const DEFAULT_RATIO = 0.5;
/** Neither pane may be squeezed out of the panel entirely. */
const MIN_RATIO = 0.12;
const MAX_RATIO = 0.88;

/** A stored ratio, kept inside the draggable range (garbage means "half"). */
function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return clamp(ratio, MIN_RATIO, MAX_RATIO);
}

function read(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_RATIO;
    const value = Number(raw);
    return Number.isFinite(value) ? clampRatio(value) : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

export function useVerticalSplit(): VerticalSplit {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState<number>(read);
  const [dragging, setDragging] = useState(false);

  // Persist on settle, not on every pointer move.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(ratio));
      } catch {
        // Private mode: the split just does not survive a reload.
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ratio]);

  const setFromPointer = useCallback((clientY: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.height < 1) return;
    setRatio(clamp((clientY - box.top) / box.height, MIN_RATIO, MAX_RATIO));
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // The divider owns the pointer for the whole drag: a list that scrolls
      // under it must not steal the move events mid-drag.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setFromPointer(event.clientY);
    },
    [setFromPointer],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      setFromPointer(event.clientY);
    },
    [setFromPointer],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setRatio((current) => clamp(current - step, MIN_RATIO, MAX_RATIO));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setRatio((current) => clamp(current + step, MIN_RATIO, MAX_RATIO));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      setRatio(DEFAULT_RATIO);
    }
  }, []);

  return {
    containerRef,
    ratio,
    dragging,
    handleProps: {
      onPointerDown,
      onKeyDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'horizontal',
      'aria-valuenow': Math.round(ratio * 100),
      'aria-valuemin': Math.round(MIN_RATIO * 100),
      'aria-valuemax': Math.round(MAX_RATIO * 100),
    },
  };
}
