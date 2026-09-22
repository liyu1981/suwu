import { useCallback, useEffect, useState } from 'react';
import { restDelete, restGetAll, restPut, restClear, pruneRestHistory } from '../../../lib/restdb';
import type { RestHistoryEntry } from '../../../store/resthelper';

/** IndexedDB-backed request history (client-side only). */
export function useRestHistory() {
  const [entries, setEntries] = useState<RestHistoryEntry[]>([]);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const rows = await restGetAll<RestHistoryEntry>('history');
    rows.sort((a, b) => b.timestamp - a.timestamp);
    setEntries(rows);
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(
    async (entry: RestHistoryEntry) => {
      await restPut('history', entry);
      await pruneRestHistory();
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await restDelete('history', id);
      await reload();
    },
    [reload],
  );

  const clear = useCallback(async () => {
    await restClear('history');
    await reload();
  }, [reload]);

  return { entries, ready, add, remove, clear, reload };
}
