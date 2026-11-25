import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { FileViewer, type ViewerEventHandler } from '@file-viewer/react';
import { registerFileViewerMermaidLoader } from '@file-viewer/renderer-text';
import standardPreset from '@file-viewer/preset-standard';
import { authFetch } from '../lib/api';
import { fileViewerThemeAtom } from '../store/settings';
import { CommonTileContainer } from '../components/CommonTileContainer';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  PlusIcon,
  RefreshIcon,
} from '../components/icons';
import { ExitFocusIcon, FocusIcon } from '../wm/icons';
import { hostedByMobileShell } from '../lib/mobile';
import { setPageTransparent } from '../lib/constants';
import {
  useAutoRefreshDropdown,
  AutoRefreshDropdown,
  AutoRefreshTrigger,
} from '../components/AutoRefreshDropdown';

/**
 * Full-space file viewer page loaded inside each file viewer pane's iframe.
 * Renders the file at the path passed via ?path= URL param using
 * @file-viewer/react with office preset and 3D renderer for minimal bundle.
 *
 * Files are fetched with the stored Basic auth credentials and passed as a
 * Blob URL to the viewer component, since it cannot send custom headers.
 *
 * The day/night choice is the viewer toolbar's own toggle: each flip is
 * persisted (fileViewerThemeAtom, localStorage) and fed back into the viewer's
 * options, so every pane — including a later one — reopens on it. Keeping the
 * options in sync matters: the wrapper applies `options` on every change, and a
 * stale theme would flip the viewer back mid-session.
 */
registerFileViewerMermaidLoader(() => import('../lib/fileViewerPeleMermaid'));

/** One tap of the phone pan arrows moves the diagram this far, in screen px. */
const PAN_STEP = 48;

