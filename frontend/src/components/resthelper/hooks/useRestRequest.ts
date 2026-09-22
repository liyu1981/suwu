import { useCallback, useRef } from 'react';
import { useAtom } from 'jotai';
import { authFetch } from '../../../lib/api';
import {
  restResponseAtom,
  type RestResponseData,
  type RestSendPayload,
} from '../../../store/resthelper';

export interface RestRequestController {
  state: {
    loading: boolean;
    response: RestResponseData | null;
    request: RestSendPayload | null;
    sentAt: number;
  };
  execute: (payload: RestSendPayload) => Promise<RestResponseData | null>;
  cancel: () => void;
}

function normalizeStatusText(status: number, statusText: string | undefined): string {
  if (!statusText) return '';
  const prefix = `${status} `;
  return statusText.startsWith(prefix) ? statusText.slice(prefix.length) : statusText;
}

function transportFailure(error: string, kind: string, durationMs: number): RestResponseData {
  return {
    status: 0,
    statusText: '',
    headers: {},
    bodyB64: '',
    bodySize: 0,
    truncated: false,
    durationMs,
    finalUrl: '',
    redirects: [],
    insecureTLS: false,
    error,
    errorKind: kind,
  };
}

/** Execute requests through the stateless backend and tracks the response. */
export function useRestRequest() {
  const [state, setState] = useAtom(restResponseAtom);
  const abortRef = useRef<AbortController | null>(null);

  const execute = useCallback(
    async (payload: RestSendPayload): Promise<RestResponseData | null> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const sentAt = Date.now();
      setState({ loading: true, response: null, request: payload, sentAt });

      try {
        const res = await authFetch('/api/rest/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const response = transportFailure(text || `HTTP ${res.status}`, 'backend', 0);
          setState({ loading: false, response, request: payload, sentAt });
          return response;
        }

        const raw = (await res.json()) as RestResponseData;
        // Defend against Go nil-slice fields marshalling to null, and older
        // backends that returned the full status line in statusText.
        const data: RestResponseData = {
          ...raw,
          headers: raw.headers ?? {},
          redirects: raw.redirects ?? [],
          statusText: normalizeStatusText(raw.status, raw.statusText),
        };
        setState({ loading: false, response: data, request: payload, sentAt });
        return data;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState((prev) => ({ ...prev, loading: false }));
          return null;
        }
        const message = error instanceof Error ? error.message : 'request failed';
        const response = transportFailure(message, 'other', 0);
        setState({ loading: false, response, request: payload, sentAt });
        return response;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [setState],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Show a previously stored response without re-sending the request. */
  const restore = useCallback(
    (response: RestResponseData, request: RestSendPayload) => {
      abortRef.current?.abort();
      abortRef.current = null;
      setState({ loading: false, response, request, sentAt: Date.now() });
    },
    [setState],
  );

  /** Clear the response surface (e.g. when duplicating into a fresh request). */
  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ loading: false, response: null, request: null, sentAt: 0 });
  }, [setState]);

  return { state, execute, cancel, restore, clear };
}
