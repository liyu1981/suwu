import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { fontFamilyAtom, termThemeAtom, themeToXtermTheme } from '../store/appearance';
import { connectionMessageAtom, connectionStatusAtom } from '../store/connection';
import { FONT_DEFAULT, lineHeightAtom } from '../store/fonts';
import { termSnippetsAtom } from '../store/termSnippets';
import { buildPayload } from '../lib/termInput';
import { markSnippetUsed } from '../lib/termSnippets';
import { useTerminal } from './hooks/useTerminal';
import { usePtySession } from './hooks/usePtySession';
import { useBell } from './hooks/useBell';
import { useInputRecorder } from './hooks/useInputRecorder';
import { CommonTileContainer } from './CommonTileContainer';
import { TermToolbar } from './term/TermToolbar';
import { SoftInputPanel } from './term/SoftInputPanel';
import { isTouchFirst } from '../lib/mobile';
import { Toast } from './Toast';
import { paneIdFromLocation } from '../lib/pane';

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
  // Owned here so the status line can say "selection mode"; the toolbar toggles it.
  const [selectionMode, setSelectionMode] = useState(false);

  // ── Copy toast ──
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMsg(null); // reset to re-key the component
    requestAnimationFrame(() => setToastMsg(msg));
  }, []);

  // The pane ID is the server-owned terminal session ID. The browser xterm
  // is disposable and never restores cwd, foreground process, or screen state
  // from localStorage.
  const paneId = useMemo(() => paneIdFromLocation() || undefined, []);

  const { sendRaw, refresh } = usePtySession(term, paneId);

  // ── Frequent inputs: the line recorder feeds snippet insertion below. ──
  const setSnippets = useSetAtom(termSnippetsAtom);
  // Typing is blocked in selection mode, so there is nothing to record there.
  const { getCurrentLine, recordSent } = useInputRecorder(term, { paused: selectionMode });

  // ── Send a key combination: the browser eats some of what a term needs ──
  const applicationCursorKeys = Boolean(term?.modes.applicationCursorKeysMode);

  // Phones get a soft-input panel: the keyboard has no arrows, no PgUp/PgDn and
  // no reliable Escape. It is a tile feature rather than a shell one because the
  // panel takes its space from the terminal (so xterm refits and the PTY is told
  // the new size) and because input can then go through the same door as keys.
  const touchFirst = isTouchFirst();
  const [softInputOpen, setSoftInputOpen] = useState(false);

  // term.input() is the right door: it goes through xterm's onData, so the
  // bytes take the same path as typed keys and the line recorder sees them too
  // (a chord either leaves the line alone or, for escape sequences, marks it
  // untrustworthy — never a guess that could be saved and re-run).
  const sendChord = useCallback(
    (bytes: string) => {
      if (!term) return false;
      if (status !== 'connected') {
        showToast(t('terminal.snippets.notReady'));
        return false;
      }
      term.input(bytes);
      return true;
    },
    [showToast, status, t, term],
  );

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
      term?.focus();
    },
    [recordSent, sendRaw, setSnippets, showToast, t, term],
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
          className={`flex ${touchFirst ? 'h-9' : 'h-5'} shrink-0 items-center gap-1.5 border-t px-2 text-[11px] text-white/50 tracking-wide ${
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
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <TermToolbar
              term={term}
              applicationCursorKeys={applicationCursorKeys}
              sendBytes={sendChord}
              insert={insertInput}
              currentLine={getCurrentLine}
              onReset={resetTerminal}
              notice={showToast}
              onSelectionModeChange={setSelectionMode}
              refocus={() => term?.focus()}
              softInput={
                touchFirst
                  ? { open: softInputOpen, onToggle: () => setSoftInputOpen((v) => !v) }
                  : null
              }
            />
          </div>
        </footer>

        {/* Soft input, at the very bottom so it grows *downward*: the grid row
            animates 0fr → 1fr, and the terminal above gives up exactly that much
            height (it is the flex-1 row), which is what makes the PTY resize. */}
        <SoftInputPanel
          open={softInputOpen}
          enabled={status === 'connected'}
          applicationCursorKeys={applicationCursorKeys}
          onSendText={(text) => insertInput({ text }, true)}
          onSendKeys={sendChord}
          onCollapse={() => {
            setSoftInputOpen(false);
            term?.focus();
          }}
        />
        {/* Toast overlay for copy confirmation */}
        {toastMsg && <Toast message={toastMsg} />}
      </div>
    </CommonTileContainer>
  );
}
