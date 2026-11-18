import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { getTilePlugin } from '../wm/tilePlugins';
import { getAppIconClasses, getAppIconLetter } from '../wm/appIcons';
import { FONT_MAX, FONT_MIN, clampFont } from '../store/fonts';
import { sessionHint, tileInfoLine } from '../lib/mobile';
import type { TileSessionMap } from '../wm/sessionState';
import { BottomSheet } from './BottomSheet';

/**
 * "All tiles" — the phone's stand-in for the tiling layout.
 *
 * One card per tile of the active space: the app badge, its label and one line
 * of information (the tile's path, else its session hint, else the plugin
 * description). Tapping a card switches to that tile; the ⋯ row expands in place
 * to the actions a phone otherwise has no way to reach, because the desktop's
 * hover toolbar cannot exist without hover: close, font size, and move to
 * another space.
 *
 * The cards are deliberately *not* live previews of the tiles — the real iframes
 * stay in the shell's pane layer, mounted, and only one is visible.
 */
export interface OverviewTile {
  paneId: string;
  tileType?: string;
  initialPath?: string;
  fontSize?: number;
}

export interface OverviewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiles: OverviewTile[];
  selected: string;
  sessionState: TileSessionMap;
  fontDefault: number;
  spaces: { name: string; tileCount: number }[];
  activeSpace: number;
  onSelect: (paneId: string) => void;
  onCloseTile: (paneId: string) => void;
  onFontSize: (paneId: string, size: number) => void;
  onMoveToSpace: (paneId: string, targetIndex: number) => void;
  onAddApp: () => void;
}

const actionBtn =
  'rounded px-2 py-1 text-xs font-medium text-slate-300 transition active:bg-white/15';

export function OverviewSheet({
  open,
  onOpenChange,
  tiles,
  selected,
  sessionState,
  fontDefault,
  spaces,
  activeSpace,
  onSelect,
  onCloseTile,
  onFontSize,
  onMoveToSpace,
  onAddApp,
}: OverviewSheetProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setExpanded(null);
        onOpenChange(next);
      }}
      title={t('mobile.overviewTitle')}
      footer={
        <button
          type="button"
          onClick={onAddApp}
          className="glass-btn w-full rounded-[6px] px-3 py-2 text-sm font-medium text-slate-200 transition active:bg-white/15"
        >
          + {t('wm.openApp')}
        </button>
      }
    >
      {tiles.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-white/40">{t('mobile.overviewEmpty')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 pb-1">
          {tiles.map((tile) => {
            const plugin = tile.tileType ? getTilePlugin(tile.tileType) : undefined;
            const id = tile.tileType ?? 'empty';
            const label = plugin?.label ?? t('plugin.empty');
            const info = tileInfoLine({
              initialPath: tile.initialPath,
              sessionHint: sessionHint(sessionState[tile.paneId]?.state),
              description: plugin?.description,
            });
            const active = tile.paneId === selected;
            const open = expanded === tile.paneId;
            const fontSize = tile.fontSize ?? fontDefault;

            return (
              <div
                key={tile.paneId}
                className={cn(
                  'rounded-[8px] border bg-black/25 p-2 transition',
                  active ? 'border-sky-400/50' : 'border-white/10',
                )}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(tile.paneId)}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    <span
                      className={cn(
                        'grid h-7 w-7 shrink-0 place-items-center rounded-[6px] text-xs font-semibold',
                        getAppIconClasses(id, tile.tileType),
                      )}
                    >
                      {getAppIconLetter(id, label, tile.tileType)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-100">
                        {label}
                      </span>
                      {info && (
                        <span className="block truncate text-[10px] text-white/40">{info}</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('mobile.tileActions')}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : tile.paneId)}
                    className="shrink-0 rounded px-1 text-white/45 transition active:bg-white/15"
                  >
                    ⋯
                  </button>
                </div>

                {open && (
                  <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] uppercase tracking-wider text-white/35">
                        {t('mobile.fontSize')}
                      </span>
                      <span className="flex items-center gap-0.5">
                        <button
                          type="button"
                          disabled={fontSize <= FONT_MIN}
                          onClick={() => onFontSize(tile.paneId, clampFont(fontSize - 1))}
                          className={cn(actionBtn, 'disabled:opacity-30')}
                        >
                          A−
                        </button>
                        <span className="w-6 text-center text-[10px] text-white/50">
                          {fontSize}
                        </span>
                        <button
                          type="button"
                          disabled={fontSize >= FONT_MAX}
                          onClick={() => onFontSize(tile.paneId, clampFont(fontSize + 1))}
                          className={cn(actionBtn, 'disabled:opacity-30')}
                        >
                          A+
                        </button>
                      </span>
                    </div>

                    {spaces.length > 1 && (
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] uppercase tracking-wider text-white/35">
                          {t('mobile.moveToSpace')}
                        </span>
                        <span className="flex flex-wrap justify-end gap-0.5">
                          {spaces.map((space, index) =>
                            index === activeSpace ? null : (
                              <button
                                key={space.name + index}
                                type="button"
                                onClick={() => onMoveToSpace(tile.paneId, index)}
                                className={actionBtn}
                              >
                                {index + 1}
                              </button>
                            ),
                          )}
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => onCloseTile(tile.paneId)}
                      className="mt-0.5 self-start rounded px-2 py-1 text-xs font-medium text-red-300/90 transition active:bg-red-500/20"
                    >
                      {t('wm.closeTile')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </BottomSheet>
  );
}
