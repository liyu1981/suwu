import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SoftInputBar, SoftInputIcon } from './SoftInputBar';

/**
 * The soft-input panel and its toggle, shared by the two tiles that host a
 * terminal: the shell tile (`/term`) and Baikal's attached terminals.
 *
 * The panel is a tile feature, not a shell one (see `SoftInputBar`): it takes its
 * height from the terminal above it, which is what makes xterm refit and the PTY
 * — or the attached core — receive a new grid size. Encapsulating the row here
 * means both tiles animate, focus and collapse it identically, and the toolbar
 * can carry the toggle in the same place in both.
 *
 * Kept mounted so the row can animate from `0fr` to `1fr` and so a half-typed
 * line survives a collapse; `inert` keeps a closed panel out of the tab order.
 */
export interface SoftInputPanelProps {
  open: boolean;
  /** The session is attached and accepting input. */
  enabled: boolean;
  /** DECCKM: read from xterm at click time by the caller. */
  applicationCursorKeys: boolean;
  onSendText: (text: string) => void;
  onSendKeys: (bytes: string) => void;
  onCollapse: () => void;
}

/**
 * Focus lands after the row has finished opening: it is still clipped while the
 * transition runs, and focusing a clipped input scrolls the tile.
 */
const FOCUS_DELAY_MS = 220;

export function SoftInputPanel({
  open,
  enabled,
  applicationCursorKeys,
  onSendText,
  onSendKeys,
  onCollapse,
}: SoftInputPanelProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      rowRef.current?.querySelector('input')?.focus();
    }, FOCUS_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <div
      className="grid shrink-0 transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      aria-hidden={!open}
      {...(!open ? { inert: true } : {})}
    >
      <div ref={rowRef} className="min-h-0 overflow-hidden">
        <SoftInputBar
          enabled={enabled}
          applicationCursorKeys={applicationCursorKeys}
          onSendText={onSendText}
          onSendKeys={onSendKeys}
          onCollapse={onCollapse}
        />
      </div>
    </div>
  );
}

export interface SoftInputToggleProps {
  open: boolean;
  onToggle: () => void;
  /** Caller's button classes (the toolbar has its own shared one). */
  className?: string;
  iconClassName?: string;
}

/**
 * The button that opens the panel, drawn as an I-beam caret with text lines: it
 * opens a place to *type a line*, so it must not look like the chord palette's
 * keyboard outline next to it.
 */
export function SoftInputToggle({
  open,
  onToggle,
  className,
  iconClassName = 'h-4 w-4',
}: SoftInputToggleProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t('softInput.toggle')}
      aria-expanded={open}
      title={t('softInput.toggle')}
      onClick={onToggle}
      className={className}
    >
      <SoftInputIcon className={iconClassName} />
    </button>
  );
}
