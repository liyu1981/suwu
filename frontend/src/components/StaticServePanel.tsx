import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommonTileContainer } from './CommonTileContainer';
import { DENSE_TILE_BG } from '../store/appearance';
import { staticServeZoomAtom } from '../store/zoom';
import { authFetch } from '../lib/api';
import { formatDate } from '../lib/format';
import { CheckIcon, CopyIcon, RefreshIcon, TrashIcon } from './icons';

interface StaticServeStatus {
  id: string;
  dir: string;
  prefix: string;
  status: 'running' | 'paused';
  createdAt: string;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await authFetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res.json();
}

function paneIdFromLocation(): string {
  return new URLSearchParams(window.location.search).get('pane') ?? '';
}

const btnBase =
  'rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30';
const btnOpen = `${btnBase} bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 hover:text-cyan-200`;
const btnPause = `${btnBase} bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200`;
const btnDanger = `${btnBase} bg-red-500/15 text-red-400/80 hover:bg-red-500/25 hover:text-red-400`;

export default function StaticServePanel() {
  const { t } = useTranslation();
  const [serves, setServes] = useState<StaticServeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const paneId = paneIdFromLocation();

  const fetchList = useCallback(async () => {
    try {
      const data = (await api('/api/staticserve/list')) as { serves?: StaticServeStatus[] };
      setServes(Array.isArray(data.serves) ? data.serves : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load static serves');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchList();
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchList();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [fetchList]);

  const act = useCallback(
    async (action: 'pause' | 'resume' | 'remove', id: string) => {
      try {
        const init: RequestInit = {
          method: action === 'remove' ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        };
        await api(`/api/staticserve/${action}`, init);
        setConfirmDelete(null);
        await fetchList();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Action failed');
      }
    },
    [fetchList],
  );

  const openBrowse = useCallback(
    (id: string) => {
      window.parent?.postMessage(
        {
          type: 'wm-open-tile',
          tileType: 'staticbrowse',
          params: { id, path: '/' },
          sourcePane: paneId || undefined,
        },
        '*',
      );
    },
    [paneId],
  );

  const copyEndpoint = useCallback(async (prefix: string) => {
    const url = `${window.location.origin}${prefix}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(prefix);
      window.setTimeout(() => setCopied((current) => (current === prefix ? null : current)), 1200);
    } catch {
      // Clipboard may be unavailable on plain HTTP outside localhost.
    }
  }, []);

  return (
    <CommonTileContainer zoomAtom={staticServeZoomAtom} noPadding background={DENSE_TILE_BG}>
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 rounded-t-[6px] border-b border-white/[0.06] px-3 py-2 glass-control">
          <button
            type="button"
            onClick={() => void fetchList()}
            className="grid h-5 w-5 place-items-center rounded-md text-white/30 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/60 active:scale-90"
            title={t('staticServe.refresh')}
          >
            <RefreshIcon className="h-3 w-3" />
          </button>
          <span className="text-base font-semibold tracking-wide text-white/60">
            {t('staticServe.title')}
          </span>
          <span className="text-[10px] tabular-nums text-white/30">{serves.length}</span>
          <div className="flex-1" />
        </div>

        {error && (
          <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
          {loading ? (
            <div className="grid h-full place-items-center text-xs text-white/35">…</div>
          ) : serves.length === 0 ? (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <div className="text-sm text-white/60">{t('staticServe.emptyTitle')}</div>
                <div className="mt-1 text-xs text-white/35">{t('staticServe.emptyHint')}</div>
                <code className="mt-3 inline-block rounded-md bg-white/[0.06] px-2 py-1 text-xs text-cyan-300">
                  suwu static-serve &lt;dir&gt;
                </code>
              </div>
            </div>
          ) : (
            serves.map((serve) => {
              const running = serve.status === 'running';
              return (
                <div
                  key={serve.id}
                  className="rounded-[6px] border border-white/[0.08] bg-white/[0.04] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        running ? 'bg-green-500' : 'bg-amber-400'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-white/85">
                      {serve.id}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-white/35">
                      {t(`staticServe.status_${serve.status}`)}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {running ? (
                        <button
                          type="button"
                          className={btnOpen}
                          onClick={() => openBrowse(serve.id)}
                        >
                          {t('staticServe.open')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={btnPause}
                          onClick={() => void act('resume', serve.id)}
                        >
                          {t('staticServe.resume')}
                        </button>
                      )}
                      {running && (
                        <button
                          type="button"
                          className={btnPause}
                          onClick={() => void act('pause', serve.id)}
                        >
                          {t('staticServe.pause')}
                        </button>
                      )}
                      {confirmDelete === serve.id ? (
                        <>
                          <button
                            type="button"
                            className={btnDanger}
                            onClick={() => void act('remove', serve.id)}
                          >
                            {t('staticServe.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            className={btnPause}
                            onClick={() => setConfirmDelete(null)}
                          >
                            {t('staticServe.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={btnDanger}
                          onClick={() => setConfirmDelete(serve.id)}
                          title={t('staticServe.delete')}
                        >
                          <TrashIcon className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-white/40"
                      title={serve.dir}
                    >
                      {serve.dir}
                    </span>
                    <span className="text-[10px] text-white/25">{formatDate(serve.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-cyan-300/90">
                      {serve.prefix}
                    </span>
                    <button
                      type="button"
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/30 transition hover:bg-white/[0.08] hover:text-white/70"
                      onClick={() => void copyEndpoint(serve.prefix)}
                      title={t('staticServe.copy')}
                    >
                      {copied === serve.prefix ? (
                        <CheckIcon className="h-3 w-3 text-green-400" />
                      ) : (
                        <CopyIcon className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </CommonTileContainer>
  );
}
