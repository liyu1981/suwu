import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  CommonTileContainer,
  useReportTileState,
  useTileSessionState,
} from '../CommonTileContainer';
import { resthelperZoomAtom } from '../../store/zoom';
import { hostOf } from '../../lib/cookie-jar';
import {
  newId,
  restDraftAtom,
  restOptionsAtom,
  toSendPayload,
  type HttpMethod,
  type RestHistoryEntry,
  type RestOptions,
  type RestRequestDraft,
} from '../../store/resthelper';
import type { RestHelperSessionState } from '../../wm/sessionState';
import RequestBuilder from './RequestBuilder';
import ResponseViewer from './ResponseViewer';
import SaveRequestDialog from './SaveRequestDialog';
import SidebarTabs from './SidebarTabs';
import { useRestCollections } from './hooks/useRestCollections';
import { useRestCookies } from './hooks/useRestCookies';
import { useRestHistory } from './hooks/useRestHistory';
import { useRestRequest } from './hooks/useRestRequest';

/** Slightly more opaque than the shared tile background for legible request/response text. */
const REST_TILE_BG = 'rgba(22, 22, 25, 0.97)';

function cloneDraft(draft: RestRequestDraft): RestRequestDraft {
  return {
    ...draft,
    headers: draft.headers.map((header) => ({ ...header })),
    params: draft.params.map((param) => ({ ...param })),
    formData: draft.formData.map((entry) => ({ ...entry })),
  };
}

/** Resolve a possibly-relative URL against the current origin (the backend needs absolute URLs). */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url || '/', window.location.origin).toString();
  } catch {
    return url;
  }
}

