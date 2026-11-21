import { useCallback, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  makeSnippet,
  markSnippetUsed,
  removeSnippet,
  upsertSnippet,
  type TermSnippet,
} from '../../lib/termSnippets';
import { termSnippetsAtom } from '../../store/termSnippets';
import { CloseIcon, CopyIcon, KeyCommandIcon, RefreshIcon, SnippetIcon } from '../icons';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { useTermCopy } from '../hooks/useTermCopy';
import { KeyChordMenu } from './KeyChordMenu';
import { SoftInputToggle } from './SoftInputPanel';
import { SnippetMenu } from './SnippetMenu';
import { SnippetManagerDialog, type SnippetEditTarget } from './SnippetManagerDialog';
import { SnippetSaveDialog } from './SnippetSaveDialog';

/**
 * The right-hand group of a terminal's status bar: key chords, frequent inputs,
 * selection mode, reset.
 *
 * Shared by the shell tile (`/term`) and Baikal's attached terminals, so the two
 * behave identically — a person who learned the icons in one should not find a
 * different set in the other. Everything session-specific comes in as props:
 * how to send bytes, how to insert text (snippet pasting), and the line a
 * "save this command" would capture.
 */
export interface TermToolbarProps {
  term: Terminal | null;
  applicationCursorKeys: boolean;
  /** Send bytes through the session's own input path (chords, reset). */
  sendBytes: (bytes: string) => void;
  /** Insert text with the caller's paste/run semantics (snippets). */
  insert: (request: { text: string; snippetId?: string }, run: boolean) => void;
  /** The line the user is typing, for "save current input". Omit to disable. */
  currentLine?: () => string;
  /** Reset the terminal's tty and screen. Default: reset + "reset\r". */
  onReset?: () => void;
  /** Short notice (e.g. snippets not available while detached). */
  notice?: (message: string) => void;
  /** Reported so the owner's status line can show selection mode. */
  onSelectionModeChange?: (on: boolean) => void;
  /** Refocus the terminal after a popover closes. */
  refocus?: () => void;
  /**
   * The soft-input panel's toggle. Present only on a touch-first client whose
   * tile owns a panel — a desktop footer has no use for one, and a tile that
   * does not host the panel must not offer the button. It leads the group,
   * where the shell tile has always shown it, so both tiles match.
   */
  softInput?: { open: boolean; onToggle: () => void } | null;
}

const TOOL_BTN = 'rounded p-0.5 hover:bg-white/10';

