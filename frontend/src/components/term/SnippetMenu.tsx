import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  firstLine,
  lineCount,
  matchesQuery,
  orderSnippets,
  runsOnSelect,
  type TermSnippet,
} from '../../lib/termSnippets';
import { termRecentsAtom, termSnippetsAtom } from '../../store/termSnippets';
import { PencilIcon, PlusIcon, SearchIcon, TrashIcon } from '../icons';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/**
 * "Frequent inputs" — the popover that hangs off the terminal status bar.
 *
 * It grows **upward** (`side="top"`): the trigger lives in the h-5 footer at the
 * bottom edge of the pane, so a downward menu would have nothing to grow into.
 * Radix flips it when a short pane has no room above.
 *
 * Sections: search, RECENT (typed this browser session), SAVED (durable
 * snippets), then the two ways to add something — save the line the user is
 * typing, or open the manager. Clicking a row inserts without running; the ⏎
 * affordance inserts and runs — except for snippets marked *auto return*,
 * which run on selection and show a persistent ↵ instead.
 */

export interface SnippetInsertRequest {
  text: string;
  snippetId?: string;
}

interface SnippetMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger button (rendered asChild by the popover). */
  trigger: ReactNode;
  onInsert: (request: SnippetInsertRequest, run: boolean) => void;
  onSaveCurrent: () => void;
  onManage: () => void;
  onEdit: (snippet: TermSnippet) => void;
  onDelete: (snippet: TermSnippet) => void;
  /** Called after the popover closes, so the caller can restore focus. */
  onClosed: () => void;
}

type Row =
  | { kind: 'recent'; key: string; text: string }
  | { kind: 'snippet'; key: string; snippet: TermSnippet };

const ACTION_BTN = 'rounded p-0.5 text-white/45 transition hover:bg-white/10 hover:text-white';
const FOOTER_BTN =
  'flex items-center gap-1 rounded px-1.5 py-1 text-xs text-white/55 transition hover:bg-white/10 hover:text-white';

