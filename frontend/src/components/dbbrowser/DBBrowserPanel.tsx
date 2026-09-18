import { useState, useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { CommonTileContainer } from '../CommonTileContainer';
import { dbbrowserZoomAtom } from '../../store/zoom';
import { useDBSession } from './hooks/useDBSession';
import { useDBQuery } from './hooks/useDBQuery';
import ConnectionDialog from './ConnectionDialog';
import SQLEditor from './SQLEditor';
import DataTable from './DataTable';
import SchemaSidebar from './SchemaSidebar';
import StatusBar from './StatusBar';

const btnPrimary =
  'rounded-lg bg-cyan-500/25 px-3 py-1.5 text-xs font-medium text-cyan-300 transition-all hover:bg-cyan-500/35 hover:text-cyan-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30';

/** localStorage key + bounds (px) for the resizable schema sidebar. */
const SCHEMA_WIDTH_KEY = 'suwu_db_schema_width';
const SCHEMA_DEFAULT_WIDTH = 192;
const SCHEMA_MIN_WIDTH = 160;
const SCHEMA_MIN_CONTENT = 200;

function loadSchemaWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SCHEMA_WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= SCHEMA_MIN_WIDTH) return raw;
  } catch {
    // ignore
  }
  return SCHEMA_DEFAULT_WIDTH;
}

export default function DBBrowserPanel() {
  const { t } = useTranslation();
  const {
    connection,
    schema,
    savedConnections,
    connect,
    disconnect,
    refreshSchema,
    deleteConnection,
  } = useDBSession();
  const { query, execute } = useDBQuery();

  const [sql, setSql] = useState('');

  const zoom = useAtomValue(dbbrowserZoomAtom);
  const splitRef = useRef<HTMLDivElement>(null);
  const [schemaWidth, setSchemaWidth] = useState(loadSchemaWidth);
  const schemaWidthRef = useRef(schemaWidth);

  const startSchemaResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();

      // `zoom` scales the whole document, so pointer deltas are in zoomed px.
      const scale = zoom || 1;
      const startX = e.clientX;
      const startWidth = schemaWidthRef.current;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const containerW = splitRef.current
          ? splitRef.current.getBoundingClientRect().width / scale
          : startWidth + SCHEMA_MIN_CONTENT;
        const maxWidth = Math.max(SCHEMA_MIN_WIDTH, containerW - SCHEMA_MIN_CONTENT);
        const next = Math.min(
          Math.max(startWidth + (ev.clientX - startX) / scale, SCHEMA_MIN_WIDTH),
          maxWidth,
        );
        schemaWidthRef.current = next;
        setSchemaWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try {
          localStorage.setItem(SCHEMA_WIDTH_KEY, String(schemaWidthRef.current));
        } catch {
          // ignore
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [zoom],
  );

  const handleExecute = useCallback(() => {
    if (sql.trim()) {
      execute(sql);
    }
  }, [sql, execute]);

  const handleInsertSQL = useCallback((newSql: string) => {
    setSql((prev) => {
      // If there's existing text, append on new line
      if (prev.trim()) {
        return `${prev}\n${newSql}`;
      }
      return newSql;
    });
  }, []);

  const connected = !!connection;

  return (
    <CommonTileContainer zoomAtom={dbbrowserZoomAtom} noPadding>
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="text-base font-semibold tracking-wide text-white/60">
            {t('dbbrowser.title')}
          </span>
          {connection && (
            <>
              <span className="text-[10px] text-white/30">•</span>
              <span className="text-[11px] text-white/40">
                {connection.driver.toUpperCase()} • {connection.database}
              </span>
            </>
          )}
          <div className="flex-1" />
        </div>

        {/* Main content */}
        {!connected ? (
          <div className="flex-1 overflow-auto p-2">
            <ConnectionDialog
              savedConnections={savedConnections}
              onConnect={connect}
              onDelete={deleteConnection}
            />
          </div>
        ) : (
          <div ref={splitRef} className="flex min-h-0 flex-1">
            {/* Schema sidebar (resizable) */}
            <div className="shrink-0 p-1.5 pr-0" style={{ width: schemaWidth }}>
              <SchemaSidebar
                tables={schema}
                sessionId={connection.sessionId}
                onInsertSQL={handleInsertSQL}
                onRefresh={refreshSchema}
              />
            </div>

            {/* Resize handle */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('dbbrowser.resizeSchema')}
              title={t('dbbrowser.resizeSchema')}
              onPointerDown={startSchemaResize}
              className="group relative w-1.5 shrink-0 cursor-col-resize touch-none"
            >
              <div className="absolute inset-y-1.5 left-1/2 w-px -translate-x-1/2 rounded-full bg-white/[0.08] transition-colors group-hover:bg-cyan-400/60 group-active:bg-cyan-400" />
            </div>

            {/* Right panel: editor + table */}
            <div className="flex min-w-0 flex-1 flex-col p-1.5">
              {/* SQL Editor */}
              <div className="flex h-[35%] shrink-0 flex-col pb-1.5">
                <div className="flex shrink-0 items-center gap-2 pb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-white/30">
                    {t('dbbrowser.sqlEditor')}
                  </span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={handleExecute}
                    disabled={!sql.trim() || query.loading}
                    className={btnPrimary}
                  >
                    {query.loading ? '...' : t('dbbrowser.execute')}
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <SQLEditor value={sql} onChange={setSql} onExecute={handleExecute} />
                </div>
              </div>

              {/* Results */}
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 pb-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-white/30">
                    {t('dbbrowser.results')}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  {query.result && !query.error ? (
                    <DataTable result={query.result} />
                  ) : query.error ? (
                    <div className="flex h-full items-center justify-center rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                      <div className="max-w-md text-center text-[11px] text-red-400/80">
                        {query.error}
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02]">
                      <div className="text-center text-[11px] text-white/25">
                        {t('dbbrowser.noResults')}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Status bar */}
        <StatusBar query={query} connected={connected} onDisconnect={disconnect} />
      </div>
    </CommonTileContainer>
  );
}