export function TermToolbar({
  term,
  applicationCursorKeys,
  sendBytes,
  insert,
  currentLine,
  onReset,
  notice,
  onSelectionModeChange,
  refocus,
  softInput,
}: TermToolbarProps) {
  const { t } = useTranslation();
  const setSnippets = useSetAtom(termSnippetsAtom);

  const [keysOpen, setKeysOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerEdit, setManagerEdit] = useState<SnippetEditTarget>(null);
  const [saveDraft, setSaveDraft] = useState<string | null>(null);

  const [selectionMode, setSelectionMode] = useState(false);
  const [cachedText, setCachedText] = useState('');
  const [cachedLength, setCachedLength] = useState(0);
  const [showCacheDialog, setShowCacheDialog] = useState(false);
  const cachedTextRef = useRef('');

  const onCacheUpdate = useCallback((text: string, length: number) => {
    setCachedText(text);
    setCachedLength(length);
    cachedTextRef.current = text;
  }, []);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((prev) => {
      const next = !prev;
      onSelectionModeChange?.(next);
      return next;
    });
  }, [onSelectionModeChange]);

  // While a dialog is open it must own the focus, or keys reach the shell behind.
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = managerOpen || saveDraft !== null;

  useTermCopy(
    term,
    selectionMode,
    toggleSelectionMode,
    () => notice?.(t('terminal.copied')),
    onCacheUpdate,
  );

  const copyCacheAndExit = useCallback(() => {
    const text = cachedTextRef.current;
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      notice?.(t('terminal.copied'));
      setCachedText('');
      setCachedLength(0);
      cachedTextRef.current = '';
      setSelectionMode(false);
      onSelectionModeChange?.(false);
      setShowCacheDialog(false);
    });
  }, [notice, onSelectionModeChange, t]);

  const focusTerminal = useCallback(() => {
    if (refocus) refocus();
    else term?.focus();
  }, [refocus, term]);

  const openManager = useCallback((edit: SnippetEditTarget) => {
    setManagerEdit(edit);
    setSnippetsOpen(false);
    setManagerOpen(true);
  }, []);

  const openSaveCurrent = useCallback(() => {
    const line = currentLine?.() ?? '';
    if (!line.trim()) {
      notice?.(t('terminal.snippets.nothingToSave'));
      return;
    }
    setSnippetsOpen(false);
    setSaveDraft(line);
  }, [currentLine, notice, t]);

  const saveCurrent = useCallback(
    (text: string, autoReturn: boolean) => {
      setSnippets((list) => upsertSnippet(list, makeSnippet(text, { autoReturn })));
      notice?.(t('terminal.snippets.savedToast'));
      setSaveDraft(null);
      focusTerminal();
    },
    [focusTerminal, notice, setSnippets, t],
  );

  const deleteSnippet = useCallback(
    (snippet: TermSnippet) => {
      setSnippets((list) => removeSnippet(list, snippet.id));
      notice?.(t('terminal.snippets.deletedToast'));
    },
    [notice, setSnippets, t],
  );

  const handleInsert = useCallback(
    (request: { text: string; snippetId?: string }, run: boolean) => {
      insert(request, run);
      if (request.snippetId) {
        setSnippets((list) => markSnippetUsed(list, request.snippetId as string));
      }
      setSnippetsOpen(false);
      focusTerminal();
    },
    [focusTerminal, insert, setSnippets],
  );

  const reset = useCallback(() => {
    if (onReset) {
      onReset();
      return;
    }
    term?.reset();
    sendBytes('reset\r');
  }, [onReset, sendBytes, term]);

  return (
    <>
      {softInput && (
        <SoftInputToggle
          open={softInput.open}
          onToggle={softInput.onToggle}
          className={cn(
            'rounded px-1.5 py-1 transition active:bg-white/15',
            softInput.open ? 'bg-white/10 text-white' : TOOL_BTN,
          )}
        />
      )}
      <KeyChordMenu
        open={keysOpen}
        onOpenChange={setKeysOpen}
        applicationCursorKeys={applicationCursorKeys}
        onSend={(bytes) => {
          sendBytes(bytes);
          return true;
        }}
        trigger={
          <button
            type="button"
            className={TOOL_BTN}
            title={t('terminal.keys.button')}
            aria-label={t('terminal.keys.button')}
          >
            <KeyCommandIcon className="h-3 w-3" />
          </button>
        }
        onClosed={focusTerminal}
      />
      <SnippetMenu
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        trigger={
          <button
            type="button"
            className={TOOL_BTN}
            title={t('terminal.snippets.button')}
            aria-label={t('terminal.snippets.button')}
          >
            <SnippetIcon className="h-3 w-3" />
          </button>
        }
        onInsert={handleInsert}
        onSaveCurrent={openSaveCurrent}
        onManage={() => openManager(null)}
        onEdit={(snippet) => openManager(snippet.id)}
        onDelete={deleteSnippet}
        onClosed={() => {
          if (!dialogOpenRef.current) focusTerminal();
        }}
      />
      {selectionMode && (
        <button
          type="button"
          onClick={() => setShowCacheDialog(true)}
          className="rounded bg-sky-800/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 transition hover:bg-sky-700/60 hover:text-white"
          title={t('terminal.showCachePreview')}
        >
          {cachedLength > 0
            ? t('terminal.cachedChars', { count: cachedLength })
            : t('terminal.cacheEmpty')}
        </button>
      )}
      <button
        type="button"
        onClick={toggleSelectionMode}
        className={TOOL_BTN}
        title={selectionMode ? t('terminal.exitSelectionMode') : t('terminal.enterSelectionMode')}
      >
        {selectionMode ? <CloseIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={reset}
        className={TOOL_BTN}
        title={t('terminal.reset')}
        aria-label={t('terminal.reset')}
      >
        <RefreshIcon className="h-3 w-3" />
      </button>

      <SnippetManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        initialEdit={managerEdit}
        onNotify={(message) => notice?.(message)}
        onClosed={() => {
          if (!dialogOpenRef.current) focusTerminal();
        }}
      />
      <SnippetSaveDialog
        open={saveDraft !== null}
        onOpenChange={(next) => {
          if (!next) setSaveDraft(null);
        }}
        text={saveDraft ?? ''}
        onSave={saveCurrent}
        onClosed={() => {
          if (!dialogOpenRef.current) focusTerminal();
        }}
      />
      <Dialog open={showCacheDialog} onOpenChange={setShowCacheDialog}>
        <DialogContent>
          <DialogTitle>{t('terminal.cachePreview')}</DialogTitle>
          <div className="mt-3 max-h-[50dvh] overflow-auto scrollbar-thin rounded bg-black/40 p-3 font-mono text-sm text-white/80 whitespace-pre-wrap break-all">
            {cachedText || t('terminal.cacheEmpty')}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCacheDialog(false)}
              className="rounded px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            >
              {t('dialog.close')}
            </button>
            <button
              type="button"
              onClick={copyCacheAndExit}
              disabled={!cachedText}
              className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('terminal.copyAndExit')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
