import { CopyIcon, TrashIcon } from '../icons';
import type { RestHistoryEntry } from '../../store/resthelper';

interface Props {
  entries: RestHistoryEntry[];
  onOpen: (entry: RestHistoryEntry) => void;
  onDuplicate: (entry: RestHistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

function timeLabel(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function HistoryList({ entries, onOpen, onDuplicate, onRemove, onClear }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-2 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-white/30">History</span>
        <button
          type="button"
          onClick={onClear}
          disabled={entries.length === 0}
          className="rounded px-1.5 py-0.5 text-[10px] text-rose-300/70 transition-colors hover:bg-rose-500/15 disabled:opacity-30"
        >
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto">
        {entries.length === 0 ? (
          <div className="p-3 text-[11px] text-white/25">No requests yet</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="group flex items-center gap-1 px-1">
              <button
                type="button"
                onClick={() => onOpen(entry)}
                className="flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
              >
                <div className="flex w-full items-center gap-1.5">
                  <span className="shrink-0 font-mono text-[10px] font-semibold text-cyan-300/80">
                    {entry.method}
                  </span>
                  <span className="truncate font-mono text-[11px] text-white/55">{entry.url}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-white/30">
                  <span className={entry.status === 0 ? 'text-rose-400/80' : ''}>
                    {entry.status === 0 ? 'ERR' : entry.status}
                  </span>
                  <span>{entry.durationMs}ms</span>
                  <span>{timeLabel(entry.timestamp)}</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onDuplicate(entry)}
                aria-label="Duplicate as a new request"
                title="Duplicate as a new request"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/20 opacity-0 transition-opacity hover:bg-cyan-500/15 hover:text-cyan-300 group-hover:opacity-100"
              >
                <CopyIcon className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(entry.id)}
                aria-label="Remove history entry"
                title="Remove"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/20 opacity-0 transition-opacity hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
