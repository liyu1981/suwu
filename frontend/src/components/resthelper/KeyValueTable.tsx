import { CloseIcon, PlusIcon } from '../icons';
import { newId } from '../../store/resthelper';

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface Props<T extends KeyValueRow> {
  rows: T[];
  onChange: (rows: T[]) => void;
  createRow: () => T;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
  removeLabel: string;
  enableLabel: string;
}

/** Reusable enabled/key/value editor used for headers, params, and urlencoded fields. */
export default function KeyValueTable<T extends KeyValueRow>({
  rows,
  onChange,
  createRow,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  addLabel,
  removeLabel,
  enableLabel,
}: Props<T>) {
  const update = (id: string, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) as T[]);
  };

  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id) as T[]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-1 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-white/30">{addLabel}</span>
        <button
          type="button"
          onClick={() => onChange([...rows, createRow()])}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-cyan-300/80 transition-colors hover:bg-cyan-500/15 hover:text-cyan-200"
        >
          <PlusIcon className="h-3 w-3" />
          {addLabel}
        </button>
      </div>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto rounded-lg border border-white/[0.08] bg-white/[0.02]">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-[11px] text-white/25">
            No rows
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center gap-2 px-2 py-1">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(event) => update(row.id, { enabled: event.target.checked })}
                  aria-label={enableLabel}
                  className="h-3.5 w-3.5 shrink-0 accent-cyan-500"
                />
                <input
                  value={row.key}
                  onChange={(event) => update(row.id, { key: event.target.value })}
                  placeholder={keyPlaceholder}
                  spellCheck={false}
                  className="w-2/5 min-w-0 rounded bg-transparent px-2 py-1 font-mono text-xs text-white/80 outline-none placeholder:text-white/20 focus:bg-white/[0.05]"
                />
                <input
                  value={row.value}
                  onChange={(event) => update(row.id, { value: event.target.value })}
                  placeholder={valuePlaceholder}
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded bg-transparent px-2 py-1 font-mono text-xs text-white/70 outline-none placeholder:text-white/20 focus:bg-white/[0.05]"
                />
                <button
                  type="button"
                  onClick={() => remove(row.id)}
                  aria-label={removeLabel}
                  title={removeLabel}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/30 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function createHeaderRow() {
  return { id: newId('h'), key: '', value: '', enabled: true };
}
