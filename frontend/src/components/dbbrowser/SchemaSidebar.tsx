import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TableInfo, ColumnInfo } from '../../store/dbbrowser'
import { authFetch } from '../../lib/api'

interface SchemaSidebarProps {
  tables: TableInfo[]
  sessionId: string
  onInsertSQL: (sql: string) => void
  onRefresh?: () => void
}

export default function SchemaSidebar({
  tables,
  sessionId,
  onInsertSQL,
  onRefresh,
}: SchemaSidebarProps) {
  const { t } = useTranslation()
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<Record<string, ColumnInfo[]>>({})
  const [loadingColumns, setLoadingColumns] = useState<string | null>(null)

  const handleExpandTable = useCallback(
    async (tableName: string) => {
      if (expandedTable === tableName) {
        setExpandedTable(null)
        return
      }

      setExpandedTable(tableName)

      // Load columns if not already cached
      if (!columns[tableName]) {
        setLoadingColumns(tableName)
        try {
          const res = await authFetch(
            `/api/db/describe?session=${sessionId}&table=${tableName}`,
          )
          if (res.ok) {
            const cols = (await res.json()) as ColumnInfo[]
            setColumns((prev) => ({ ...prev, [tableName]: cols }))
          }
        } catch {
          // silent
        } finally {
          setLoadingColumns(null)
        }
      }
    },
    [expandedTable, columns, sessionId],
  )

  const handleSelectAll = useCallback(
    (tableName: string) => {
      onInsertSQL(`SELECT * FROM ${tableName} LIMIT 100`)
    },
    [onInsertSQL],
  )

  const handleInsertColumn = useCallback(
    (columnName: string) => {
      onInsertSQL(columnName)
    },
    [onInsertSQL],
  )

  const handleCount = useCallback(
    (tableName: string) => {
      onInsertSQL(`SELECT COUNT(*) AS count FROM ${tableName}`)
    },
    [onInsertSQL],
  )

  const tables_ = tables.filter((t) => t.type === 'table')
  const views = tables.filter((t) => t.type === 'view')

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.02]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-1.5">
        <span className="font-semibold tracking-wide text-white/60">
          {t('dbbrowser.schema')}
        </span>
        <div className="flex-1" />
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="grid h-4 w-4 place-items-center rounded text-white/30 transition-colors hover:bg-white/[0.08] hover:text-white/60"
            title="Refresh"
          >
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" />
              <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {tables.length === 0 && (
          <div className="px-3 py-6 text-center text-white/30">
            {t('dbbrowser.noTables')}
          </div>
        )}

        {/* Tables */}
        {tables_.length > 0 && (
          <div className="py-1">
            <div className="px-2.5 py-1 font-semibold uppercase tracking-wider text-white/30">
              {t('dbbrowser.tables')} ({tables_.length})
            </div>
            {tables_.map((table) => (
              <TableItem
                key={table.name}
                table={table}
                isExpanded={expandedTable === table.name}
                columns={columns[table.name]}
                isLoadingColumns={loadingColumns === table.name}
                onExpand={() => handleExpandTable(table.name)}
                onSelectAll={() => handleSelectAll(table.name)}
                onCount={() => handleCount(table.name)}
                onInsertColumn={handleInsertColumn}
              />
            ))}
          </div>
        )}

        {/* Views */}
        {views.length > 0 && (
          <div className="py-1">
            <div className="px-2.5 py-1 font-semibold uppercase tracking-wider text-white/30">
              {t('dbbrowser.views')} ({views.length})
            </div>
            {views.map((view) => (
              <TableItem
                key={view.name}
                table={view}
                isExpanded={expandedTable === view.name}
                columns={columns[view.name]}
                isLoadingColumns={loadingColumns === view.name}
                onExpand={() => handleExpandTable(view.name)}
                onSelectAll={() => handleSelectAll(view.name)}
                onCount={() => handleCount(view.name)}
                onInsertColumn={handleInsertColumn}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface TableItemProps {
  table: TableInfo
  isExpanded: boolean
  columns?: ColumnInfo[]
  isLoadingColumns: boolean
  onExpand: () => void
  onSelectAll: () => void
  onCount: () => void
  onInsertColumn: (columnName: string) => void
}

function TableItem({
  table,
  isExpanded,
  columns,
  isLoadingColumns,
  onExpand,
  onSelectAll,
  onCount,
  onInsertColumn,
}: TableItemProps) {
  return (
    <div>
      {/* Table row */}
      <div className="group flex items-center gap-1 px-2 py-0.5 transition-colors hover:bg-white/[0.04]">
        <button
          type="button"
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="text-white/30">{isExpanded ? '▼' : '▶'}</span>
          <svg className="h-3 w-3 shrink-0 text-amber-400/60" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
          </svg>
          <span className="truncate text-white/70">{table.name}</span>
        </button>
        {/* Quick actions on hover */}
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onSelectAll}
            className="rounded px-1 py-0.5 text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60"
            title="SELECT *"
          >
            ⚡
          </button>
          <button
            type="button"
            onClick={onCount}
            className="rounded px-1 py-0.5 text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60"
            title="COUNT(*)"
          >
            #
          </button>
        </div>
      </div>

      {/* Expanded columns */}
      {isExpanded && (
        <div className="ml-4 border-l border-white/[0.06] pl-2">
          {isLoadingColumns && (
            <div className="px-2 py-1 text-white/30">Loading...</div>
          )}
          {columns?.map((col) => (
            <button
              key={col.name}
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left transition-colors hover:bg-white/[0.04]"
              onClick={() => onInsertColumn(col.name)}
              title={`Insert ${col.name}`}
            >
              {col.isPrimaryKey && (
                <span className="text-amber-400/80">🔑</span>
              )}
              <span className="truncate text-white/60">{col.name}</span>
              <span className="text-white/25">{col.dataType}</span>
            </button>
          ))}
          {!isLoadingColumns && columns?.length === 0 && (
            <div className="px-2 py-1 text-white/30">No columns</div>
          )}
        </div>
      )}
    </div>
  )
}
