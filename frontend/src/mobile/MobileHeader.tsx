import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ChevronLeftIcon, ChevronRightIcon, MenuIcon } from '../components/icons';

/**
 * The phone shell's header: one 44 px row, fixed at the top, never dockable.
 *
 * It exists only on `/mobile`; the desktop header keeps its settings-controlled
 * docking (`headerPositionAtom`). The buttons here are the whole navigation —
 * there is no hover toolbar, no drag, and no divider on a phone:
 *
 *   [☰ menu]  [space]      ‹  tile  ›        [overview]  [notifications]
 *
 * Every control is at least 40 px square (Apple's tap-target floor), and the row
 * pads itself with `env(safe-area-inset-*)` so the notch and the home indicator
 * never sit on top of a button.
 */

// Desktop header buttons are h-7 inside a py-1 panel; the phone keeps the same
// proportions (h-8 inside py-0.5, 38 px of bar) because a floating panel that is
// taller than the icons inside it looks like a toolbar, not chrome.
const btn =
  'grid h-8 w-8 shrink-0 place-items-center rounded text-slate-300 transition active:bg-white/15';

function GridIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export interface MobileHeaderProps {
  onMenu: () => void;
  /** Space name or number; tapping it opens the space sheet (when provided). */
  spaceLabel: string;
  onSpace?: () => void;
  /** The selected tile's label, shown between the arrows. */
  tileLabel: string;
  onPrev: () => void;
  onNext: () => void;
  /** False when the space holds a single tile (or none): the arrows are inert. */
  canSwitch: boolean;
  /** Opens the overview sheet (when provided). */
  onOverview?: () => void;
  /** Rendered at the right edge, next to the overview button. */
  children?: React.ReactNode;
}

export function MobileHeader({
  onMenu,
  spaceLabel,
  onSpace,
  tileLabel,
  onPrev,
  onNext,
  canSwitch,
  onOverview,
  children,
}: MobileHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="apple-panel relative flex shrink-0 items-center gap-1 rounded-[6px] px-1 py-0.5">
      <button
        type="button"
        aria-label={t('mobile.menu')}
        aria-haspopup="dialog"
        onClick={onMenu}
        className={btn}
      >
        <MenuIcon />
      </button>

      {onSpace ? (
        <button
          type="button"
          onClick={onSpace}
          aria-label={t('mobile.spaces')}
          title={t('mobile.spaces')}
          className="h-8 shrink-0 rounded px-2 text-xs font-medium text-slate-300 transition active:bg-white/15"
        >
          {spaceLabel}
        </button>
      ) : (
        <span className="flex h-8 shrink-0 items-center px-2 text-xs font-medium text-white/45">
          {spaceLabel}
        </span>
      )}

      <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
        <button
          type="button"
          aria-label={t('mobile.previousTile')}
          onClick={onPrev}
          disabled={!canSwitch}
          className={cn(btn, 'disabled:opacity-30')}
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </button>
        <span className="min-w-0 truncate text-xs font-medium text-slate-100">{tileLabel}</span>
        <button
          type="button"
          aria-label={t('mobile.nextTile')}
          onClick={onNext}
          disabled={!canSwitch}
          className={cn(btn, 'disabled:opacity-30')}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>

      {onOverview && (
        <button
          type="button"
          aria-label={t('mobile.overview')}
          aria-haspopup="dialog"
          onClick={onOverview}
          className={btn}
        >
          <GridIcon />
        </button>
      )}
      {/* The bell is the desktop's shared button (h-7); match the bar's height so
          one control does not sit lower than its neighbours. */}
      {children && <span className="flex [&>button]:h-8 [&>button]:w-8">{children}</span>}
    </header>
  );
}
