import { useCallback } from 'react';
import { useAtom } from 'jotai';
import {
  dbConnectionAtom,
  dbQueryAtom,
  type ColumnMeta,
  type QueryResult,
} from '../../../store/dbbrowser';
import { authFetch } from '../../../lib/api';

/**
 * The server sends columns/rows as `null` for statements that produce no result
 * set (UPDATE/INSERT/DELETE/SET/DDL). Normalize them to arrays at the single
 * point results enter the store, so no consumer can crash on `.length` of null.
 */
interface ExecuteResponse extends Omit<QueryResult, 'columns' | 'rows'> {
  columns?: ColumnMeta[] | null;
  rows?: unknown[][] | null;
}

export function useDBQuery() {
  const [connection] = useAtom(dbConnectionAtom);
  const [query, setQuery] = useAtom(dbQueryAtom);

  const execute = useCallback(
    async (sql: string) => {
      if (!connection || !sql.trim()) return;

      setQuery({ sql, result: null, loading: true, error: null });

      try {
        const res = await authFetch('/api/db/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: connection.sessionId,
            sql: sql.trim(),
          }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as ExecuteResponse;
          setQuery({
            sql,
            result: null,
            loading: false,
            error: body.error || `HTTP ${res.status}`,
          });
          return;
        }

        const raw = (await res.json()) as ExecuteResponse;
        const result: QueryResult = {
          ...raw,
          columns: raw.columns ?? [],
          rows: raw.rows ?? [],
        };

        if (result.error) {
          setQuery({ sql, result: null, loading: false, error: result.error });
        } else {
          setQuery({ sql, result, loading: false, error: null });
        }
      } catch (e) {
        setQuery({
          sql,
          result: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Query failed',
        });
      }
    },
    [connection, setQuery],
  );

  const clearResult = useCallback(() => {
    setQuery({ sql: query.sql, result: null, loading: false, error: null });
  }, [query.sql, setQuery]);

  return {
    query,
    execute,
    clearResult,
  };
}
