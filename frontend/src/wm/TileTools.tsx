import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TilePlugin } from './tilePlugins';
import { CloseIcon, ExitFocusIcon, FocusIcon, GripIcon, MoveToSpaceIcon, SwapIcon } from './icons';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300';

const closeBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-rose-500/20 hover:text-rose-300';

interface SpaceInfo {
  index: number;
  name: string;
  label: string;
  tileCount: number;
  tileLabels: string[];
}

interface TileToolsProps {
  paneId: string;
  fontSize: number;
  fontDefault: number;
  setFontSize: (size: number) => void;
  plugin?: TilePlugin;
  startDrag: (id: string, e: ReactPointerEvent) => void;
  closeTile: (id: string) => void;
  startSwap: (id: string) => void;
  isFocused: boolean;
  onToggleFocus: (id: string) => void;
  spaces: SpaceInfo[];
  activeSpaceIndex: number;
  onMoveToSpace: (paneId: string, targetIndex: number) => void;
}

/**
 * Per-tile hover toolbar, revealed only while the cursor is near the
 * top-right corner. Composes:
 *   1. Type-specific plugin buttons (e.g. font size for term)
 *   2. Shared drag grip
 *   3. Shared close button
 */
export function TileTools({
  paneId,
  fontSize,
  fontDefault,
  setFontSize,
  plugin,
  startDrag,
  closeTile,
  startSwap,
  isFocused,
  onToggleFocus,
  spaces,
  activeSpaceIndex,
  onMoveToSpace,
}: TileToolsProps) {
  const { t } = useTranslation();
  const [showSpaceDialog, setShowSpaceDialog] = useState(false);
  const pluginToolbar = plugin?.renderToolbar?.({
    paneId,
    fontSize,
    fontDefault,
    setFontSize,
    closeTile,
    startSwap,
  });

  // Filter out focus space, show all user spaces (current one disabled).
  const availableSpaces = spaces.filter((s) => s.name !== '__focus__');

  return (
    <div className="group/corner absolute right-0 top-0 z-10 h-12 w-56">
      <div
        className="pointer-events-none absolute right-1.5 top-1.5 flex gap-0.5 rounded-[6px] menu-glass p-0.5 opacity-0 transition-opacity duration-150 group-hover/corner:pointer-events-auto group-hover/corner:opacity-100 motion-reduce:transition-none"
        role="toolbar"
        aria-label={`Tile tools ${paneId}`}
      >
        {pluginToolbar}
        {/* Shared drag-to-layout grip */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onPointerDown={(e) => startDrag(paneId, e)}
          aria-label={t('wm.dragTile')}
          title={t('wm.dragTileHint')}
          className={`${toolBtn} cursor-grab touch-none active:cursor-grabbing`}
        >
          <GripIcon />
        </button>
        {/* Shared per-tile swap */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onClick={() => startSwap(paneId)}
          aria-label={t('wm.swapTile')}
          title={t('wm.swapHint') + ' (Alt+S)'}
          className={toolBtn}
        >
          <SwapIcon />
        </button>
        {/* Focus / exit focus */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onClick={() => onToggleFocus(paneId)}
          aria-label={isFocused ? t('wm.exitFocus') : t('wm.focusTile')}
          title={isFocused ? t('wm.exitFocus') + ' (Alt+F)' : t('wm.focusTile') + ' (Alt+F)'}
          className={toolBtn}
        >
          {isFocused ? <ExitFocusIcon /> : <FocusIcon />}
        </button>
        {/* Move to space */}
        {availableSpaces.length > 0 && (
          <>
            <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
            <button
              type="button"
              onClick={() => setShowSpaceDialog(true)}
              aria-label={t('wm.moveToSpaceMenu')}
              title={t('wm.moveToSpaceMenu')}
              className={toolBtn}
            >
              <MoveToSpaceIcon />
            </button>
          </>
        )}
        {/* Shared per-tile close */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onClick={() => closeTile(paneId)}
          aria-label={t('wm.closeTile')}
          title={t('wm.closeTileHint')}
          className={closeBtn}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Move to space dialog */}
      {showSpaceDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setShowSpaceDialog(false);
          }}
        >
          <DialogContent
            className="w-[min(92vw,24rem)]"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowSpaceDialog(false);
            }}
          >
            <DialogTitle>{t('wm.moveToSpaceDialog')}</DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">{t('wm.moveToSpaceDialogDesc')}</p>
            <div className="mt-3 flex flex-col gap-2">
              {availableSpaces.map((s) => {
                const isCurrent = s.index === activeSpaceIndex;
                return (
                  <button
                    key={s.index}
                    type="button"
                    disabled={isCurrent}
                    className={`flex w-full flex-col items-start gap-1 rounded-[6px] border bg-black/20 p-3 text-left transition ${
                      isCurrent
                        ? 'cursor-not-allowed border-white/5 opacity-40'
                        : 'border-white/10 hover:border-white/20 hover:bg-white/5'
                    }`}
                    onClick={() => {
                      if (!isCurrent) {
                        onMoveToSpace(paneId, s.index);
                        setShowSpaceDialog(false);
                      }
                    }}
                  >
                    <span className="text-xs font-semibold text-white/80">
                      {t('wm.spaceLabel', { number: s.label })}
                      {isCurrent ? ' (' + t('wm.currentSpace') + ')' : ''}
                    </span>
                    {s.tileLabels.length > 0 ? (
                      <span className="text-[11px] text-white/40">{s.tileLabels.join(' · ')}</span>
                    ) : (
                      <span className="text-[11px] text-white/30">{t('wm.emptySpace')}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
