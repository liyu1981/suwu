import { useTranslation } from 'react-i18next';
import type { QueryExecution } from '../../store/dbbrowser';

interface StatusBarProps {
  query: QueryExecution;
  connected: boolean;
  onDisconnect: () => void;
}

export default function StatusBar({ query, connected, onDisconnect }: StatusBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] px-3 py-1.5 text-[10px]">
      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        <div className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-white/20'}`} />
        <span className="text-white/40">
          {connected ? t('dbbrowser.connected') : t('dbbrowser.disconnected')}
        </span>
      </div>

      {/* Query status */}
      {query.loading && <span className="text-cyan-400/80">{t('dbbrowser.executing')}</span>}

      {query.error && <span className="truncate text-red-400/80">{query.error}</span>}

      {query.result && !query.error && (
        <>
          <span className="tabular-nums text-white/40">
            {query.result.rows.length} row{query.result.rows.length !== 1 ? 's' : ''}
          </span>
          <span className="tabular-nums text-white/30">{query.result.milliseconds}ms</span>
          {query.result.truncated && (
            <span className="text-amber-400/80">
              {t('dbbrowser.truncateWarning', { max: '10,000' })}
            </span>
          )}
          {query.result.rowsAffected > 0 && (
            <span className="text-white/40">{query.result.rowsAffected} affected</span>
          )}
        </>
      )}

      <div className="flex-1" />

      {/* Shortcut hint */}
      {!connected && <span className="text-white/25">{t('dbbrowser.executeHint')}</span>}

      {/* Disconnect button */}
      {connected && (
        <button
          type="button"
          onClick={onDisconnect}
          className="rounded px-2 py-0.5 text-xs text-red-400/80 transition-all hover:bg-red-500/15 hover:text-red-400"
        >
          {t('dbbrowser.disconnect')}
        </button>
      )}
    </div>
  );
}
