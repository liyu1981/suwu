import { useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  SHELF_BOUNDS,
  makeSnippet,
  orderSnippets,
  removeSnippet,
  runsOnSelect,
  upsertSnippet,
  type TermSnippet,
} from '../../lib/termSnippets';
import {
  termRecordInputsAtom,
  termRecentsAtom,
  termShelfSettingsAtom,
  termSnippetsAtom,
} from '../../store/termSnippets';
import { PlusIcon } from '../icons';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import {
  AutoReturnToggle,
  SNIPPET_DANGER_BTN,
  SNIPPET_GHOST_BTN,
  SNIPPET_INPUT,
  SNIPPET_PRIMARY_BTN,
} from './SnippetFields';

/**
 * The management surface for the "Frequent inputs" shelf, in two tabs.
 *
 * **Saved** — a table of snippets, not a form above a list: clicking a row
 * turns *that row* into an editor (text + auto return + Save / Cancel /
 * Delete), and "New" opens an empty editor row at the top of the table. That
 * keeps the shelf itself in view while editing it — no separate "which row am
 * I editing?" state to read.
 *
 * **General** — how much of the shelf the menu shows (saved rows, recent rows)
 * and how much history is kept, plus the record/history controls that used to
 * sit at the bottom of the single view.
 *
 * This is the only dialog in the feature besides the save-current confirm; the
 * fast path (open menu, click a row) never reaches either.
 */

/** `'new'` is the unsaved editor row prepended by the New button. */
export type SnippetEditTarget = string | 'new' | null;

interface SnippetManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Row to open in edit mode when the dialog appears. */
  initialEdit: SnippetEditTarget;
  onNotify: (message: string) => void;
  /** Called after the dialog closes so the caller can restore focus. */
  onClosed: () => void;
}

/**
 * A bounded integer setting. The input keeps a local draft while typing so a
 * half-typed value ("" or "1" on the way to "12") is not clamped out from
 * under the caret; the value is committed on blur or Enter.
 */
