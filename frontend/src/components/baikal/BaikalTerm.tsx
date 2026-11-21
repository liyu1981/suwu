import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import type { Terminal } from '@xterm/xterm';
import { fontFamilyAtom, termThemeAtom, themeToXtermTheme } from '../../store/appearance';
import { FONT_DEFAULT, lineHeightAtom } from '../../store/fonts';
import { useTerminal } from '../hooks/useTerminal';
import { useInputRecorder } from '../hooks/useInputRecorder';
import { fetchToken } from '../../lib/api';
import { chunkInput } from '../../lib/wsChunks';
import { buildPayload } from '../../lib/termInput';
import { isTouchFirst } from '../../lib/mobile';
import { TermToolbar } from '../term/TermToolbar';
import { SoftInputPanel } from '../term/SoftInputPanel';

/**
 * One herdr-core terminal, attached over `/ws/baikal/attach`.
 *
 * The wire is deliberately small: binary frames are terminal bytes in both
 * directions, text frames are control (`ready`/`close` down, `resize` up). The
 * server owns the core protocol (framed channels, credit, resize) — see
 * pkg/server/baikal.go — so the browser never speaks to core's socket.
 *
 * Closing this pane detaches; the program in the terminal keeps running.
 */
export interface BaikalTermProps {
  terminal: string;
  session?: string;
  observe?: boolean;
  /** False while the tab is hidden: the pane must not resize the core then. */
  visible?: boolean;
  /** Reports the grid, so a shell started next can be created at this size. */
  onSize?: (cols: number, rows: number) => void;
  /** The pane's tile font size, the same one a /term pane would use. */
  fontSize?: number;
  /** Bumped by the parent to force a fresh attach (the Reconnect button). */
  attempt?: number;
  onDetached?: (terminal: string) => void;
}

type ConnState = 'connecting' | 'ready' | 'closed';

const encoder = new TextEncoder();

/**
 * Input goes out as a binary frame, never text: the server reads text frames as
 * JSON control (`resize`/`close`), so a keystroke sent as text would be parsed as
 * control and dropped.
 */
function send(ws: WebSocket, data: string) {
  const bytes = encoder.encode(data);
  if (bytes.byteLength > 0) ws.send(bytes);
}

