import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { readRendererPreference, shouldUseWebgl } from '../../lib/termRenderer';

/**
 * Which renderer this document ended up with, for debugging and headless checks.
 * The decision itself lives in lib/termRenderer.ts, shared with the setting that
 * pins it — some devices, Android Chrome among them, break quietly on WebGL: the
 * canvas composites nothing while the session still says "Connected".
 */
export type TermRenderer = 'webgl' | 'dom';

/**
 * Creates an xterm.js Terminal inside a container ref. Loads the FitAddon,
 * prefers the accelerated WebGL renderer (transparently falling back to the
 * built-in renderer when no GL context is available), and keeps the grid
 * fitted to the container size via a ResizeObserver.
 *
 * Returns setFontSize(size) / setFontFamily(family) to change the terminal
 * font at runtime (the fit addon re-measures the grid for the new metrics),
 * and setTheme(colors) to change theme colors live.
 */
export function useTerminal(
  options: ITerminalOptions,
  initialSize?: { cols: number; rows: number },
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const t = new Terminal(options);
    termRef.current = t;
    const fit = new FitAddon();
    fitRef.current = fit;
    t.loadAddon(fit);
    t.loadAddon(new ClipboardAddon());
    t.open(containerRef.current);
    // xterm 6 paints the theme background only on .xterm-scrollable-element;
    // the .xterm-viewport inside it keeps its stylesheet black, so the band
    // below the last rendered row (screen height is rows * cellHeight) shows
    // a mismatched color. Mirror the theme color onto the viewport too.
    if (options.theme?.background) {
      const viewport = containerRef.current.querySelector<HTMLElement>('.xterm-viewport');
      if (viewport) viewport.style.backgroundColor = options.theme.background;
    }
    // xterm 6 has no cols/rows options; set them explicitly before fitting so
    // the grid is sane even if the container has no measurable box yet.
    if (initialSize) t.resize(initialSize.cols, initialSize.rows);

    // A lost GPU context is routine on a phone: the browser reclaims WebGL
    // contexts when the app is backgrounded or when the page already holds too
    // many (every terminal tile has its own). When that happens the terminal
    // keeps its buffer and its WebSocket, so the status still says "Connected",
    // but the renderer paints nothing — a blank tile with no prompt. Re-attach
    // once, then repaint through whatever renderer is left.
    let disposed = false;
    let webgl: WebglAddon | null = null;
    let retry: number | undefined;
    let renderer: TermRenderer = 'dom';

    const repaint = () => {
      try {
        t.refresh(0, Math.max(0, t.rows - 1));
      } catch {
        // The renderer may not be ready yet; the next resize repaints anyway.
      }
    };

    const attachWebgl = (attempt: number) => {
      if (disposed) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = null;
          repaint();
          if (attempt < 1) {
            retry = window.setTimeout(() => attachWebgl(attempt + 1), 300);
          }
        });
        t.loadAddon(addon);
        webgl = addon;
        renderer = 'webgl';
        (window as unknown as Record<string, unknown>).__termRenderer = renderer;
      } catch {
        webgl?.dispose();
        webgl = null;
        repaint();
      }
    };
    if (shouldUseWebgl(readRendererPreference())) attachWebgl(0);

    // Suppress the browser's native context menu inside the terminal so
    // right-click stays available for copy/paste handling.
    const suppressMenu = (e: MouseEvent) => e.preventDefault();
    const el = containerRef.current;
    el.addEventListener('contextmenu', suppressMenu);

    // The fit addon has no built-in observer: refit on container box changes.
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);
    fit.fit();
    setTerm(t);
    // Debug handles for console tinkering and headless verification.
    (window as unknown as Record<string, unknown>).__term = t;
    (window as unknown as Record<string, unknown>).__termRenderer = renderer;

    return () => {
      disposed = true;
      if (retry) window.clearTimeout(retry);
      el.removeEventListener('contextmenu', suppressMenu);
      ro.disconnect();
      webgl?.dispose();
      t.dispose();
    };
    // Options are static per mount.
  }, []);

  // Runtime font change: update the option, then re-fit the grid since the
  // container box is unchanged but glyph metrics are not.
  const setFontSize = useCallback((size: number) => {
    const t = termRef.current;
    if (!t || t.options.fontSize === size) return;
    t.options.fontSize = size;
    // Wait for render service to update cell dimensions before fit
    setTimeout(() => fitRef.current?.fit(), 200);
  }, []);

  // Runtime font family change: same re-fit need as setFontSize.
  const setFontFamily = useCallback((family: string) => {
    const t = termRef.current;
    if (!t || t.options.fontFamily === family) return;
    t.options.fontFamily = family;
    fitRef.current?.fit();
  }, []);

  // Runtime line height change: xterm recalculates cell dimensions on the
  // next render; the fit addon re-measures after a short delay.
  const setLineHeight = useCallback((lh: number) => {
    const t = termRef.current;
    if (!t || t.options.lineHeight === lh) return;
    t.options.lineHeight = lh;
    setTimeout(() => fitRef.current?.fit(), 200);
  }, []);

  // Runtime theme change: xterm diffs the parsed colors internally and
  // repaints every open renderer (webgl or dom) on its own.
  const setTheme = useCallback((theme: ITheme) => {
    const t = termRef.current;
    if (!t) return;
    t.options.theme = { ...t.options.theme, ...theme };
  }, []);

  return { containerRef, term, setFontSize, setFontFamily, setLineHeight, setTheme };
}