export function SnippetMenu({
  open,
  onOpenChange,
  trigger,
  onInsert,
  onSaveCurrent,
  onManage,
  onEdit,
  onDelete,
  onClosed,
}: SnippetMenuProps) {
  const { t } = useTranslation();
  const [snippets] = useAtom(termSnippetsAtom);
  const [recents] = useAtom(termRecentsAtom);

  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // A fresh query means a fresh list — start the highlight at the top, and
  // forget the search term once the menu closes.
  useEffect(() => {
    setHighlight(0);
  }, [query]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const groups = useMemo(() => {
    const recentRows = recents
      .filter((entry) => matchesQuery({ text: entry.text }, query))
      .map((entry): Row => ({ kind: 'recent', key: `recent:${entry.text}`, text: entry.text }));
    const savedRows = orderSnippets(snippets)
      .filter((snippet) => matchesQuery({ text: snippet.text, label: snippet.label }, query))
      .map((snippet): Row => ({ kind: 'snippet', key: `snippet:${snippet.id}`, snippet }));

    return [
      {
        id: 'recent',
        title: t('terminal.snippets.recent'),
        empty: t('terminal.snippets.emptyRecent'),
        rows: recentRows,
      },
      {
        id: 'saved',
        title: t('terminal.snippets.saved'),
        empty: t('terminal.snippets.emptySaved'),
        rows: savedRows,
      },
    ];
  }, [query, recents, snippets, t]);

  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  // Start index of each group inside the flattened list, so rows can carry a
  // stable data-idx for keyboard navigation without an O(n²) indexOf per row.
  const groupOffsets = useMemo(() => {
    let offset = 0;
    return groups.map((group) => {
      const start = offset;
      offset += group.rows.length;
      return start;
    });
  }, [groups]);

  // Deleting the highlighted row (or filtering it away) must not leave the
  // highlight past the end of the list.
  useEffect(() => {
    setHighlight((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const activate = useCallback(
    (row: Row, run: boolean) => {
      if (row.kind === 'recent') {
        onInsert({ text: row.text }, run);
        return;
      }
      // An auto-return snippet is a command the user runs as-is, so selecting
      // it is already an explicit run.
      onInsert(
        { text: row.snippet.text, snippetId: row.snippet.id },
        run || runsOnSelect(row.snippet),
      );
    },
    [onInsert],
  );

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => (current + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === 'Enter') {
      const row = rows[highlight];
      if (!row) return;
      event.preventDefault();
      activate(row, event.ctrlKey || event.metaKey);
    }
  };

  const searching = query.trim().length > 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="flex max-h-[min(24rem,60vh)] w-[min(22rem,calc(100vw-1rem))] flex-col p-0"
        onCloseAutoFocus={(event) => {
          // Close back into the terminal, not into the status-bar button.
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
          <SearchIcon className="h-3 w-3 shrink-0 text-white/35" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t('terminal.snippets.searchPlaceholder')}
            className="h-5 w-full bg-transparent text-sm text-white/90 outline-none placeholder:text-white/35"
          />
        </div>

        <div
          ref={listRef}
          role="listbox"
          className="min-h-0 flex-1 overflow-auto scrollbar-thin p-0.5"
        >
          {rows.length === 0 && searching && (
            <div className="px-2 py-1.5 text-[11px] text-white/40">
              {t('terminal.snippets.noMatches')}
            </div>
          )}
          {groups.map((group, groupIndex) => {
            if (group.rows.length === 0) {
              // While searching, an empty group is just noise; otherwise the
              // section keeps its heading with a hint underneath.
              if (searching) return null;
              return (
                <div key={group.id} className="px-2 pb-1">
                  <div className="pb-0.5 text-[10px] uppercase tracking-wider text-white/35">
                    {group.title}
                  </div>
                  <div className="text-[11px] text-white/35">{group.empty}</div>
                </div>
              );
            }
            return (
              <div key={group.id} className="pb-1">
                <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-white/35">
                  {group.title}
                </div>
                {group.rows.map((row, rowIndex) => {
                  const index = groupOffsets[groupIndex] + rowIndex;
                  const text = row.kind === 'recent' ? row.text : row.snippet.text;
                  const label = row.kind === 'snippet' ? row.snippet.label : undefined;
                  const lines = lineCount(text);
                  const autoRun = row.kind === 'snippet' && runsOnSelect(row.snippet);
                  return (
                    <div
                      role="option"
                      aria-selected={index === highlight}
                      tabIndex={-1}
                      data-idx={index}
                      key={row.key}
                      onClick={() => activate(row, false)}
                      title={t(autoRun ? 'terminal.snippets.run' : 'terminal.snippets.insert')}
                      className={cn(
                        'group flex w-full cursor-pointer items-start gap-1 rounded-sm px-2 py-1 transition',
                        index === highlight ? 'bg-white/10' : 'hover:bg-white/10',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        {label && (
                          <span className="block truncate text-[11px] text-white/55">{label}</span>
                        )}
                        <span className="block truncate font-mono text-xs text-white/85">
                          {firstLine(text)}
                        </span>
                        {lines > 1 && (
                          <span className="block text-[10px] text-white/35">
                            {t('terminal.snippets.linesCount', { count: lines })}
                          </span>
                        )}
                      </span>
                      {/* Auto-return snippets run on selection, so the intent
                          is always visible instead of hiding in a tooltip. */}
                      {autoRun && (
                        <span
                          title={t('terminal.snippets.autoReturnBadge')}
                          className="shrink-0 px-0.5 text-[10px] font-semibold leading-[14px] text-sky-300/80"
                        >
                          ↵
                        </span>
                      )}
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                        {!autoRun && (
                          <button
                            type="button"
                            title={t('terminal.snippets.run')}
                            aria-label={t('terminal.snippets.run')}
                            onClick={(event) => {
                              event.stopPropagation();
                              activate(row, true);
                            }}
                            className={ACTION_BTN}
                          >
                            <span className="block text-[10px] font-semibold leading-none">↵</span>
                          </button>
                        )}
                        {row.kind === 'snippet' && (
                          <>
                            <button
                              type="button"
                              title={t('terminal.snippets.edit')}
                              aria-label={t('terminal.snippets.edit')}
                              onClick={(event) => {
                                event.stopPropagation();
                                onEdit(row.snippet);
                              }}
                              className={ACTION_BTN}
                            >
                              <PencilIcon className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              title={t('terminal.snippets.delete')}
                              aria-label={t('terminal.snippets.delete')}
                              onClick={(event) => {
                                event.stopPropagation();
                                onDelete(row.snippet);
                              }}
                              className={ACTION_BTN}
                            >
                              <TrashIcon className="h-3 w-3" />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1 border-t border-white/10 px-1.5 py-1">
          <button type="button" onClick={onSaveCurrent} className={FOOTER_BTN}>
            <PlusIcon className="h-3 w-3" />
            {t('terminal.snippets.saveCurrent')}
          </button>
          <button type="button" onClick={onManage} className={cn(FOOTER_BTN, 'ml-auto')}>
            {t('terminal.snippets.manage')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
