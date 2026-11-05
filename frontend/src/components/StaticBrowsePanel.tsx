import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CommonTileContainer,
  useReportTileState,
  useTileSessionState,
} from './CommonTileContainer';
import { DENSE_TILE_BG } from '../store/appearance';
import { staticBrowseZoomAtom } from '../store/zoom';
import { RefreshIcon } from './icons';
import type { StaticBrowseSessionState } from '../wm/sessionState';

function paneIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('pane') ?? '';
}

function servePathBase(id: string): string {
  return `/staticserve/${encodeURIComponent(id)}`;
}

function isInsideServe(path: string, id: string): boolean {
  const base = servePathBase(id);
  return path === base || path.startsWith(`${base}/`);
}

function normalizeAddress(raw: string, id: string): string {
  const text = raw.trim();
  if (!text) throw new Error('empty');
  const base = new URL(`${servePathBase(id)}/`, window.location.origin);
  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    url = new URL(text);
  } else if (text.startsWith('/')) {
    url = new URL(text, window.location.origin);
  } else {
    url = new URL(text, base);
  }
  if (url.origin !== window.location.origin) {
    throw new Error('Only URLs on this Suwu origin can be previewed');
  }
  if (!isInsideServe(url.pathname, id)) {
    throw new Error(`URL must stay under ${servePathBase(id)}/`);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export default function StaticBrowsePanel() {
  const { t } = useTranslation();
  const paneId = useMemo(() => paneIdFromLocation(), []);
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const serveId = query.get('id') ?? '';
  const queryPath = query.get('path') || '/';

  const session = useTileSessionState<StaticBrowseSessionState>();
  const reportState = useReportTileState(paneId || undefined);

  const initialPath = isInsideServe(queryPath, serveId || '_')
    ? queryPath
    : `${servePathBase(serveId)}${queryPath.startsWith('/') ? queryPath : `/${queryPath}`}`;

  const [srcPath, setSrcPath] = useState(initialPath);
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [address, setAddress] = useState(serveId ? `${window.location.origin}${initialPath}` : '');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [locationKnown, setLocationKnown] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const restoredRef = useRef(false);

  const navigateTo = useCallback((path: string) => {
    setSrcPath(path);
    setCurrentPath(path);
    setAddress(`${window.location.origin}${path}`);
    setBridgeReady(false);
    setLocationKnown(false);
    setError(null);
  }, []);

  // Restore the last page once the WM delivers this pane's session state.
  useEffect(() => {
    if (restoredRef.current || !session || !serveId) return;
    restoredRef.current = true;
    if (session.id === serveId && session.path && isInsideServe(session.path, serveId)) {
      navigateTo(session.path);
    }
  }, [session, serveId, navigateTo]);

  useEffect(() => {
    if (!serveId || !locationKnown) return;
    reportState({ id: serveId, path: currentPath });
  }, [serveId, currentPath, locationKnown, reportState]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; href?: string } | undefined;
      if (data?.type === 'staticserve-ready') {
        setBridgeReady(true);
        return;
      }
      if (data?.type !== 'staticserve-location' || typeof data.href !== 'string' || !serveId) {
        return;
      }
      try {
        const url = new URL(data.href);
        if (url.origin !== window.location.origin) return;
        if (!isInsideServe(url.pathname, serveId)) return;
        setBridgeReady(true);
        setLocationKnown(true);
        setAddress(data.href);
        setCurrentPath(`${url.pathname}${url.search}${url.hash}`);
      } catch {
        // Ignore malformed reports.
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [serveId]);

  const submitAddress = useCallback(() => {
    if (!serveId) return;
    try {
      const path = normalizeAddress(address, serveId);
      if (path === currentPath) {
        if (bridgeReady) {
          iframeRef.current?.contentWindow?.postMessage({ type: 'staticserve-reload' }, '*');
        } else {
          setReloadKey((key) => key + 1);
        }
        setError(null);
        return;
      }
      navigateTo(path);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Invalid URL');
    }
  }, [address, bridgeReady, currentPath, navigateTo, serveId]);

  const reload = useCallback(() => {
    setError(null);
    if (bridgeReady) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'staticserve-reload' }, '*');
    } else {
      setReloadKey((key) => key + 1);
    }
  }, [bridgeReady]);

  if (!serveId) {
    return (
      <CommonTileContainer zoomAtom={staticBrowseZoomAtom} noPadding background={DENSE_TILE_BG}>
        <div className="grid h-full place-items-center px-6 text-center">
          <div className="text-sm text-white/55">{t('staticBrowse.noServe')}</div>
        </div>
      </CommonTileContainer>
    );
  }

  return (
    <CommonTileContainer zoomAtom={staticBrowseZoomAtom} noPadding background={DENSE_TILE_BG}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-1.5 rounded-t-[6px] border-b border-white/[0.06] px-2 py-1.5 pr-56 glass-control">
          <button
            type="button"
            onClick={reload}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/35 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/75 active:scale-90"
            title={t('staticBrowse.reload')}
          >
            <RefreshIcon className="h-3.5 w-3.5" />
          </button>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAddress();
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 rounded-md border border-white/[0.10] bg-white/[0.06] px-2 py-1 font-mono text-sm text-white/85 outline-none transition-colors placeholder-white/30 focus:border-cyan-400/40 focus:bg-white/[0.10]"
            placeholder={t('staticBrowse.addressPlaceholder')}
          />
        </div>

        {error && (
          <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 bg-white">
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={srcPath}
            title={`staticbrowse-${paneId}`}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            referrerPolicy="unsafe-url"
            className="h-full w-full border-0"
          />
        </div>
      </div>
    </CommonTileContainer>
  );
}
