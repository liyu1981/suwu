import { useCallback, useEffect, useState } from 'react';
import {
  restClear,
  restDelete,
  restGet,
  restGetAll,
  restPut,
  pruneRestHistory,
} from '../../../lib/restdb';
import {
  MAX_STORED_BODY_BYTES,
  type RestHistoryEntry,
  type RestResponseData,
  type RestStoredResponse,
} from '../../../store/resthelper';

/** IndexedDB-backed request history + response snapshots (client-side only). */
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
    async (entry: RestHistoryEntry, response: RestResponseData) => {
      await restPut('history', entry);
      // Persist the response alongside it. Oversized bodies are dropped but the
      // status/headers/timing are kept so the entry is still useful later.
      const stored: RestStoredResponse = {
        id: entry.id,
        timestamp: entry.timestamp,
        response:
          response.bodySize > MAX_STORED_BODY_BYTES
            ? { ...response, bodyB64: '', bodyOmitted: true }
            : response,
      };
      await restPut('responses', stored);
      await pruneRestHistory();
      await reload();
    },
    [reload],
  );

  /** Load the saved response snapshot for a history entry, if any. */
  const getResponse = useCallback(async (id: string): Promise<RestResponseData | null> => {
    const stored = await restGet<RestStoredResponse>('responses', id);
    return stored?.response ?? null;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await restDelete('history', id);
      await restDelete('responses', id);
      await reload();
    },
    [reload],
  );

  const clear = useCallback(async () => {
    await restClear('history');
    await restClear('responses');
    await reload();
  }, [reload]);

  return { entries, ready, add, getResponse, remove, clear, reload };
}
