import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import type { Terminal } from '@xterm/xterm';
import { fontFamilyAtom, termThemeAtom, themeToXtermTheme } from '../../store/appearance';
import { FONT_DEFAULT, lineHeightAtom } from '../../store/fonts';
import { useTerminal } from '../hooks/useTerminal';
import { fetchToken } from '../../lib/api';
import { chunkInput } from '../../lib/wsChunks';

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
  attempt = 0,
  onDetached,
}: BaikalTermProps) {
  const { t } = useTranslation();
  const fontFamily = useAtomValue(fontFamilyAtom);
  const theme = useAtomValue(termThemeAtom);
  const lineHeight = useAtomValue(lineHeightAtom);

  const [state, setState] = useState<ConnState>('connecting');
  const [reason, setReason] = useState<string>('');
  const [reconnect, setReconnect] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<string[]>([]);

  const options = useMemo(
    () => ({
      cursorBlink: true,
      fontSize: FONT_DEFAULT,
      fontFamily,
      lineHeight,
      theme: { ...themeToXtermTheme(theme), background: '#00000000' },
      scrollback: 5000,
    }),
    [fontFamily, lineHeight, theme],
  );

  const { containerRef, term, setFontFamily, setLineHeight, setTheme } = useTerminal(options);

  useEffect(() => {
    setFontFamily(fontFamily);
  }, [fontFamily, setFontFamily]);
  useEffect(() => {
    setLineHeight(lineHeight);
  }, [lineHeight, setLineHeight]);
  useEffect(() => {
    setTheme({ ...themeToXtermTheme(theme), background: '#00000000' });
  }, [theme, setTheme]);

  // The attach lifecycle. Restarts on terminal change, reconnect, or attempt.
  useEffect(() => {
    if (!term) return;
    const current = { ws: null as WebSocket | null, disposed: false, inputReady: false };
    setState('connecting');
    setReason('');

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
            setState('closed');
            setReason(msg.reason ?? '');
            onDetached?.(terminal);
          }
          return;
        }
        term.write(new Uint8Array(event.data as ArrayBuffer));
      };

      ws.onclose = () => {
        if (current.disposed) return;
        current.inputReady = false;
        setState('closed');
      };

      ws.onerror = () => {
        if (current.disposed) return;
        setState('closed');
        setReason((prev) => prev || t('baikal.wsError'));
      };
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
      const ws = current.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || observe) return;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    return () => {
      current.disposed = true;
      dataDisposable.dispose();
      resizeDisposable.dispose();
      const ws = current.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close' }));
      }
      ws?.close();
      socketRef.current = null;
    };
  }, [term, terminal, session, observe, attempt, reconnect, onDetached, t]);

  const retry = useCallback(() => {
    setReconnect((n) => n + 1);
  }, []);

  const dot =
    state === 'ready'
      ? 'bg-green-500'
      : state === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-red-500';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 p-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-white/10 bg-black/40 px-2 text-[11px] tracking-wide text-white/50">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono text-white/60">{terminal}</span>
        {observe && (
          <span className="rounded bg-sky-500/20 px-1 text-sky-300">{t('baikal.observe')}</span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {state === 'ready'
            ? t('baikal.attached')
            : state === 'connecting'
              ? t('baikal.connecting')
              : reason || t('baikal.detached')}
        </span>
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
    </div>
  );
}

/** The terminal instance a pane exposes for tests/debug (xterm is built async). */
export type BaikalTerminalHandle = Terminal;
