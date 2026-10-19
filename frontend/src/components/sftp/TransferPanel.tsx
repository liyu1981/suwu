import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUpIcon } from '../icons';

/** One row in the transfer queue. */
export interface TransferItem {
  id: number;
  name: string;
  /** e.g. "Left → Right". */
  detail: string;
  /** Total bytes, or 0 when unknown (server-side transfer). */
  total: number;
  loaded: number;
  state: 'running' | 'done' | 'error';
  message?: string;
}

/** One line in the message log. */
export interface LogLine {
  id: number;
  time: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

function percent(item: TransferItem): number {
  if (item.state === 'done') return 100;
  if (item.total <= 0) return 0;
  return Math.min(100, Math.round((item.loaded / item.total) * 100));
}

/**
 * FileZilla-style bottom panel: a transfer queue with progress bars beside a
 * timestamped message log. Collapses to its header; drag the top edge to
 * resize.
 */
export function TransferPanel({
  transfers,
  logs,
  height,
  collapsed,
  onToggle,
  onResizeStart,
  onClear,
}: {
  transfers: TransferItem[];
  logs: LogLine[];
  height: number;
  collapsed: boolean;
  onToggle: () => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const active = transfers.filter((item) => item.state === 'running').length;

  return (
    <div className="flex shrink-0 flex-col border-t border-white/[0.06]" style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onResizeStart}
        className="h-1 shrink-0 cursor-row-resize bg-white/[0.05] transition-colors hover:bg-sky-400/40"
      />
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-white/[0.04] px-3">
        <span className="text-[11px] font-medium text-white/55">
          {t('sftp.transfers')}
          {active > 0 && <span className="ml-1 text-sky-300/80">({active})</span>}
        </span>
        <span className="text-[11px] font-medium text-white/55">{t('sftp.log')}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClear}
          className="rounded px-1.5 py-0.5 text-[10px] text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/70"
        >
          {t('sftp.clear')}
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="grid h-5 w-5 place-items-center rounded text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          title={collapsed ? t('sftp.expand') : t('sftp.collapse')}
        >
          <ChevronUpIcon className={`h-3.5 w-3.5 ${collapsed ? '' : 'rotate-180'}`} />
        </button>
      </div>

      {!collapsed && (
        <div className="flex min-h-0 flex-1">
          {/* Transfer queue */}
          <div className="scrollbar-thin min-w-0 flex-1 overflow-auto border-r border-white/[0.06]">
            {transfers.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-white/25">{t('sftp.noTransfers')}</p>
            ) : (
              transfers.map((item) => {
                const pct = percent(item);
                return (
                  <div key={item.id} className="border-b border-white/[0.03] px-3 py-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span
                        className={
                          item.state === 'error'
                            ? 'text-red-300/80'
                            : item.state === 'done'
                              ? 'text-emerald-300/80'
                              : 'text-sky-300/80'
                        }
                      >
                        {item.state === 'error' ? '✕' : item.state === 'done' ? '✓' : '↻'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-white/70" title={item.name}>
                        {item.name}
                      </span>
                      <span className="shrink-0 text-white/30">{item.detail}</span>
                      {item.state === 'running' && item.total > 0 && (
                        <span className="w-9 shrink-0 text-right tabular-nums text-white/40">
                          {pct}%
                        </span>
                      )}
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                      {item.state === 'running' && item.total <= 0 ? (
                        <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-400/50" />
                      ) : (
                        <div
                          className={`h-full rounded-full transition-[width] duration-150 ${
                            item.state === 'error'
                              ? 'bg-red-400/60'
                              : item.state === 'done'
                                ? 'bg-emerald-400/60'
                                : 'bg-sky-400/60'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </div>
                    {item.message && (
                      <div className="mt-0.5 truncate text-[10px] text-red-300/70">
                        {item.message}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Message log */}
          <div className="scrollbar-thin min-w-0 flex-1 overflow-auto px-3 py-1.5">
            {logs.length === 0 ? (
              <p className="py-1.5 text-[11px] text-white/25">{t('sftp.noLog')}</p>
            ) : (
              logs.map((line) => (
                <div key={line.id} className="flex gap-2 py-0.5 text-[11px] leading-relaxed">
                  <span className="shrink-0 tabular-nums text-white/20">{line.time}</span>
                  <span
                    className={
                      line.tone === 'error'
                        ? 'text-red-300/80'
                        : line.tone === 'success'
                          ? 'text-emerald-300/75'
                          : 'text-white/45'
                    }
                  >
                    {line.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
