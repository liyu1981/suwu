import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { BottomSheet } from './BottomSheet';

/**
 * The space switcher, replacing the desktop header's row of numbered space
 * buttons (which does not fit a phone).
 *
 * A row per space with its tile count, the active one marked, plus add/remove at
 * the bottom. Removing is disabled while a single space remains — the model
 * always keeps one.
 */
export interface SpaceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: { name: string; tileCount: number }[];
  activeSpace: number;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function SpaceSheet({
  open,
  onOpenChange,
  spaces,
  activeSpace,
  onSelect,
  onAdd,
  onRemove,
}: SpaceSheetProps) {
  const { t } = useTranslation();

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('mobile.spacesTitle')}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAdd}
            className="glass-btn flex-1 rounded-[6px] px-3 py-2 text-sm font-medium text-slate-200 transition active:bg-white/15"
          >
            + {t('mobile.addSpace')}
          </button>
          <button
            type="button"
            disabled={spaces.length <= 1}
            onClick={() => onRemove(activeSpace)}
            className="glass-btn rounded-[6px] px-3 py-2 text-sm font-medium text-red-300/90 transition active:bg-red-500/20 disabled:opacity-30"
          >
            {t('mobile.removeSpace')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-1 pb-1">
        {spaces.map((space, index) => {
          const active = index === activeSpace;
          return (
            <button
              key={space.name + index}
              type="button"
              onClick={() => onSelect(index)}
              className={cn(
                'flex w-full items-center gap-2 rounded-[6px] border px-3 py-2 text-left transition active:bg-white/15',
                active ? 'border-sky-400/50 bg-white/5' : 'border-white/10',
              )}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-white/10 text-[11px] font-semibold text-slate-200">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-100">{space.name}</span>
                <span className="block text-[10px] text-white/40">
                  {t('mobile.tileCount', { count: space.tileCount })}
                </span>
              </span>
              {active && (
                <span className="shrink-0 text-[11px] text-sky-300">{t('mobile.current')}</span>
              )}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}