export default function FileViewerPage() {
  const { t } = useTranslation();
  const paneRef = useRef<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [lightboxScale, setLightboxScale] = useState(1);
  const [lightboxOffset, setLightboxOffset] = useState({ x: 0, y: 0 });
  const [lightboxIsDark, setLightboxIsDark] = useState(false);
  const [lightboxFocused, setLightboxFocused] = useState(false);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(0);
  const dropdownState = useAutoRefreshDropdown();
  const abortRef = useRef<AbortController | null>(null);

  // Day/night as last chosen in this (or another) file viewer pane.
  const [viewerTheme, setViewerTheme] = useAtom(fileViewerThemeAtom);
  const viewerThemeRef = useRef(viewerTheme);
  useEffect(() => {
    viewerThemeRef.current = viewerTheme;
  }, [viewerTheme]);

  // One place that puts a clicked diagram into the lightbox; zoom and pan reset
  // on every open, however the diagram was reached.
  const showSvg = useCallback((svg: SVGElement) => {
    const theme = viewerThemeRef.current;
    const isDark =
      theme === 'dark' ||
      (theme !== 'light' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const darkVars =
      '--pele-bg:#1e1e1e;--pele-fg:#e6e6e6;--pele-muted:#a0a0a0;' +
      '--pele-line:#e6e6e6;--pele-surface:#2a2a2a;--pele-surface-alt:#333333;' +
      '--pele-border:#555555;--pele-accent:#7aa2f7;';
    let html = svg.outerHTML;
    if (isDark && !html.includes('--pele-fg:#e6e6e6')) {
      if (/<svg\b[^>]*\bstyle="/.test(html)) {
        html = html.replace(/(<svg\b[^>]*\bstyle=")([^"]*)(")/, `$1$2;${darkVars}$3`);
      } else {
        html = html.replace(/<svg\b/, `<svg style="${darkVars}"`);
      }
    }
    setLightboxIsDark(isDark);
    setLightboxSvg(html);
    setLightboxScale(1);
    setLightboxOffset({ x: 0, y: 0 });
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxSvg(null);
    setLightboxFocused(false);
  }, []);

  const viewerOptions = useMemo(
    () => ({
      preset: standardPreset,
      rendererMode: 'replace' as const,
      theme: viewerTheme,
      toolbar: { position: 'bottom-right' as const },
    }),
    [viewerTheme],
  );

  // The toolbar toggle derives its next value from `options.theme` and emits
  // the result; record it so the choice survives reloads and travels to the
  // other panes (a stable identity also keeps the wrapper from re-applying
  // unchanged options on every render).
  const handleViewerEvent = useCallback<ViewerEventHandler>(
    (event) => {
      if (event.type === 'theme-change') setViewerTheme(event.payload);
    },
    [setViewerTheme],
  );

  const handleStateChange = useCallback((state: { error: unknown | null }) => {
    if (state.error) {
      setRenderError(state.error instanceof Error ? state.error.message : String(state.error));
    }
  }, []);

  // Fetch file content
  const fetchFile = useCallback(async (path: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await authFetch(`/api/file?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = path.split('/').pop() || 'file';
      setFilePath(path);
      setFileName(name);
      setFileUrl(URL.createObjectURL(blob));
      setError(null);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Failed to load file');
    }
  }, []);

  // Initial load from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    paneRef.current = params.get('pane');
    const path = params.get('path');
    if (!path) return;

    fetchFile(path);
    return () => abortRef.current?.abort();
  }, [fetchFile]);

  // Make background transparent so the tiling WM background shows through.
  useEffect(() => {
    setPageTransparent();
  }, []);

  // Open a lightbox when a rendered Mermaid diagram is clicked. Event
  // delegation covers diagrams rendered lazily by the viewer.
  useEffect(() => {
    const tryOpen = (shell: Element) => {
      const svg = (shell.matches('svg') ? shell : shell.querySelector('svg')) as SVGElement | null;
      if (svg) showSvg(svg);
    };

    let shadowRoot: ShadowRoot | null = null;
    let observer: MutationObserver | null = null;

    const attach = (root: ParentNode) => {
      root.querySelectorAll('.markdown-mermaid, .markdown-mermaid-svg').forEach((el) => {
        if ((el as any).__lightboxBound) return;
        (el as any).__lightboxBound = true;
        (el as HTMLElement).style.cursor = 'pointer';
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          tryOpen(el);
        });
      });
    };

    const discover = () => {
      if (shadowRoot) return true;
      const host = viewerHostRef.current;
      if (!host) return false;
      // Try direct shadow root on host or any descendant host.
      // The viewer renders into an open shadow root hosted by a
      // `.file-render-host` element. Find it and pierce the shadow.
      const hosts = Array.from(host.querySelectorAll('.file-render-host')) as HTMLElement[];
      for (const h of hosts) {
        if (h.shadowRoot) {
          shadowRoot = h.shadowRoot;
          const rootSr = shadowRoot as ShadowRoot;
          observer = new MutationObserver(() => attach(rootSr));
          observer.observe(rootSr, { childList: true, subtree: true });
          attach(rootSr);
          return true;
        }
      }
      // Fallback: any element with a shadowRoot.
      for (const node of [host, ...Array.from(host.querySelectorAll('*'))]) {
        const sr = (node as HTMLElement).shadowRoot;
        if (sr) {
          shadowRoot = sr;
          const rootSr = shadowRoot as ShadowRoot;
          observer = new MutationObserver(() => attach(rootSr));
          observer.observe(rootSr, { childList: true, subtree: true });
          attach(rootSr);
          return true;
        }
      }
      return false;
    };

    const timer = setInterval(() => {
      if (!shadowRoot) discover();
    }, 1500);
    discover();

    return () => {
      if (observer) observer.disconnect();
      clearInterval(timer);
    };
  }, [showSvg]);

  // Escape closes the lightbox.
  useEffect(() => {
    if (!lightboxSvg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSvg, closeLightbox]);

  // Non-passive wheel zoom for the lightbox (React's onWheel is passive).
  useEffect(() => {
    const el = dragContainerRef.current;
    if (!el || !lightboxSvg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setLightboxScale((sc) => Math.min(4, Math.max(0.25, sc - e.deltaY * 0.001)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [lightboxSvg]);

  // Catch unhandled promise rejections from renderers (e.g. image decode failures).
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg =
        e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'Render failed');
      setRenderError(msg);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  // Listen for path updates from the parent (when tile is reused with a new file).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; path?: string } | undefined;
      if (d?.type === 'tile-path-update' && typeof d.path === 'string') {
        fetchFile(d.path);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [fetchFile]);

  // Auto-refresh timer
  useEffect(() => {
    if (autoRefresh <= 0 || !filePath) return;
    const timer = setInterval(() => {
      fetchFile(filePath);
    }, autoRefresh);
    return () => clearInterval(timer);
  }, [autoRefresh, filePath, fetchFile]);

  const handleRefresh = useCallback(() => {
    if (filePath) fetchFile(filePath);
  }, [filePath, fetchFile]);

  const handleIntervalSelect = useCallback(
    (ms: number) => {
      setAutoRefresh(ms);
      dropdownState.close();
    },
    [dropdownState],
  );

  if (error) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-[calc(100vh-16px)] w-[calc(100vw-16px)] items-center justify-center bg-transparent">
          <span className="text-[11px] text-red-400/70">{error}</span>
        </div>
        {dropdownState.showDropdown && (
          <AutoRefreshDropdown
            value={autoRefresh}
            onChange={handleIntervalSelect}
            dropdownRef={dropdownState.dropdownRef}
            dropdownPos={dropdownState.dropdownPos}
          />
        )}
      </CommonTileContainer>
    );
  }

  if (!fileUrl) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-[calc(100vh-16px)] w-[calc(100vw-16px)] items-center justify-center bg-transparent">
          <span className="text-[11px] text-white/30">Loading...</span>
        </div>
        {dropdownState.showDropdown && (
          <AutoRefreshDropdown
            value={autoRefresh}
            onChange={handleIntervalSelect}
            dropdownRef={dropdownState.dropdownRef}
            dropdownPos={dropdownState.dropdownPos}
          />
        )}
      </CommonTileContainer>
    );
  }

  const header = filePath ? (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/10 bg-black/30 px-3 backdrop-blur-md">
      {/* Refresh button */}
      <button
        type="button"
        onClick={handleRefresh}
        className={`grid h-5 w-5 place-items-center rounded transition hover:bg-white/10 ${
          autoRefresh > 0 ? 'text-green-400' : 'text-white/50 hover:text-white/70'
        }`}
        title="Refresh"
      >
        <RefreshIcon />
      </button>
      {/* Auto-refresh dropdown trigger */}
      <AutoRefreshTrigger
        btnRef={dropdownState.btnRef}
        isActive={autoRefresh > 0}
        onClick={dropdownState.toggle}
      />
      <span className="truncate text-xs text-white/50" title={filePath}>
        {filePath}
      </span>
    </div>
  ) : null;

  if (renderError) {
    return (
      <CommonTileContainer paneId={paneRef.current ?? undefined}>
        <div className="flex h-[calc(100vh-16px)] w-[calc(100vw-16px)] flex-col bg-transparent">
          {header}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <svg
              className="h-10 w-10 text-white/20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <p className="max-w-[80%] text-center text-[11px] text-white/40">{renderError}</p>
            <span className="text-[10px] text-white/25">{fileName}</span>
          </div>
        </div>
        {dropdownState.showDropdown && (
          <AutoRefreshDropdown
            value={autoRefresh}
            onChange={handleIntervalSelect}
            dropdownRef={dropdownState.dropdownRef}
            dropdownPos={dropdownState.dropdownPos}
          />
        )}
      </CommonTileContainer>
    );
  }

  return (
    <CommonTileContainer paneId={paneRef.current ?? undefined}>
      <div className="flex h-[calc(100vh-16px)] w-[calc(100vw-16px)] flex-col bg-transparent">
        {header}
        <div className="min-h-0 flex-1" ref={viewerHostRef}>
          <FileViewer
            url={fileUrl}
            filename={fileName ?? undefined}
            options={viewerOptions}
            onEvent={handleViewerEvent}
            onStateChange={handleStateChange}
          />
        </div>
      </div>
      {dropdownState.showDropdown && (
        <AutoRefreshDropdown
          value={autoRefresh}
          onChange={handleIntervalSelect}
          dropdownRef={dropdownState.dropdownRef}
          dropdownPos={dropdownState.dropdownPos}
        />
      )}
      {lightboxSvg && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={closeLightbox}
        >
          <div
            className={`relative flex flex-col overflow-hidden ${
              lightboxFocused ? 'h-full w-full rounded-none' : 'h-[80vh] w-[80vw] rounded-lg'
            } ${lightboxIsDark ? 'bg-neutral-900 text-white' : 'bg-white text-black'}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Controls go on the left: the WM hover toolbar owns the top-right corner. */}
            <div className="absolute left-2 top-2 z-10 flex gap-1 rounded-md bg-black/50 p-0.5">
              <button
                type="button"
                aria-label={t('lightbox.zoomIn')}
                title={t('lightbox.zoomIn')}
                onClick={() => setLightboxScale((s) => Math.min(4, s + 0.25))}
                className="grid h-6 w-6 place-items-center rounded text-white/70 glass-btn hover:bg-white/10 hover:text-white"
              >
                <PlusIcon />
              </button>
              <button
                type="button"
                aria-label={t('lightbox.zoomOut')}
                title={t('lightbox.zoomOut')}
                onClick={() => setLightboxScale((s) => Math.max(0.25, s - 0.25))}
                className="grid h-6 w-6 place-items-center rounded text-white/70 glass-btn hover:bg-white/10 hover:text-white"
              >
                <MinusIcon />
              </button>
              <button
                type="button"
                aria-label={lightboxFocused ? t('lightbox.exitFocus') : t('lightbox.focus')}
                title={lightboxFocused ? t('lightbox.exitFocus') : t('lightbox.focus')}
                aria-pressed={lightboxFocused}
                onClick={() => setLightboxFocused((f) => !f)}
                className={`grid h-6 w-6 place-items-center rounded glass-btn hover:bg-white/10 hover:text-white ${
                  lightboxFocused ? 'text-white' : 'text-white/70'
                }`}
              >
                {lightboxFocused ? <ExitFocusIcon /> : <FocusIcon />}
              </button>
              <button
                type="button"
                aria-label={t('lightbox.close')}
                title={t('lightbox.close')}
                onClick={closeLightbox}
                className="grid h-6 w-6 place-items-center rounded text-white/70 glass-btn hover:bg-rose-500/20 hover:text-rose-200"
              >
                <CloseIcon />
              </button>
            </div>
            <div
              ref={dragContainerRef}
              className="flex min-h-0 flex-1 items-center justify-center cursor-grab active:cursor-grabbing"
              onMouseDown={(e) => {
                dragRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  ox: lightboxOffset.x,
                  oy: lightboxOffset.y,
                };
              }}
              onMouseMove={(e) => {
                if (!dragRef.current) return;
                setLightboxOffset({
                  x: dragRef.current.ox + (e.clientX - dragRef.current.x),
                  y: dragRef.current.oy + (e.clientY - dragRef.current.y),
                });
              }}
              onMouseUp={() => {
                dragRef.current = null;
              }}
              onMouseLeave={() => {
                dragRef.current = null;
              }}
            >
              <div
                style={{
                  transform: `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxScale})`,
                  transformOrigin: 'center center',
                }}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is produced by Pele and sanitized by file-viewer
                dangerouslySetInnerHTML={{ __html: lightboxSvg }}
              />
            </div>
            {/* Phone shell: no mouse drag, so a second row of arrows pans the diagram. */}
            {hostedByMobileShell() && (
              <div
                className={`z-10 flex shrink-0 items-center justify-center gap-1 bg-black/60 px-3 py-2 ${
                  lightboxFocused ? '' : 'rounded-b-lg'
                }`}
              >
                <button
                  type="button"
                  aria-label={t('lightbox.panLeft')}
                  title={t('lightbox.panLeft')}
                  onClick={() => setLightboxOffset((o) => ({ ...o, x: o.x + PAN_STEP }))}
                  className="grid h-7 w-7 place-items-center rounded text-white/80 glass-btn hover:bg-white/10 hover:text-white"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={t('lightbox.panUp')}
                  title={t('lightbox.panUp')}
                  onClick={() => setLightboxOffset((o) => ({ ...o, y: o.y + PAN_STEP }))}
                  className="grid h-7 w-7 place-items-center rounded text-white/80 glass-btn hover:bg-white/10 hover:text-white"
                >
                  <ChevronUpIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={t('lightbox.panDown')}
                  title={t('lightbox.panDown')}
                  onClick={() => setLightboxOffset((o) => ({ ...o, y: o.y - PAN_STEP }))}
                  className="grid h-7 w-7 place-items-center rounded text-white/80 glass-btn hover:bg-white/10 hover:text-white"
                >
                  <ChevronUpIcon className="h-4 w-4 rotate-180" />
                </button>
                <button
                  type="button"
                  aria-label={t('lightbox.panRight')}
                  title={t('lightbox.panRight')}
                  onClick={() => setLightboxOffset((o) => ({ ...o, x: o.x - PAN_STEP }))}
                  className="grid h-7 w-7 place-items-center rounded text-white/80 glass-btn hover:bg-white/10 hover:text-white"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </CommonTileContainer>
  );
}

function MinusIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}