function NumberSetting({
  id,
  label,
  hint,
  value,
  bounds,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  bounds: { min: number; max: number };
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Re-sync when the stored value changes from elsewhere (clamping, another
  // pane, a restored backup).
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(bounds.max, Math.max(bounds.min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-xs text-white/70">
          {label}
        </label>
        <p className="text-[11px] text-white/35">{hint}</p>
      </div>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={bounds.min}
        max={bounds.max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        className="h-7 w-14 shrink-0 rounded border border-white/10 bg-black/30 px-2 text-right text-xs text-white/85 outline-none transition focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30"
      />
    </div>
  );
}

export function SnippetManagerDialog({
  open,
  onOpenChange,
  initialEdit,
  onNotify,
  onClosed,
}: SnippetManagerDialogProps) {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useAtom(termSnippetsAtom);
  const [recents, setRecents] = useAtom(termRecentsAtom);
  const [recordInputs, setRecordInputs] = useAtom(termRecordInputsAtom);
  const settings = useAtomValue(termShelfSettingsAtom);
  const setSettings = useSetAtom(termShelfSettingsAtom);

  const [tab, setTab] = useState<'saved' | 'general'>('saved');
  const [editingId, setEditingId] = useState<SnippetEditTarget>(null);
  const [text, setText] = useState('');
  const [autoReturn, setAutoReturn] = useState(false);

  const ordered = useMemo(() => orderSnippets(snippets), [snippets]);

  // Every open starts from the caller's target: a specific row, a fresh draft
  // row, or plain browsing.
  useEffect(() => {
    if (!open) return;
    // An edit target always belongs to the Saved tab.
    setTab('saved');
    if (initialEdit === 'new') {
      setEditingId('new');
      setText('');
      setAutoReturn(false);
      return;
    }
    const snippet = initialEdit ? snippets.find((s) => s.id === initialEdit) : undefined;
    setEditingId(snippet ? snippet.id : null);
    setText(snippet?.text ?? '');
    setAutoReturn(snippet ? runsOnSelect(snippet) : false);
    // `snippets` is intentionally out of the deps: re-running on every store
    // change would clobber what the user is typing.
  }, [open, initialEdit]);

  const startEdit = (snippet: TermSnippet) => {
    setEditingId(snippet.id);
    setText(snippet.text);
    setAutoReturn(runsOnSelect(snippet));
  };

  const startNew = () => {
    setEditingId('new');
    setText('');
    setAutoReturn(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setText('');
    setAutoReturn(false);
  };

  const save = () => {
    const value = text.trim();
    if (!value) return;
    const existing =
      editingId && editingId !== 'new' ? snippets.find((s) => s.id === editingId) : undefined;
    const next: TermSnippet = existing
      ? {
          // Rebuilt explicitly (rather than spread) so stale fields — the old
          // `label` — are dropped from stored data on the next save.
          id: existing.id,
          text: value,
          autoReturn: autoReturn || undefined,
          createdAt: existing.createdAt,
          lastUsedAt: existing.lastUsedAt,
          useCount: existing.useCount,
        }
      : makeSnippet(value, { autoReturn });
    setSnippets((list) => upsertSnippet(list, next));
    onNotify(t('terminal.snippets.savedToast'));
    cancelEdit();
  };

  const remove = (id: string) => {
    setSnippets((list) => removeSnippet(list, id));
    onNotify(t('terminal.snippets.deletedToast'));
    if (editingId === id) cancelEdit();
  };

  const editor = (
    <div className="border-b border-white/10 bg-white/[0.04] px-1.5 py-1.5">
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        placeholder={t('terminal.snippets.commandPlaceholder')}
        className={`${SNIPPET_INPUT} resize-none`}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <AutoReturnToggle
          id="term-snippet-row-auto-return"
          checked={autoReturn}
          onChange={setAutoReturn}
        />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={!text.trim()}
            onClick={save}
            className={SNIPPET_PRIMARY_BTN}
          >
            {t('terminal.snippets.save')}
          </button>
          <button type="button" onClick={cancelEdit} className={SNIPPET_GHOST_BTN}>
            {t('terminal.snippets.cancel')}
          </button>
          {editingId && editingId !== 'new' && (
            <button type="button" onClick={() => remove(editingId)} className={SNIPPET_DANGER_BTN}>
              {t('terminal.snippets.delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,34rem)]"
        // Opening straight into an editor row must not fight the dialog's own
        // focus: the textarea's autoFocus already put the caret where the user
        // is going to type.
        onOpenAutoFocus={(event) => {
          if (initialEdit) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogTitle>{t('terminal.snippets.managerTitle')}</DialogTitle>

        {/* Tab strip — Label 12, underline carries the selection. */}
        <div role="tablist" className="mt-2 flex items-center gap-0.5 border-b border-white/10">
          {(['saved', 'general'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px rounded-t px-2.5 py-1 text-xs font-medium transition',
                tab === id
                  ? 'border-b-2 border-sky-400 text-white'
                  : 'border-b-2 border-transparent text-white/45 hover:bg-white/5 hover:text-white/75',
              )}
            >
              {t(id === 'saved' ? 'terminal.snippets.saved' : 'terminal.snippets.general')}
            </button>
          ))}
        </div>

        {tab === 'saved' ? (
          <div role="tabpanel">
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={startNew}
                disabled={editingId === 'new'}
                className={`${SNIPPET_GHOST_BTN} flex items-center gap-1 disabled:opacity-30`}
              >
                <PlusIcon className="h-3 w-3" />
                {t('terminal.snippets.newSnippet')}
              </button>
            </div>

            <div className="mt-1 max-h-[42dvh] overflow-auto scrollbar-thin">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/35">
                    <th className="border-b border-white/10 px-2 py-1 font-medium">
                      {t('terminal.snippets.commandLabel')}
                    </th>
                    <th
                      className="w-9 border-b border-white/10 px-1 py-1 text-center font-medium"
                      title={t('terminal.snippets.autoReturnBadge')}
                    >
                      ↵
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {editingId === 'new' && (
                    <tr>
                      <td colSpan={2} className="p-0">
                        {editor}
                      </td>
                    </tr>
                  )}
                  {ordered.length === 0 && editingId !== 'new' && (
                    <tr>
                      <td colSpan={2} className="px-2 py-6 text-center text-[11px] text-white/35">
                        {t('terminal.snippets.emptySaved')}
                      </td>
                    </tr>
                  )}
                  {ordered.map((snippet) =>
                    editingId === snippet.id ? (
                      <tr key={snippet.id}>
                        <td colSpan={2} className="p-0">
                          {editor}
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={snippet.id}
                        onClick={() => startEdit(snippet)}
                        title={t('terminal.snippets.edit')}
                        className="cursor-pointer border-b border-white/5 transition last:border-b-0 hover:bg-white/5"
                      >
                        <td className="px-2 py-1.5 align-top">
                          <span className="line-clamp-2 break-all font-mono text-sm text-white/80">
                            {snippet.text}
                          </span>
                        </td>
                        <td className="px-1 py-1.5 text-center align-top">
                          {runsOnSelect(snippet) && (
                            <span
                              title={t('terminal.snippets.autoReturnBadge')}
                              className="text-[10px] font-semibold text-sky-300/80"
                            >
                              ↵
                            </span>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div role="tabpanel" className="mt-3 flex flex-col gap-2.5">
            <NumberSetting
              id="term-snippet-max-saved"
              label={t('terminal.snippets.maxSaved')}
              hint={t('terminal.snippets.maxSavedHint')}
              value={settings.maxSaved}
              bounds={SHELF_BOUNDS.maxSaved}
              onCommit={(value) => setSettings({ maxSaved: value })}
            />
            <NumberSetting
              id="term-snippet-max-recent"
              label={t('terminal.snippets.maxRecent')}
              hint={t('terminal.snippets.maxRecentHint')}
              value={settings.maxRecent}
              bounds={SHELF_BOUNDS.maxRecent}
              onCommit={(value) => setSettings({ maxRecent: value })}
            />
            <NumberSetting
              id="term-snippet-recents-kept"
              label={t('terminal.snippets.recentsKept')}
              hint={t('terminal.snippets.recentsKeptHint')}
              value={settings.recentsKept}
              bounds={SHELF_BOUNDS.recentsKept}
              onCommit={(value) => {
                setSettings({ recentsKept: value });
                // Lowering the cap prunes immediately instead of waiting for
                // the next submitted command to re-slice the list.
                setRecents((list) => list.slice(0, value));
              }}
            />

            <div className="mt-1 flex items-center gap-2 border-t border-white/10 pt-2.5">
              <label className="flex items-center gap-1.5 text-xs text-white/60">
                <input
                  type="checkbox"
                  checked={recordInputs}
                  onChange={(event) => setRecordInputs(event.target.checked)}
                  className="h-3 w-3 accent-sky-500"
                />
                {t('terminal.snippets.recordInputs')}
              </label>
              <span className="text-[10px] text-white/35">
                {t('terminal.snippets.recentCount', { count: recents.length })}
              </span>
              <button
                type="button"
                disabled={recents.length === 0}
                onClick={() => {
                  setRecents([]);
                  onNotify(t('terminal.snippets.historyClearedToast'));
                }}
                className={`${SNIPPET_GHOST_BTN} ml-auto`}
              >
                {t('terminal.snippets.clearRecents')}
              </button>
            </div>
            <p className="text-[11px] text-white/35">{t('terminal.snippets.recordInputsHint')}</p>
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => onOpenChange(false)} className={SNIPPET_GHOST_BTN}>
            {t('dialog.close')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
