import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { fontFamilyAtom, termThemeAtom, themeToXtermTheme } from '../store/appearance';
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection';
import { FONT_DEFAULT, lineHeightAtom } from '../store/fonts';
import { termSnippetsAtom } from '../store/termSnippets';
import { buildPayload } from '../lib/termInput';
import {
  makeSnippet,
  markSnippetUsed,
  removeSnippet,
  upsertSnippet,
  type TermSnippet,
} from '../lib/termSnippets';
import { useTerminal } from './hooks/useTerminal';
import { usePtySession } from './hooks/usePtySession';
import { useTermCopy } from './hooks/useTermCopy';
import { useBell } from './hooks/useBell';
import { useInputRecorder } from './hooks/useInputRecorder';
import { CommonTileContainer } from './CommonTileContainer';
import { SnippetMenu } from './term/SnippetMenu';
import { SnippetManagerDialog, type SnippetEditTarget } from './term/SnippetManagerDialog';
import { SnippetSaveDialog } from './term/SnippetSaveDialog';
import { CloseIcon, CopyIcon, RefreshIcon, SnippetIcon } from './icons';
import { Toast } from './Toast';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

const STATUS_DOT = {
  connecting: 'bg-amber-400 animate-pulse',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
} as const;

/**
 * An xterm terminal that fills the entire viewport. This is the page each
 * tiling pane loads in an iframe (`/term`); every iframe gets its own
 * WebSocket PTY session on the server.
 */
