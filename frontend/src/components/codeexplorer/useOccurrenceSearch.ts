import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../../lib/api';
import type { SearchResponse, SearchSelection } from './search';

export function useOccurrenceSearch(selection: SearchSelection | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState('');
  const [extension, setExtension] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const search = useCallback(async (text: string, dir: string, ext: string) => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await authFetch('/api/files/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, directory: dir, extension: ext }),
        signal: request.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      if (!request.signal.aborted) setResult(body as SearchResponse);
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'HTTP request failed');
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selection) return;
    controller.current?.abort();
    setOpen(true);
    setQuery(selection.query);
    setDirectory(selection.directory);
    setExtension(selection.extension);
    setResult(null);
    setError(null);
    setLoading(false);
    if (!selection.custom) void search(selection.query, selection.directory, selection.extension);
  }, [selection, search]);

  useEffect(() => () => controller.current?.abort(), []);

  const close = useCallback(() => {
    controller.current?.abort();
    setLoading(false);
    setOpen(false);
  }, []);

  return {
    open,
    query,
    directory,
    setDirectory,
    extension,
    setExtension,
    result,
    loading,
    error,
    close,
    hasSearch: selection !== null,
    reopen: () => setOpen(true),
    run: () => void search(query, directory, extension),
  };
}
