import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authFetch, fetchToken } from '../../lib/api';
import type { BaikalSpace, BaikalSnapshot, BaikalTerminal } from '../../lib/baikal';

/** How often the panel re-reads the snapshot even when the event stream is up.
 * The stream is what makes it feel live; this is the safety net for a proxy that
 * drops it, and it is a cheap read of an in-memory view, not a core round-trip. */
const POLL_MS = 5000;

/** Coalesce a burst of events into one read. */
const SETTLE_MS = 80;

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
 * The tile's snapshot: pushed by the server, polled as a fallback.
 *
 * herdr-core reports a `cd` (and anything else worth showing) within 500 ms and
 * the server forwards it over `/api/baikal/events`; without that stream the tile
 * only learned about a change on its next poll, which is why a space name used
 * to lag behind the directory you had just entered.
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

  // The event stream. EventSource cannot send headers, and the server takes the
  // token in the query string (the same way the attach socket does), so the
  // token is fetched before opening and the stream is simply abandoned if that
  // fails — the poll still covers it.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let settle: number | undefined;
    const bump = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (!cancelled) void refresh();
      }, SETTLE_MS);
    };
    void (async () => {
      try {
        const { token } = await fetchToken();
        if (cancelled) return;
        const params = new URLSearchParams({ token });
        if (session) params.set('session', session);
        source = new EventSource(`/api/baikal/events?${params.toString()}`);
        source.addEventListener('ready', bump);
        source.onmessage = bump;
      } catch {
        // No token, no stream: the poll is the fallback and already running.
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(settle);
      source?.close();
    };
  }, [refresh, session]);

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
