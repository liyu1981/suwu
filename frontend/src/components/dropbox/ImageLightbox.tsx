import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchToken } from '../../lib/api';
import {
  LIGHTBOX_MAX_SCALE,
  type Vec,
  clampPan,
  clampScale,
  fitSize,
  nextScale,
  zoomAround,
} from '../../lib/lightbox';

/**
 * Full-tile image preview for the Dropbox list.
 *
 * Opened by clicking an image's thumbnail in the expanded row. It shows the
 * picture at fitted size and lets you zoom (wheel, +/−, double-click) and drag to
 * pan, with the pan bounded so the image can never be thrown off screen.
 *
 * Panning is 1:1 with the pointer (pointer capture, no transition); only the
 * button/double-click zoom animates, and it respects prefers-reduced-motion.
 * Escape and a click on the empty backdrop close it; focus returns where it came
 * from.
 */
export function ImageLightbox({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Vec>({ x: 0, y: 0 });
  const [animated, setAnimated] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; start: Vec; origin: Vec } | null>(null);

  // The tile's iframe has no credentials of its own: fetch the bytes with the
  // session token and hand the <img> an object URL.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const { signedFetch } = await fetchToken();
        const res = await signedFetch(`/api/file?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  // Focus moves into the sheet while it is open, and back afterwards.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  /** Viewport, fitted image size and the pan limits, measured on demand. */
  const metrics = useCallback(() => {
    const view = viewportRef.current;
    const img = imageRef.current;
    if (!view || !img) return null;
    const viewW = view.clientWidth;
    const viewH = view.clientHeight;
    const fit = fitSize(img.naturalWidth, img.naturalHeight, viewW, viewH);
    return { viewW, viewH, fitW: fit.x, fitH: fit.y };
  }, []);

  /**
   * Zoom to `target`, keeping `cursor` (relative to the viewport centre) still
   * and clamping the pan into range.
   */
  const applyZoom = useCallback(
    (target: number, cursor: Vec = { x: 0, y: 0 }, animate = true) => {
      const m = metrics();
      setAnimated(animate);
      setScale((current) => {
        const next = clampScale(target);
        setOffset((prev) => {
          const moved = zoomAround(cursor, prev, current, next);
          if (!m) return moved;
          return clampPan(moved, next, m.fitW, m.fitH, m.viewW, m.viewH);
        });
        return next;
      });
    },
    [metrics],
  );

  const reset = useCallback(() => {
    setAnimated(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Wheel must not scroll the page, and React's onWheel is passive — so the
  // listener is attached by hand with preventDefault.
  useEffect(() => {
    const view = viewportRef.current;
    if (!view) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = view.getBoundingClientRect();
      const cursor = {
        x: e.clientX - (rect.left + rect.width / 2),
        y: e.clientY - (rect.top + rect.height / 2),
      };
      const factor = Math.exp(-e.deltaY * 0.0015);
      const m = metrics();
      setAnimated(false);
      setScale((current) => {
        const next = clampScale(current * factor);
        setOffset((prev) => {
          const moved = zoomAround(cursor, prev, current, next);
          if (!m) return moved;
          return clampPan(moved, next, m.fitW, m.fitH, m.viewW, m.viewH);
        });
        return next;
      });
    };
    view.addEventListener('wheel', onWheel, { passive: false });
    return () => view.removeEventListener('wheel', onWheel);
  }, [metrics]);

  // Escape closes; +/− zoom; 0 fits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        applyZoom(nextScale(scale, 1));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        applyZoom(nextScale(scale, -1));
      } else if (e.key === '0') {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyZoom, onClose, reset, scale]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return; // nothing to pan at fitted size
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, origin: offset };
    setAnimated(false);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const m = metrics();
    const moved = {
      x: drag.origin.x + (e.clientX - drag.start.x),
      y: drag.origin.y + (e.clientY - drag.start.y),
    };
    setOffset(m ? clampPan(moved, scale, m.fitW, m.fitH, m.viewW, m.viewH) : moved);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cursor = {
      x: e.clientX - (rect.left + rect.width / 2),
      y: e.clientY - (rect.top + rect.height / 2),
    };
    applyZoom(scale > 1 ? 1 : 2.5, cursor);
  };

  const percent = Math.round(scale * 100);
  const pannable = scale > 1;

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.viewing', { name })}
      tabIndex={-1}
      className="absolute inset-0 z-30 flex flex-col bg-black/85 outline-none backdrop-blur-sm"
    >
      {/* Name, zoom, close */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm text-white/80" title={name}>
          {name}
        </span>
        <button
          type="button"
          onClick={() => applyZoom(nextScale(scale, -1))}
          disabled={scale <= 1}
          aria-label={t('lightbox.zoomOut')}
          title={t('lightbox.zoomOut')}
          className="grid h-6 w-6 place-items-center rounded text-white/70 transition glass-btn hover:bg-white/10 hover:text-white disabled:opacity-30"
        >
          <MinusIcon />
        </button>
        <span className="w-10 text-center text-[10px] tabular-nums text-white/50">{percent}%</span>
        <button
          type="button"
          onClick={() => applyZoom(nextScale(scale, 1))}
          disabled={scale >= LIGHTBOX_MAX_SCALE}
          aria-label={t('lightbox.zoomIn')}
          title={t('lightbox.zoomIn')}
          className="grid h-6 w-6 place-items-center rounded text-white/70 transition glass-btn hover:bg-white/10 hover:text-white disabled:opacity-30"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label={t('lightbox.reset')}
          title={t('lightbox.reset')}
          className="rounded px-1.5 py-0.5 text-[11px] text-white/60 transition glass-btn hover:bg-white/10 hover:text-white"
        >
          {t('lightbox.fit')}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('lightbox.close')}
          title={t('lightbox.close')}
          className="grid h-6 w-6 place-items-center rounded text-white/70 transition glass-btn hover:bg-rose-500/20 hover:text-rose-200"
        >
          <CloseIcon />
        </button>
      </div>

      {/* The picture */}
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
        onClick={(e) => {
          // A click on the empty backdrop closes; one on the picture does not.
          if (e.target === e.currentTarget) onClose();
        }}
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden ${
          pannable ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
        }`}
      >
        {failed ? (
          <div className="grid h-full place-items-center px-6 text-center text-[11px] text-white/50">
            {t('lightbox.failed')}
          </div>
        ) : src ? (
          <img
            ref={imageRef}
            src={src}
            alt={name}
            draggable={false}
            className={`absolute left-1/2 top-1/2 max-h-full max-w-full object-contain shadow-[0_8px_40px_rgb(0_0_0/0.55)] ${
              animated ? 'transition-transform duration-200 motion-reduce:transition-none' : ''
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            }}
          />
        ) : (
          <div className="grid h-full place-items-center text-[11px] text-white/40">
            {t('dropbox.loadingPreview')}
          </div>
        )}
      </div>

      {!pannable && (
        <p className="pointer-events-none shrink-0 pb-2 text-center text-[11px] text-white/35">
          {t('lightbox.hint')}
        </p>
      )}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
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

function CloseIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
