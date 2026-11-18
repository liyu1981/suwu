import { useEffect, useRef, useState } from 'react';
import { useStore } from 'jotai';
import type { LayoutNode, Space } from './layout';
import { activeSpaceAtom, spacesAtom } from './atoms';
import { findLeaf, getPaneData, leaves } from './layout';
import { authFetch } from '../lib/api';
import {
  MAX_SERVER_SESSIONS,
  SESSION_STATE_KEY,
  type SessionStore,
  type TileSessionMap,
} from './sessionState';

/**
 * The pane <-> shell message bus.
 *
 * Tile iframes and the shell talk over `window.postMessage`; the protocol is the
 * same whichever shell hosts them, so it lives here rather than in `TilingWM`:
 *
 *   shell -> tile   `server-started-at`   server restarted, drop stale state
 *   shell -> tile   `tile-font-size`      per-pane font (paneData, else preset)
 *   shell -> tile   `tile-session-state`  reply to a tile's request
 *   tile -> shell   `request-font-size`   on mount (fixes the postMessage race)
 *   tile -> shell   `request-session-state` on mount (after the shell recreated
 *                                          the iframe, e.g. a space switch)
 *   tile -> shell   `tile-state-update`   persist this tile's UI state
 *
 * Two things make it less trivial than it looks: the session state is keyed by
 * *server instance* (`startedAt`), so a restart drops state that belongs to the
 * previous server instead of restoring it into fresh tiles; and both the request
 * replies and the font push have to read the latest atoms without re-subscribing
 * the window listener on every change, hence the refs.
 */
export interface PaneBusOptions {
  layout: LayoutNode | null;
  spaces: Space[];
  activeSpace: number;
  /** The "default for new terminals" preset; each tile's own value wins. */
  fontPreset: number;
}

export interface PaneBus {
  /** Identifies the running server; '' until known. */
  serverStartedAt: string;
  /** Persisted per-tile UI state for that server instance. */
  sessionState: TileSessionMap;
}

