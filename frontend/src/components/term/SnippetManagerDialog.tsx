import { useEffect, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  makeSnippet,
  orderSnippets,
  removeSnippet,
  runsOnSelect,
  upsertSnippet,
  type TermSnippet,
} from '../../lib/termSnippets';
import { termRecordInputsAtom, termRecentsAtom, termSnippetsAtom } from '../../store/termSnippets';
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
 * The management surface for the "Frequent inputs" shelf.
 *
 * A table of snippets, not a form above a list: clicking a row turns *that row*
 * into an editor (text + auto return + Save / Cancel / Delete), and "New" opens
 * an empty editor row at the top of the table. That keeps the shelf itself in
 * view while editing it — no separate "which row am I editing?" state to read.
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

  const [editingId, setEditingId] = useState<SnippetEditTarget>(null);
  const [text, setText] = useState('');
  const [autoReturn, setAutoReturn] = useState(false);

  const ordered = useMemo(() => orderSnippets(snippets), [snippets]);

  // Every open starts from the caller's target: a specific row, a fresh draft
  // row, or plain browsing.
  useEffect(() => {
    if (!open) return;
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
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t('terminal.snippets.managerTitle')}</DialogTitle>
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

        <div className="mt-3 max-h-[46dvh] overflow-auto scrollbar-thin">
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

        {/* Recent-input history controls */}
        <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-2">
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
        <div className="mt-1 text-[11px] text-white/35">
          {t('terminal.snippets.recordInputsHint')}
        </div>

        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => onOpenChange(false)} className={SNIPPET_GHOST_BTN}>
            {t('dialog.close')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
