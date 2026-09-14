import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CommonTileContainer } from '../CommonTileContainer'
import { dbbrowserZoomAtom } from '../../store/zoom'
import { useDBSession } from './hooks/useDBSession'
import { useDBQuery } from './hooks/useDBQuery'
import ConnectionDialog from './ConnectionDialog'
import SQLEditor from './SQLEditor'
import DataTable from './DataTable'
import SchemaSidebar from './SchemaSidebar'
import StatusBar from './StatusBar'

const btnPrimary =
  'rounded-lg bg-cyan-500/25 px-3 py-1.5 font-medium text-cyan-300 transition-all hover:bg-cyan-500/35 hover:text-cyan-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30'

export default function DBBrowserPanel() {
  const { t } = useTranslation()
  const {
    connection,
    schema,
    savedConnections,
    connect,
    disconnect,
    refreshSchema,
    saveConnection,
    deleteConnection,
  } = useDBSession()
  const { query, execute } = useDBQuery()

  const [sql, setSql] = useState('')

  const handleExecute = useCallback(() => {
    if (sql.trim()) {
      execute(sql)
    }
  }, [sql, execute])

  const handleInsertSQL = useCallback((newSql: string) => {
    setSql((prev) => {
      // If there's existing text, append on new line
      if (prev.trim()) {
        return `${prev}\n${newSql}`
      }
      return newSql
    })
  }, [])

  const connected = !!connection

  return (
    <CommonTileContainer zoomAtom={dbbrowserZoomAtom} noPadding>
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="font-semibold tracking-wide text-white/60">
            {t('dbbrowser.title')}
          </span>
          {connection && (
            <>
              <span className="text-white/30">•</span>
              <span className="text-white/40">
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
              onSave={saveConnection}
              onDelete={deleteConnection}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Schema sidebar */}
            <div className="w-48 shrink-0 border-r border-white/[0.06] p-1.5">
              <SchemaSidebar
                tables={schema}
                sessionId={connection.sessionId}
                onInsertSQL={handleInsertSQL}
                onRefresh={refreshSchema}
              />
            </div>

            {/* Right panel: editor + table */}
            <div className="flex min-w-0 flex-1 flex-col p-1.5">
              {/* SQL Editor */}
              <div className="h-[35%] shrink-0 pb-1.5">
                <SQLEditor
                  value={sql}
                  onChange={setSql}
                  onExecute={handleExecute}
                />
              </div>

              {/* Execute button */}
              <div className="flex shrink-0 items-center gap-2 pb-1.5">
                <button
                  type="button"
                  onClick={handleExecute}
                  disabled={!sql.trim() || query.loading}
                  className={btnPrimary}
                >
                  {query.loading ? '...' : t('dbbrowser.execute')}
                </button>
              </div>

              {/* Data Table */}
              <div className="min-h-0 flex-1">
                {query.result && !query.error ? (
                  <DataTable result={query.result} />
                ) : query.error ? (
                  <div className="flex h-full items-center justify-center rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                    <div className="max-w-md text-center text-red-400/80">
                      {query.error}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02]">
                    <div className="text-center text-white/25">
                      {t('dbbrowser.noResults')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Status bar */}
        <StatusBar query={query} connected={connected} onDisconnect={disconnect} />
      </div>
    </CommonTileContainer>
  )
}
