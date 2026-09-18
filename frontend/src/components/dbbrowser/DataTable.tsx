import { useMemo, useState, useCallback } from 'react';
import {
  useLegacyTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  type LegacyColumnDef as ColumnDef,
} from '@tanstack/react-table/legacy';
import { flexRender, type SortingState } from '@tanstack/react-table';
import type { QueryResult } from '../../store/dbbrowser';

const TRUNCATE_LENGTH = 50;

interface DataTableProps {
  result: QueryResult;
}

export default function DataTable({ result }: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expandedCell, setExpandedCell] = useState<{ colName: string; value: string } | null>(null);

  const columns = useMemo<ColumnDef<unknown[], unknown>[]>(() => {
    if (!result.columns.length) return [];
    return result.columns.map((col, colIndex) => ({
      id: col.name,
      accessorFn: (row: unknown[]) => row[colIndex],
      header: () => (
        <div className="flex items-center gap-1">
          <span>{col.name}</span>
          <span className="text-white/30">{col.dataType}</span>
        </div>
      ),
      cell: ({ getValue }: { getValue: () => unknown }) => {
        const value = getValue();
        const isNull = value === null || value === undefined;
        const strValue = isNull ? 'NULL' : String(value);
        const isLong = strValue.length > TRUNCATE_LENGTH;
        const displayValue = isLong ? strValue.slice(0, TRUNCATE_LENGTH) + '…' : strValue;

        return (
          <button
            type="button"
            className={`w-full cursor-pointer truncate text-left transition-colors duration-100 ${
              isNull ? 'text-white/25 italic' : 'text-white/80'
            } ${isLong ? 'hover:text-white hover:underline' : 'hover:bg-white/[0.06]'}`}
            onClick={() => {
              if (isLong) {
                setExpandedCell({ colName: col.name, value: strValue });
              }
            }}
            title={isLong ? 'Click to expand' : strValue}
          >
            {displayValue}
          </button>
        );
      },
    }));
  }, [result.columns]);

  const data = useMemo(() => result.rows ?? [], [result.rows]);

  const table = useLegacyTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 100,
      },
    },
  });

  const handleExportCsv = useCallback(() => {
    if (!result.columns.length || !result.rows.length) return;

    const headers = result.columns.map((c) => c.name);
    const csvRows = [headers.join(',')];

    for (const row of result.rows) {
      const values = row.map((v) => {
        if (v === null || v === undefined) return '';
        const str = String(v);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      csvRows.push(values.join(','));
    }

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query-result.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  if (!result.columns.length) {
    return null;
  }

  const headerGroups = table.getHeaderGroups();
  const rows = table.getRowModel().rows;
  const pageSize = table.getState().pagination.pageSize;
  const totalRows = result.rows.length;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.02]">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="text-[11px] text-white/40">
          {totalRows} row{totalRows !== 1 ? 's' : ''}
          {result.truncated && <span className="ml-1 text-amber-400/80">(truncated)</span>}
        </span>
        <div className="flex-1" />
        {totalRows > pageSize && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="rounded px-1.5 py-0.5 text-xs text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              ←
            </button>
            <span className="text-[11px] tabular-nums text-white/40">
              {table.getState().pagination.pageIndex + 1}/{table.getPageCount()}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="rounded px-1.5 py-0.5 text-xs text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              →
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={handleExportCsv}
          className="rounded px-1.5 py-0.5 text-xs text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60"
          title="Export CSV"
        >
          CSV
        </button>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse text-xs font-mono">
          <thead>
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isSorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="sticky top-0 z-10 border-b border-white/[0.10] bg-white/[0.06] px-3 py-1.5 text-left text-xs font-semibold text-white/60"
                    >
                      {header.isPlaceholder ? null : (
                        <button
                          type="button"
                          className={`flex w-full items-center gap-1 transition-colors hover:text-white/80 ${
                            isSorted ? 'text-white/80' : ''
                          }`}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {isSorted === 'asc' && ' ↑'}
                          {isSorted === 'desc' && ' ↓'}
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-white/[0.03]">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="border-b border-white/[0.04] px-3 py-1">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Expanded cell panel */}
      {expandedCell && (
        <div className="shrink-0 border-t border-white/[0.10] bg-white/[0.04]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
            <span className="text-xs font-semibold text-white/60">{expandedCell.colName}</span>
            <button
              type="button"
              onClick={() => setExpandedCell(null)}
              className="rounded px-2 py-0.5 text-xs text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/60"
            >
              Close
            </button>
          </div>
          <div className="max-h-48 overflow-auto p-3 text-sm font-mono whitespace-pre-wrap break-all text-white/80">
            {expandedCell.value}
          </div>
        </div>
      )}
    </div>
  );
}