export function RestHelperPanel({ paneId }: { paneId?: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useAtom(restDraftAtom);
  const [options, setOptions] = useAtom(restOptionsAtom);
  const { state, execute, cancel } = useRestRequest();
  const history = useRestHistory();
  const collections = useRestCollections();
  const cookieJar = useRestCookies();
  const saved = useTileSessionState<RestHelperSessionState>();
  const reportState = useReportTileState();
  const restoredRef = useRef(false);
  const [restored, setRestored] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const markRestored = useCallback(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    setRestored(true);
  }, []);

  const patchDraft = useCallback(
    (partial: Partial<RestRequestDraft>) => setDraft((prev) => ({ ...prev, ...partial })),
    [setDraft],
  );

  const patchOptions = useCallback(
    (partial: Partial<RestOptions>) => setOptions((prev) => ({ ...prev, ...partial })),
    [setOptions],
  );

  // Apply a URL query override first (it wins over the saved session).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qUrl = params.get('url');
    const qMethod = params.get('method');
    if (qUrl || qMethod) {
      setDraft((prev) => ({
        ...prev,
        url: qUrl ?? prev.url,
        method: (qMethod as HttpMethod) ?? prev.method,
      }));
      markRestored();
    }
  }, [setDraft, markRestored]);

  // Restore the saved draft once the WM delivers it, unless already restored.
  useEffect(() => {
    if (restoredRef.current || !saved?.draft) return;
    setDraft(cloneDraft(saved.draft));
    markRestored();
  }, [saved, setDraft, markRestored]);

  // No saved state: stop withholding reports after the WM's fallback window.
  useEffect(() => {
    const timer = setTimeout(() => markRestored(), 400);
    return () => clearTimeout(timer);
  }, [markRestored]);

  // Persist the draft into tile session state (after restore, to avoid clobbering).
  useEffect(() => {
    if (!restored) return;
    reportState({ draft });
  }, [draft, restored, reportState]);

  const resolvedUrl = useMemo(() => absoluteUrl(draft.url), [draft.url]);
  const targetHost = useMemo(() => hostOf(resolvedUrl), [resolvedUrl]);
  const currentHost = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';

  const handleSend = useCallback(async () => {
    if (!draft.url.trim() || state.loading) return;
    const url = absoluteUrl(draft.url);
    const cookieHeader = options.useCookieJar ? cookieJar.headerFor(url) : '';
    const payload = toSendPayload({ ...draft, url }, options, navigator.userAgent, cookieHeader);
    const response = await execute(payload);
    if (!response) return;

    void history.add({
      id: newId('hist'),
      method: payload.method,
      url: payload.url,
      status: response.status,
      durationMs: response.durationMs,
      timestamp: Date.now(),
      request: cloneDraft({ ...draft, url }),
    });

    if (options.captureCookies && response.status !== 0) {
      cookieJar.capture(url, response);
    }
  }, [draft, options, cookieJar, execute, history, state.loading]);

  // Keyboard: Ctrl/Cmd+Enter sends, Escape cancels.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleSend();
      } else if (event.key === 'Escape' && state.loading) {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSend, state.loading, cancel]);

  const handleSave = useCallback(
    (name: string, collectionName: string) => {
      const existing = collections.collections.find(
        (collection) => collection.name === collectionName,
      );
      const collectionId = existing?.id ?? newId('coll');
      void collections.save(collectionId, collectionName, name, cloneDraft(draft));
    },
    [collections, draft],
  );

  return (
    <CommonTileContainer
      paneId={paneId}
      zoomAtom={resthelperZoomAtom}
      noPadding
      background={REST_TILE_BG}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="text-base font-semibold tracking-wide text-white/60">
            {t('plugin.resthelper')}
          </span>
          {targetHost && (
            <>
              <span className="text-[10px] text-white/30">•</span>
              <span className="truncate text-[11px] text-white/40">{targetHost}</span>
            </>
          )}
          <div className="flex-1" />
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 border-r border-white/[0.06] p-1.5">
            <SidebarTabs
              history={history.entries}
              collections={collections.collections}
              onOpenHistory={(entry: RestHistoryEntry) => setDraft(cloneDraft(entry.request))}
              onOpenSaved={(savedRequest) => setDraft(cloneDraft(savedRequest.request))}
              onRemoveHistory={(id) => void history.remove(id)}
              onClearHistory={() => void history.clear()}
              onRemoveRequest={(collectionId, requestId) =>
                void collections.removeRequest(collectionId, requestId)
              }
              onRemoveCollection={(collectionId) => void collections.removeCollection(collectionId)}
            />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col p-2">
            <div className="h-[48%] min-h-0 shrink-0 pb-2">
              <RequestBuilder
                draft={draft}
                patch={patchDraft}
                options={options}
                patchOptions={patchOptions}
                loading={state.loading}
                onSend={() => void handleSend()}
                onCancel={cancel}
                onSave={() => setSaveOpen(true)}
                cookies={cookieJar.cookies}
                targetHost={targetHost}
                currentHost={currentHost}
                onImportBrowser={() => void cookieJar.importFromBrowser(targetHost)}
                onImportString={(raw) => void cookieJar.importString(targetHost, raw)}
                onAddCookie={(cookie) => void cookieJar.upsert(cookie)}
                onRemoveCookie={(id) => void cookieJar.remove(id)}
                onClearCookies={() => void cookieJar.clearAll()}
              />
            </div>

            <div className="min-h-0 flex-1">
              <ResponseViewer
                response={state.response}
                request={state.request}
                loading={state.loading}
              />
            </div>

            <StatusBar />
          </main>
        </div>
      </div>

      <SaveRequestDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        collections={collections.collections}
        onSave={handleSave}
      />
    </CommonTileContainer>
  );
}

function StatusBar() {
  const [options] = useAtom(restOptionsAtom);
  const cookieLabel = options.useCookieJar ? 'cookies on' : 'cookies off';
  return (
    <div className="flex shrink-0 items-center gap-3 pt-1.5 text-[10px] text-white/30">
      <span>Ctrl/Cmd+Enter to send</span>
      <span>· {cookieLabel}</span>
      {options.insecureTLS && <span className="text-amber-300/70">· TLS verify off</span>}
      <div className="flex-1" />
      <span>REST Helper</span>
    </div>
  );
}
