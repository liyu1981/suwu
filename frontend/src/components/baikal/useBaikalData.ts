import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch } from '../../lib/api';
import type { BaikalSpace, BaikalSnapshot, BaikalTerminal } from '../../lib/baikal';

/** How often the panel re-reads the snapshot. The server keeps it live from
 * core events, so this is a cheap read, not a core round-trip. */
const POLL_MS = 3000;

export interface BaikalData {
  snapshot: BaikalSnapshot | null;
  error: string | null;
  hint: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Every live terminal, spaces and unassigned alike. */
  terminals: BaikalTerminal[];
  spaces: BaikalSpace[];
}

/**
 * The tile's snapshot, polled while the tile is open.
 *
 * Events keep the server's copy fresh (herdr-core pushes them); the poll is what
 * turns that into UI updates, and it doubles as reconnection: a core that was
 * down shows its error, and the next poll picks it up once it is back.
 */
export function useBaikalData(session: string | undefined): BaikalData {
  const [snapshot, setSnapshot] = useState<BaikalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const query = session ? `?session=${encodeURIComponent(session)}` : '';

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await authFetch(`/api/baikal/snapshot${query}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
        setError(body.error ?? `snapshot failed (${response.status})`);
        setHint(body.hint ?? null);
        return;
      }
      const data = (await response.json()) as BaikalSnapshot;
      setSnapshot(data);
      setError(null);
      setHint(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'snapshot failed');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const terminals = useMemo(() => {
    if (!snapshot) return [];
    return [
      ...snapshot.spaces.flatMap((space: BaikalSpace) => space.terminals),
      ...snapshot.unassigned,
    ];
  }, [snapshot]);

  return {
    snapshot,
    error,
    hint,
    loading,
    refresh,
    terminals,
    spaces: snapshot?.spaces ?? [],
  };
}
