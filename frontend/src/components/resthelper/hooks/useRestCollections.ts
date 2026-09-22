import { useCallback, useEffect, useState } from 'react';
import { restDelete, restGetAll, restPut } from '../../../lib/restdb';
import {
  newId,
  type RestCollection,
  type RestRequestDraft,
  type SavedRequest,
} from '../../../store/resthelper';

/** IndexedDB-backed saved requests grouped into collections (client-side only). */
export function useRestCollections() {
  const [collections, setCollections] = useState<RestCollection[]>([]);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const rows = await restGetAll<RestCollection>('collections');
    setCollections(rows);
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (
      collectionId: string,
      collectionName: string,
      name: string,
      request: RestRequestDraft,
    ): Promise<void> => {
      const existing = collections.find((collection) => collection.id === collectionId);
      const now = Date.now();
      const saved: SavedRequest = {
        id: newId('saved'),
        name,
        request,
        createdAt: now,
        updatedAt: now,
      };
      const next: RestCollection = existing
        ? { ...existing, requests: [...existing.requests, saved] }
        : { id: collectionId, name: collectionName, requests: [saved], createdAt: now };
      await restPut('collections', next);
      await reload();
    },
    [collections, reload],
  );

  const removeRequest = useCallback(
    async (collectionId: string, requestId: string) => {
      const existing = collections.find((collection) => collection.id === collectionId);
      if (!existing) return;
      const next: RestCollection = {
        ...existing,
        requests: existing.requests.filter((request) => request.id !== requestId),
      };
      await restPut('collections', next);
      await reload();
    },
    [collections, reload],
  );

  const removeCollection = useCallback(
    async (collectionId: string) => {
      await restDelete('collections', collectionId);
      await reload();
    },
    [reload],
  );

  return { collections, ready, save, removeRequest, removeCollection, reload };
}
