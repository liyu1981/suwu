import { useEffect, useState } from 'react';
import { authFetch } from '../../lib/api';

const SUGGESTION_DEBOUNCE_MS = 250;

/**
 * Fetch the file extensions present in a directory for the search typeahead.
 * Debounced so typing a directory path does not spawn a scan per keystroke.
 * Best-effort: on any error the caller keeps its static fallback list.
 */
export function useExtensionSuggestions(directory: string, enabled: boolean): string[] {
  const [extensions, setExtensions] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled || !directory.startsWith('/')) {
      setExtensions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      authFetch(`/api/files/extensions?path=${encodeURIComponent(directory)}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (controller.signal.aborted) return;
          const list = Array.isArray(data?.extensions) ? data.extensions : [];
          setExtensions(list.filter((item: unknown): item is string => typeof item === 'string'));
        })
        .catch(() => {});
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [directory, enabled]);

  return extensions;
}
