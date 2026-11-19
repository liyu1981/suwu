import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Folding a tile's side panel on a narrow screen.
 *
 * The REST helper and the DB browser both put a list (history/collections,
 * schemas) beside a workspace. Side by side that needs roughly 500 px: below it
 * the list eats the workspace, and above it the list is worth having. A phone
 * tile — or a half-width desktop pane — is on the wrong side of that line, and
 * the tile was not usable until the panel was folded by hand.
 *
 * So the panel folds itself when the tile is narrow, and the user can always
 * override: once the chevron is tapped the choice is stored per tile (local
 * storage) and the automatic rule stops applying to that tile. Deleting the key
 * returns it to automatic.
 */
export interface SidebarCollapse {
  /** Whether the panel is folded right now. */
  collapsed: boolean;
  toggle: () => void;
  /**
   * Attach to the element whose width decides the automatic default — the tile's
   * root, not the panel (a folded panel has no width to measure).
   */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const STORAGE_PREFIX = 'suwu.sidebar-collapsed.';

function readPreference(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Private mode: fall back to the automatic rule.
  }
  return null;
}

export function useSidebarCollapse(storageKey: string, breakpoint = 520): SidebarCollapse {
  const [preference, setPreference] = useState<boolean | null>(() => readPreference(storageKey));
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const autoRef = useRef(autoCollapsed);
  autoRef.current = autoCollapsed;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setAutoCollapsed(entry.contentRect.width < breakpoint);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [breakpoint]);

  const collapsed = preference ?? autoCollapsed;

  const toggle = useCallback(() => {
    // The first tap converts "automatic" into an explicit choice, so it is the
    // effective state that flips, not the stored one.
    const next = !(preference ?? autoRef.current);
    setPreference(next);
    try {
      window.localStorage.setItem(STORAGE_PREFIX + storageKey, next ? '1' : '0');
    } catch {
      // A quota error must not stop the panel from folding.
    }
  }, [preference, storageKey]);

  return { collapsed, toggle, containerRef };
}
