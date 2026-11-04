import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  makeSnippet,
  orderSnippets,
  removeSnippet,
  upsertSnippet,
  type TermSnippet,
} from '../../lib/termSnippets';
import { termRecordInputsAtom, termRecentsAtom, termSnippetsAtom } from '../../store/termSnippets';
import { PencilIcon, TrashIcon } from '../icons';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

/**
 * The management surface for the "Frequent inputs" shelf: add / edit / delete
 * snippets, plus the recent-history controls.
 *
 * This is the only dialog in the feature — the fast path (open menu, click a
 * row) never opens it. It also accepts a draft so the menu can hand over "the
 * line I am typing" or "this snippet I clicked edit on".
 */

export interface SnippetDraft {
  /** Present when editing an existing snippet. */
  id?: string;
  label?: string;
  text?: string;
}

interface SnippetManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seed for the form: an existing snippet, the live input line, or nothing. */
  draft: SnippetDraft | null;
  onNotify: (message: string) => void;
  /** Called after the dialog closes so the caller can restore focus. */
  onClosed: () => void;
}

const FIELD =
  'w-full rounded border border-white/10 bg-black/30 px-2 text-xs text-white/85 outline-none transition placeholder:text-white/30 focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30';
const GHOST_BTN =
  'rounded px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white';
const PRIMARY_BTN =
  'rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40';

export function SnippetManagerDialog({
  open,
  onOpenChange,
  draft,
  onNotify,
  onClosed,
}: SnippetManagerDialogProps) {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useAtom(termSnippetsAtom);
  const [recents, setRecents] = useAtom(termRecentsAtom);
  const [recordInputs, setRecordInputs] = useAtom(termRecordInputsAtom);

  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed the form on every open (and whenever the caller hands over a new
  // draft, e.g. "edit this snippet" while the dialog is already open).
  useEffect(() => {
    if (!open) return;
    setLabel(draft?.label ?? '');
    setText(draft?.text ?? '');
    setEditingId(draft?.id ?? null);
  }, [open, draft]);

  const ordered = useMemo(() => orderSnippets(snippets), [snippets]);
  const editing = editingId ? snippets.find((s) => s.id === editingId) : undefined;

  const resetForm = () => {
    setLabel('');
    setText('');
    setEditingId(null);
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const next: TermSnippet = editing
      ? {
          ...editing,
          label: label.trim() || undefined,
          text: value,
        }
      : makeSnippet(value, label);
    setSnippets((list) => upsertSnippet(list, next));
    onNotify(t('terminal.snippets.savedToast'));
    resetForm();
  };

  const startEdit = (snippet: TermSnippet) => {
    setEditingId(snippet.id);
    setLabel(snippet.label ?? '');
    setText(snippet.text);
    textRef.current?.focus();
  };

  const remove = (snippet: TermSnippet) => {
    setSnippets((list) => removeSnippet(list, snippet.id));
    onNotify(t('terminal.snippets.deletedToast'));
    if (snippet.id === editingId) resetForm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,34rem)] overflow-y-auto scrollbar-thin"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogTitle>{t('terminal.snippets.managerTitle')}</DialogTitle>

        {/* Add / edit form */}
        <div className="mt-3 flex flex-col gap-1.5">
          <label className="text-xs text-white/50" htmlFor="term-snippet-label">
            {t('terminal.snippets.nameLabel')}
          </label>
          <input
            id="term-snippet-label"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('terminal.snippets.namePlaceholder')}
            className={`${FIELD} h-7`}
          />
          <label className="text-xs text-white/50" htmlFor="term-snippet-text">
            {t('terminal.snippets.commandLabel')}
          </label>
          <textarea
            id="term-snippet-text"
            ref={textRef}
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('terminal.snippets.commandPlaceholder')}
            className={`${FIELD} resize-none py-1.5 font-mono text-sm leading-snug`}
          />
          <div className="flex justify-end gap-2">
            {(editingId || label || text) && (
              <button type="button" onClick={resetForm} className={GHOST_BTN}>
                {t('terminal.snippets.cancel')}
              </button>
            )}
            <button type="button" onClick={submit} disabled={!text.trim()} className={PRIMARY_BTN}>
              {editingId ? t('terminal.snippets.save') : t('terminal.snippets.add')}
            </button>
          </div>
        </div>

        {/* Saved list */}
        <div className="mt-3 max-h-[40dvh] overflow-auto scrollbar-thin rounded border border-white/10 bg-black/20">
          {ordered.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-white/35">
              {t('terminal.snippets.emptySaved')}
            </div>
          ) : (
            ordered.map((snippet) => (
              <div
                key={snippet.id}
                className="group flex items-start gap-2 border-b border-white/5 px-2 py-1.5 last:border-b-0 hover:bg-white/5"
              >
                <div className="min-w-0 flex-1">
                  {snippet.label && (
                    <div className="truncate text-[11px] text-white/55">{snippet.label}</div>
                  )}
                  <div className="max-h-10 overflow-hidden whitespace-pre-wrap break-all font-mono text-xs text-white/80">
                    {snippet.text}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={() => startEdit(snippet)}
                    title={t('terminal.snippets.edit')}
                    aria-label={t('terminal.snippets.edit')}
                    className="rounded p-0.5 text-white/45 transition hover:bg-white/10 hover:text-white"
                  >
                    <PencilIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(snippet)}
                    title={t('terminal.snippets.delete')}
                    aria-label={t('terminal.snippets.delete')}
                    className="rounded p-0.5 text-white/45 transition hover:bg-white/10 hover:text-red-300"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}
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
            className={`${GHOST_BTN} ml-auto px-2 py-1 disabled:cursor-not-allowed disabled:opacity-30`}
          >
            {t('terminal.snippets.clearRecents')}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-white/35">
          {t('terminal.snippets.recordInputsHint')}
        </div>

        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => onOpenChange(false)} className={GHOST_BTN}>
            {t('dialog.close')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