export default function FullTerminal() {
  const { t } = useTranslation();
  const status = useAtomValue(connectionStatusAtom);
  const message = useAtomValue(connectionMessageAtom);
  const fontFamily = useAtomValue(fontFamilyAtom);
  const theme = useAtomValue(termThemeAtom);
  const lineHeight = useAtomValue(lineHeightAtom);

  // Font size comes exclusively from the parent via postMessage (tile-font-size).
  // Use a placeholder until the message arrives.
  const [tileFontSize, setTileFontSize] = useState(FONT_DEFAULT);

  const { containerRef, term, setFontSize, setFontFamily, setLineHeight, setTheme } = useTerminal(
    {
      cursorBlink: true,
      fontSize: tileFontSize,
      fontFamily,
      lineHeight,
      scrollback: 5000,
      // The pane wrapper paints the configurable background (alpha included);
      // the terminal grid itself stays transparent so the color is composited
      // exactly once, over the wrapper.
      allowTransparency: true,
      theme: { ...themeToXtermTheme(theme), background: '#00000000' },
    },
    { cols: 80, rows: 24 },
  );

  // ── Selection mode ──
  const [selectionMode, setSelectionMode] = useState(false);
  const toggleSelectionMode = useCallback(() => setSelectionMode((v) => !v), []);

  // ── Selection cache (only meaningful in selection mode) ──
  const [cachedText, setCachedText] = useState('');
  const [cachedLength, setCachedLength] = useState(0);
  const [showCacheDialog, setShowCacheDialog] = useState(false);
  // Ref so the dialog copy handler always reads the latest cache.
  const cachedTextRef = useRef('');
  const onCacheUpdate = useCallback((text: string, length: number) => {
    setCachedText(text);
    setCachedLength(length);
    cachedTextRef.current = text;
  }, []);

  // ── Copy toast ──
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(null); // reset to re-key the component
    requestAnimationFrame(() => setToastMsg(msg));
  }, []);

  // Copy cached text, exit selection mode, show toast.
  const copyCacheAndExit = useCallback(() => {
    const text = cachedTextRef.current;
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      showToast(t('terminal.copied'));
      setCachedText('');
      setCachedLength(0);
      cachedTextRef.current = '';
      setSelectionMode(false);
      setShowCacheDialog(false);
    });
  }, [showToast, t]);

  // The pane ID is the server-owned terminal session ID. The browser xterm
  // is disposable and never restores cwd, foreground process, or screen state
  // from localStorage.
  const paneId = useMemo(
    () => new URLSearchParams(window.location.search).get('pane') ?? undefined,
    [],
  );

  const { sendRaw, refresh } = usePtySession(term, paneId);

  // ── Frequent inputs: saved snippets + this session's submitted lines ──
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerEdit, setManagerEdit] = useState<SnippetEditTarget>(null);
  /** Non-null while confirming the line the user is typing as a snippet. */
  const [saveDraft, setSaveDraft] = useState<string | null>(null);
  const setSnippets = useSetAtom(termSnippetsAtom);
  // Typing is blocked in selection mode, so there is nothing to record there.
  const { getCurrentLine, recordSent } = useInputRecorder(term, { paused: selectionMode });

  // The menu closes into one of three places: back to the terminal, or into one
  // of the two dialogs, which must own the focus — otherwise keystrokes would
  // reach the shell behind them. The ref is read during the popover's close
  // effect, i.e. after this render committed the new state.
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = managerOpen || saveDraft !== null;

  const insertInput = useCallback(
    (request: { text: string; snippetId?: string }, run: boolean) => {
      const payload = buildPayload(request.text, run, Boolean(term?.modes.bracketedPasteMode));
      if (!sendRaw(payload)) {
        // Detached PTY: keep the menu open so the choice is not lost.
        showToast(t('terminal.snippets.notReady'));
        return;
      }
      // sendRaw bypasses xterm's onData, so the line model has to be told
      // what the shell just received — otherwise the next Enter remembers a
      // command the user never ran.
      recordSent(payload);
      const usedId = request.snippetId;
      if (usedId) setSnippets((list) => markSnippetUsed(list, usedId));
      setSnippetsOpen(false);
      term?.focus();
    },
    [recordSent, sendRaw, setSnippets, showToast, t, term],
  );

  const openManager = useCallback((edit: SnippetEditTarget) => {
    setManagerEdit(edit);
    setSnippetsOpen(false);
    setManagerOpen(true);
  }, []);

  // "Save current input" confirms the captured line right here instead of
  // dumping the user into the manager with an empty form to retype it in.
  const openSaveCurrent = useCallback(() => {
    const line = getCurrentLine();
    if (!line.trim()) {
      showToast(t('terminal.snippets.nothingToSave'));
      return;
    }
    setSnippetsOpen(false);
    setSaveDraft(line);
  }, [getCurrentLine, showToast, t]);

  const saveCurrent = useCallback(
    (text: string, autoReturn: boolean) => {
      setSnippets((list) => upsertSnippet(list, makeSnippet(text, { autoReturn })));
      showToast(t('terminal.snippets.savedToast'));
      setSaveDraft(null);
      term?.focus();
    },
    [setSnippets, showToast, t, term],
  );

  const deleteSnippet = useCallback(
    (snippet: TermSnippet) => {
      setSnippets((list) => removeSnippet(list, snippet.id));
      showToast(t('terminal.snippets.deletedToast'));
    },
    [setSnippets, showToast, t],
  );

  // Reset a terminal left in a bad state by a TUI app (hidden cursor,
  // alternate screen, mouse tracking, etc.). Resets the browser terminal and
  // asks the server-side shell to reset its tty line discipline. The server
  // app has no way to notice a client-side wipe, so we then request a repaint
  // (SIGWINCH) — this replaces the old "nudge the tile size and back" dance
  // that was previously needed to make TUI apps like herdr redraw.
  const resetTerminal = useCallback(() => {
    term?.reset();
    sendRaw('reset\r');
    window.setTimeout(() => refresh(), 50);
  }, [term, sendRaw, refresh]);

  useTermCopy(
    term,
    selectionMode,
    toggleSelectionMode,
    () => showToast(t('terminal.copied')),
    onCacheUpdate,
  );
  useBell(term, containerRef);

  // Focus the terminal when this iframe gains focus.
  useEffect(() => {
    const onFocus = () => term?.focus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [term]);

  // Apply shared appearance settings from parent (font family, line height, theme).
  useEffect(() => {
    setFontFamily(fontFamily);
  }, [fontFamily, setFontFamily]);
  useEffect(() => {
    setLineHeight(lineHeight);
  }, [lineHeight, setLineHeight]);
  useEffect(() => {
    setTheme({ ...themeToXtermTheme(theme), background: '#00000000' });
  }, [theme, setTheme]);

  // Font size is received from the parent via postMessage. The parent
  // derives it from space.paneData and sends it on mount + every layout
  // change. Until the first message arrives we use the initial state
  // (FONT_DEFAULT).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fontSize?: number } | undefined;
      if (d?.type === 'tile-font-size' && typeof d.fontSize === 'number') {
        setTileFontSize(d.fontSize);
      }
    };
    window.addEventListener('message', onMsg);
    // Request font size from parent — fixes the race where the parent
    // sends postMessage before this iframe's listener is registered.
    window.parent?.postMessage({ type: 'request-font-size', paneId: paneId ?? '' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, [paneId]);
  useEffect(() => {
    setFontSize(tileFontSize);
  }, [tileFontSize, setFontSize]);

  return (
    <CommonTileContainer paneId={paneId}>
      <div
        className="flex h-screen flex-col overflow-hidden rounded-[6px]"
        style={{ backgroundColor: theme.background }}
      >
        <div className="min-h-0 flex-1 p-2">
          <div ref={containerRef} className="terminal-canvas relative h-full w-full" />
        </div>
        {/* Thin per-pane status bar: connection state lives here instead of
            floating over the terminal content. */}
        <footer
          className={`flex h-5 shrink-0 items-center gap-1.5 border-t px-2 text-[11px] text-white/50 tracking-wide ${
            selectionMode
              ? 'border-sky-400/30 bg-sky-900/50 text-sky-300'
              : 'border-white/10 bg-black/40 text-white/60'
          }`}
          title={message}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${selectionMode ? 'bg-sky-400' : STATUS_DOT[status]}`}
          />
          {selectionMode ? (
            <span className="truncate">{t('terminal.selectionMode')}</span>
          ) : (
            <span className="truncate">
              {status === 'connected'
                ? t('terminal.connected')
                : message || t(`terminal.${status}`)}
            </span>
          )}
          {/* Clickable char-count badge — only in selection mode */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <SnippetMenu
              open={snippetsOpen}
              onOpenChange={setSnippetsOpen}
              trigger={
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-white/10"
                  title={t('terminal.snippets.button')}
                  aria-label={t('terminal.snippets.button')}
                >
                  <SnippetIcon className="h-3 w-3" />
                </button>
              }
              onInsert={insertInput}
              onSaveCurrent={openSaveCurrent}
              onManage={() => openManager(null)}
              onEdit={(snippet) => openManager(snippet.id)}
              onDelete={deleteSnippet}
              onClosed={() => {
                if (!dialogOpenRef.current) term?.focus();
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
              className="rounded p-0.5 hover:bg-white/10"
              title={
                selectionMode ? t('terminal.exitSelectionMode') : t('terminal.enterSelectionMode')
              }
            >
              {selectionMode ? <CloseIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={resetTerminal}
              className="rounded p-0.5 hover:bg-white/10"
              title={t('terminal.reset')}
              aria-label={t('terminal.reset')}
            >
              <RefreshIcon className="h-3 w-3" />
            </button>
          </div>
        </footer>
        {/* Toast overlay for copy confirmation */}
        {toastMsg && <Toast message={toastMsg} />}
      </div>

      {/* Cache preview dialog — shows the cached selection and allows
          copy-to-clipboard in one step. */}
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

      {/* Snippet manager — the only modal in the feature. The menu's fast path
          (open, click a row) never reaches it. */}
      <SnippetManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        initialEdit={managerEdit}
        onNotify={showToast}
        onClosed={() => term?.focus()}
      />

      <SnippetSaveDialog
        open={saveDraft !== null}
        onOpenChange={(next) => {
          if (!next) setSaveDraft(null);
        }}
        text={saveDraft ?? ''}
        onSave={saveCurrent}
        onClosed={() => term?.focus()}
      />
    </CommonTileContainer>
  );
}