export function BaikalTerm({
  terminal,
  session,
  observe = false,
  visible = true,
  attempt = 0,
  onDetached,
  onSize,
  fontSize = FONT_DEFAULT,
}: BaikalTermProps) {
  const { t } = useTranslation();
  const fontFamily = useAtomValue(fontFamilyAtom);
  const theme = useAtomValue(termThemeAtom);
  const lineHeight = useAtomValue(lineHeightAtom);

  const [state, setState] = useState<ConnState>('connecting');
  const [selectionMode, setSelectionMode] = useState(false);
  // Phones get the same soft-input panel the shell tile has: a keyboard without
  // arrows, PgUp/PgDn or a reliable Escape cannot drive vim or less. The panel is
  // this tile's, not the shell's, so its height comes out of the terminal above
  // it — xterm refits and the core is told the new grid, exactly as a desktop
  // window resize would.
  const touchFirst = isTouchFirst();
  const [softInputOpen, setSoftInputOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState<string>('');
  const [reconnect, setReconnect] = useState(0);
  /** Seconds until the next automatic attach, 0 when none is pending. */
  const [retryIn, setRetryIn] = useState(0);
  const attemptsRef = useRef(0);

  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<string[]>([]);
  // The parent re-renders on every snapshot, and both callbacks are often inline
  // arrows there. Holding them in refs keeps the attach effect below from
  // depending on their identity: a new function is not a reason to drop a live
  // stream and dial again (which used to do exactly that, several times a second).
  const onDetachedRef = useRef(onDetached);
  onDetachedRef.current = onDetached;
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;
  // Visibility gates *resizing*, never the attachment: hiding a tab (switching
  // space, or to another tab) must not close the stream and dial again.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 2000);
  }, []);

  const options = useMemo(
    () => ({
      cursorBlink: true,
      fontSize,
      fontFamily,
      lineHeight,
      theme: { ...themeToXtermTheme(theme), background: '#00000000' },
      scrollback: 5000,
    }),
    [fontFamily, fontSize, lineHeight, theme],
  );

  const { containerRef, term, fit, setFontSize, setFontFamily, setLineHeight, setTheme } =
    useTerminal(options);

  // The attached terminal is a shell too: the recorder gives "save this command"
  // something to capture and keeps snippet insertion in the recent list.
  const { getCurrentLine, recordSent } = useInputRecorder(term, { paused: selectionMode });

  // DECCKM is read here for the chord palette and the soft-input arrows: the
  // bytes differ between a shell prompt and an app like vim, and both must see
  // the mode the terminal is in when the button is pressed.
  const applicationCursorKeys = Boolean(term?.modes.applicationCursorKeysMode);

  // A font change changes the grid. Fitting is what turns the new cell size into
  // cols/rows, and the resize handler then tells the core — a shell that was
  // laid out for the old font would otherwise wrap in the wrong places.
  useEffect(() => {
    if (!term) return;
    setFontSize(fontSize);
    if (visible) fit();
  }, [fontSize, fit, setFontSize, term, visible]);
  useEffect(() => {
    setFontFamily(fontFamily);
  }, [fontFamily, setFontFamily]);
  useEffect(() => {
    setLineHeight(lineHeight);
  }, [lineHeight, setLineHeight]);
  useEffect(() => {
    setTheme({ ...themeToXtermTheme(theme), background: '#00000000' });
  }, [theme, setTheme]);

  // Snippet/text insertion: the same paste semantics as the shell tile —
  // bracketed paste when the program asked for it, then the carriage return.
  const insert = useCallback(
    (request: { text: string; snippetId?: string }, run: boolean) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        showNotice(t('terminal.snippets.notReady'));
        return;
      }
      const payload = buildPayload(request.text, run, Boolean(term?.modes.bracketedPasteMode));
      for (const part of chunkInput(payload)) send(ws, part);
      recordSent(payload);
      term?.focus();
    },
    [recordSent, showNotice, t, term],
  );

  // Chords go through xterm so they take the same path as typed keys.
  const sendBytes = useCallback(
    (bytes: string) => {
      term?.input(bytes);
    },
    [term],
  );

  const retry = useCallback(() => {
    setReconnect((n) => n + 1);
  }, []);

  // The attach lifecycle. Restarts on terminal change, reconnect, or attempt.
  useEffect(() => {
    if (!term) return;
    const current = {
      ws: null as WebSocket | null,
      disposed: false,
      inputReady: false,
      /** Set when the core itself ended the stream (program exited, detached). */
      closedByCore: false,
      timers: [] as number[],
    };
    setState('connecting');
    setReason('');
    setRetryIn(0);

    const connect = async () => {
      const { token } = await fetchToken();
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        token,
        terminal,
        cols: String(Math.max(1, term.cols)),
        rows: String(Math.max(1, term.rows)),
        observe: observe ? '1' : '0',
      });
      if (session) params.set('session', session);
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/baikal/attach?${params}`);
      ws.binaryType = 'arraybuffer';
      current.ws = ws;
      socketRef.current = ws;

      ws.onmessage = (event) => {
        if (current.disposed) return;
        if (typeof event.data === 'string') {
          let msg: { type?: string; reason?: string; cols?: number; rows?: number };
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg.type === 'ready') {
            current.inputReady = true;
            attemptsRef.current = 0;
            // The pane may have been fitted again while the attach handshake ran
            // (the tile's iframe gets its final size after mount); send the
            // current grid so the core is not left at the early, narrow one.
            if (!observe) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
            setState('ready');
            // Anything typed while the attach was in flight goes now, in order.
            for (const chunk of pendingRef.current) {
              for (const part of chunkInput(chunk)) send(ws, part);
            }
            pendingRef.current = [];
            term.focus();
            return;
          }
          if (msg.type === 'close') {
            current.inputReady = false;
            const why = msg.reason ?? '';
            // A program that exited (or was killed) is gone for good; anything
            // else — a stopped core, a lost holder — is worth reattaching to.
            current.closedByCore = why === 'exited' || why === 'killed';
            setState('closed');
            setReason(why);
            onDetachedRef.current?.(terminal);
            if (!current.closedByCore) scheduleRetry(current);
          }
          return;
        }
        term.write(new Uint8Array(event.data as ArrayBuffer));
      };

      ws.onclose = () => {
        if (current.disposed) return;
        current.inputReady = false;
        setState('closed');
        // A lost line (the server, the tunnel, the core restarting) is not the
        // program ending: reattach with backoff, and say so. A CLOSE from core
        // means the program exited or another viewer took over — don't fight it.
        if (!current.closedByCore) scheduleRetry(current);
      };

      ws.onerror = () => {
        if (current.disposed) return;
        setState('closed');
        setReason((prev) => prev || t('baikal.wsError'));
      };
    };

    // Reattach after a dropped connection: 2 s, 4 s, 8 s, then every 15 s. The
    // counter lives across attempts so a flapping core cannot turn into a tight
    // reconnect loop.
    const scheduleRetry = (current: { disposed: boolean; timers: number[] }) => {
      if (current.disposed) return;
      const delay = Math.min(2000 * 2 ** Math.min(attemptsRef.current, 3), 15000);
      attemptsRef.current += 1;
      let remaining = Math.round(delay / 1000);
      setRetryIn(remaining);
      const tick = window.setInterval(() => {
        remaining -= 1;
        setRetryIn(Math.max(0, remaining));
      }, 1000);
      const timer = window.setTimeout(() => {
        window.clearInterval(tick);
        setRetryIn(0);
        setReconnect((n) => n + 1);
      }, delay);
      current.timers.push(tick, timer);
    };

    void connect();

    const dataDisposable = term.onData((data) => {
      const ws = current.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!current.inputReady) {
        pendingRef.current.push(data);
        return;
      }
      for (const part of chunkInput(data)) send(ws, part);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      onSizeRef.current?.(cols, rows);
      const ws = current.ws;
      // A hidden pane measures 0×0; resizing the core to that makes the shell
      // redraw its prompt in a one-column terminal.
      if (!ws || ws.readyState !== WebSocket.OPEN || observe || !visibleRef.current) return;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    return () => {
      current.disposed = true;
      for (const timer of current.timers) {
        window.clearTimeout(timer);
        window.clearInterval(timer);
      }
      dataDisposable.dispose();
      resizeDisposable.dispose();
      const ws = current.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close' }));
      }
      ws?.close();
      socketRef.current = null;
    };
    // `visible` is deliberately absent: it is a resize concern, and re-attaching
    // on every tab switch flashed "connecting" and cost a dial per switch.
  }, [term, terminal, session, observe, attempt, reconnect, t]);

  useEffect(() => {
    if (term && term.cols > 0 && term.rows > 0) onSizeRef.current?.(term.cols, term.rows);
  }, [term]);

  // Revealing a tab: fit to the box it now has, and tell the core once. This is
  // the only resize a hidden/shown cycle is allowed to cause.
  useEffect(() => {
    if (!term || !visible) return;
    const id = window.setTimeout(() => {
      fit();
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && !observe) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }, 30);
    return () => window.clearTimeout(id);
  }, [term, visible, observe, fit]);

  const dot =
    state === 'ready'
      ? 'bg-green-500'
      : state === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-red-500';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 p-1">
        {/* `baikal-term` hides the scrollbar: the wheel and keyboard reach the
            scrollback, and a full-tile terminal does not need a visible bar. */}
        <div ref={containerRef} className="baikal-term h-full w-full" />
      </div>
      <footer
        className={`flex ${touchFirst ? 'h-9' : 'h-6'} shrink-0 items-center gap-2 border-t border-white/10 bg-black/40 px-2 text-[11px] tracking-wide text-white/50`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono text-white/60">{terminal}</span>
        {observe && (
          <span className="rounded bg-sky-500/20 px-1 text-sky-300">{t('baikal.observe')}</span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {selectionMode
            ? t('terminal.selectionMode')
            : notice
              ? notice
              : state === 'ready'
                ? t('baikal.attached')
                : state === 'connecting'
                  ? t('baikal.connecting')
                  : retryIn > 0
                    ? t('baikal.reconnectingIn', { seconds: retryIn })
                    : reason || t('baikal.detached')}
        </span>
        <TermToolbar
          term={term}
          applicationCursorKeys={applicationCursorKeys}
          sendBytes={sendBytes}
          insert={insert}
          currentLine={getCurrentLine}
          notice={showNotice}
          onSelectionModeChange={setSelectionMode}
          refocus={() => term?.focus()}
          softInput={
            touchFirst ? { open: softInputOpen, onToggle: () => setSoftInputOpen((v) => !v) } : null
          }
        />
        {state === 'closed' && (
          <button
            type="button"
            onClick={retry}
            className="rounded px-1.5 py-0.5 text-sky-300 transition hover:bg-white/10 hover:text-sky-200"
          >
            {t('baikal.reconnect')}
          </button>
        )}
      </footer>
      {/* Below the status bar, at the tile's bottom edge: growing the row takes
          the height from the terminal, which is what resizes the core's grid. */}
      <SoftInputPanel
        open={softInputOpen}
        enabled={state === 'ready'}
        applicationCursorKeys={applicationCursorKeys}
        onSendText={(text) => insert({ text }, true)}
        onSendKeys={sendBytes}
        onCollapse={() => {
          setSoftInputOpen(false);
          term?.focus();
        }}
      />
    </div>
  );
}

/** The terminal instance a pane exposes for tests/debug (xterm is built async). */
export type BaikalTerminalHandle = Terminal;