export function usePaneBus({ layout, spaces, activeSpace, fontPreset }: PaneBusOptions): PaneBus {
  const store = useStore();

  // Server start timestamp — identifies this server instance.
  const [serverStartedAt, setServerStartedAt] = useState<string>('');

  // Per-tile session state for the current server instance.
  const [sessionState, setSessionState] = useState<TileSessionMap>({});

  // Latest session state for message handlers. The listener below is not
  // re-subscribed on every state change, so a plain closure would serve stale
  // state when a tile asks for its session after the WM recreated its iframe.
  const sessionStateRef = useRef(sessionState);
  sessionStateRef.current = sessionState;

  // Load from localStorage: use the latest timestamp if available,
  // otherwise query server for startedAt.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY);
      if (raw) {
        const store: SessionStore = JSON.parse(raw);
        const keys = Object.keys(store);
        if (keys.length > 0) {
          keys.sort();
          const latest = keys[keys.length - 1];
          setServerStartedAt(latest);
          setSessionState(store[latest]);
          return;
        }
      }
    } catch {
      // ignore
    }
    authFetch('/api/server-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.startedAt) {
          setServerStartedAt(data.startedAt);
        }
      })
      .catch(() => {});
  }, []);

  // Notify child iframes when startedAt changes.
  useEffect(() => {
    if (!serverStartedAt) return;
    document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]').forEach((iframe) => {
      iframe.contentWindow?.postMessage(
        { type: 'server-started-at', startedAt: serverStartedAt },
        '*',
      );
    });
    // When startedAt changes (server restarted), load the new server's state
    // (which is likely empty) so tiles don't try to restore stale state.
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY);
      if (raw) {
        const store: SessionStore = JSON.parse(raw);
        const newState = store[serverStartedAt] ?? {};
        setSessionState(newState);
      } else {
        setSessionState({});
      }
    } catch {
      setSessionState({});
    }
  }, [serverStartedAt]);

  // Load saved state for this server instance once startedAt is known.
  useEffect(() => {
    if (!serverStartedAt) return;
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY);
      if (!raw) return;
      const store: SessionStore = JSON.parse(raw);
      const saved = store[serverStartedAt];
      if (saved) {
        setSessionState(saved);
      }
    } catch {
      // ignore
    }
  }, [serverStartedAt]);

  // Listen for tile-state-update messages from iframes and persist to localStorage.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as
        | { type?: string; paneId?: string; state?: Record<string, unknown> }
        | undefined;
      if (d?.type === 'tile-state-update' && typeof d.paneId === 'string' && d.state) {
        const leaf = layout ? findLeaf(layout, d.paneId) : null;
        const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined;
        if (!tileType) return;
        setSessionState((prev) => {
          const old = prev[d.paneId!];
          if (old && JSON.stringify(old.state) === JSON.stringify(d.state)) return prev;
          return { ...prev, [d.paneId!]: { tileType, state: d.state! } };
        });
      }
      // Child iframe asking for its saved state on mount. Restores a tile after
      // the WM recreated its iframe (focus mode, space switch), where the
      // one-off server-started-at broadcast already fired before the new
      // iframe loaded.
      if (d?.type === 'request-session-state' && typeof d.paneId === 'string') {
        const entry = sessionStateRef.current[d.paneId];
        e.source?.postMessage({
          type: 'tile-session-state',
          paneId: d.paneId,
          state: entry?.state ?? null,
        });
      }
      // Child iframe requesting its font size (sent on mount to fix
      // the race where the parent's postMessage arrives before the
      // child's listener is registered).
      if (d?.type === 'request-font-size' && typeof d.paneId === 'string') {
        const activeSpaces = store.get(spacesAtom);
        const activeIdx = store.get(activeSpaceAtom);
        const activeSpace = activeSpaces[activeIdx];
        const pane = activeSpace
          ? getPaneData<{ fontSize?: number; fontDefault?: number }>(activeSpace, d.paneId)
          : undefined;
        const fontSize = pane?.fontSize ?? fontPreset;
        const fontDefault = pane?.fontDefault ?? fontPreset;
        e.source?.postMessage({ type: 'tile-font-size', fontSize, fontDefault });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [layout, fontPreset, store]);

  // Debounced write of session state to localStorage (only if changed).
  // Re-queries server startedAt before writing to handle server restarts.
  useEffect(() => {
    if (!serverStartedAt) return;
    const t = setTimeout(async () => {
      try {
        // Re-query server startedAt to detect restarts.
        const res = await authFetch('/api/server-info', { cache: 'no-store' });
        let currentStartedAt = serverStartedAt;
        if (res.ok) {
          const info = await res.json();
          if (info?.startedAt && info.startedAt !== serverStartedAt) {
            currentStartedAt = info.startedAt;
            setServerStartedAt(currentStartedAt);
            // Notify children of new startedAt.
            document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]').forEach((iframe) => {
              iframe.contentWindow?.postMessage(
                { type: 'server-started-at', startedAt: currentStartedAt },
                '*',
              );
            });
          }
        }

        const raw = localStorage.getItem(SESSION_STATE_KEY);
        const store: SessionStore = raw ? JSON.parse(raw) : {};
        const current = JSON.stringify(store[currentStartedAt] ?? {});
        const next = JSON.stringify(sessionState);
        if (current === next) return;
        store[currentStartedAt] = sessionState;
        // Prune: keep at most MAX_SERVER_SESSIONS entries (FIFO by key).
        const keys = Object.keys(store);
        if (keys.length > MAX_SERVER_SESSIONS) {
          keys.sort();
          for (let i = 0; i < keys.length - MAX_SERVER_SESSIONS; i++) {
            delete store[keys[i]];
          }
        }
        localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(store));
      } catch {
        // localStorage full or unavailable — silently ignore.
      }
    }, 500);
    return () => clearTimeout(t);
  }, [sessionState, serverStartedAt]);

  // Cleanup: remove session entries for tiles that no longer exist in any space.
  useEffect(() => {
    if (!spaces.length) return;
    const ids = new Set(spaces.flatMap((s) => leaves(s.layout)));
    setSessionState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (!ids.has(key)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [spaces]);

  // Send font size to each iframe whenever the layout or paneData changes.
  // Font is stored in space.paneData[paneId], falling back to fontPreset
  // (the "new terminal default" from settings) for tiles with no explicit
  // font set.
  useEffect(() => {
    if (!layout) return;
    const activeSpaceData = spaces[activeSpace];
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[data-pane]');
    for (const iframe of iframes) {
      const paneId = iframe.getAttribute('data-pane');
      if (!paneId) continue;
      const leaf = findLeaf(layout, paneId);
      if (leaf?.type !== 'leaf') continue;
      const pane = activeSpaceData
        ? getPaneData<{ fontSize?: number; fontDefault?: number }>(activeSpaceData, paneId)
        : undefined;
      const fontSize = pane?.fontSize ?? fontPreset;
      const fontDefault = pane?.fontDefault ?? fontPreset;
      iframe.contentWindow?.postMessage({ type: 'tile-font-size', fontSize, fontDefault }, '*');
    }
  }, [layout, fontPreset, spaces, activeSpace]);

  return { serverStartedAt, sessionState };
}
