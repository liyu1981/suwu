import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '@/lib/utils';
import { SPACE_COLOURS, spaceColour, type BaikalSpace } from '../../lib/baikal';

/**
 * Space actions: rename (pins the name; clearing it goes back to the directory),
 * change the accent colour, forget the space's metadata.
 *
 * Forgetting never touches terminals or their programs — a space with no live
 * terminal simply stops being listed, and its shells stay where they are.
 */
export interface SpaceMenuProps {
  space: BaikalSpace;
  onRename: (space: BaikalSpace, name: string) => void;
  onColour: (space: BaikalSpace, colour: string) => void;
  onForget: (space: BaikalSpace) => void;
}

export function SpaceMenu({ space, onRename, onColour, onForget }: SpaceMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(space.customName ?? '');
  const { dot } = spaceColour(space.colour);

  useEffect(() => {
    if (open) setName(space.customName ?? '');
  }, [open, space.customName]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('baikal.spaceActions')}
          title={t('baikal.spaceActions')}
          onClick={(event) => event.stopPropagation()}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/25 transition hover:bg-white/10 hover:text-white/80"
        >
          ⋯
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-60 p-2">
        <label
          className="block text-xs font-semibold uppercase tracking-wider text-white/30"
          htmlFor={`space-name-${space.id}`}
        >
          {t('baikal.rename')}
        </label>
        <form
          className="mt-1 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(space, name.trim());
            setOpen(false);
          }}
        >
          <input
            id={`space-name-${space.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={space.identityCwd}
            className="h-7 min-w-0 flex-1 rounded-[6px] border border-white/10 bg-black/30 px-2 text-xs text-white/85 placeholder:text-white/25 focus-visible:border-sky-400/50 focus-visible:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-[6px] bg-sky-600/80 px-2 text-xs font-medium text-white transition hover:bg-sky-500"
          >
            {t('baikal.save')}
          </button>
        </form>
        <p className="mt-1 text-[11px] leading-relaxed text-white/30">{t('baikal.renameHint')}</p>

        <div className="mt-2 text-xs font-semibold uppercase tracking-wider text-white/30">
          {t('baikal.colour')}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {Object.entries(SPACE_COLOURS).map(([key, value]) => (
            <button
              key={key}
              type="button"
              aria-label={key}
              aria-pressed={space.colour === key}
              onClick={() => onColour(space, key)}
              className={cn(
                'h-4 w-4 rounded-full transition',
                value.dot,
                space.colour === key
                  ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-transparent'
                  : 'opacity-70 hover:opacity-100',
              )}
            />
          ))}
        </div>

        <div className="my-2 border-t border-white/[0.06]" />
        <button
          type="button"
          onClick={() => {
            onForget(space);
            setOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-red-300 transition hover:bg-red-500/15"
        >
          <span className={cn('h-2 w-2 rounded-full', dot)} />
          {t('baikal.forgetSpace')}
        </button>
        <p className="mt-1 px-2 text-[11px] leading-relaxed text-white/30">
          {t('baikal.forgetHint')}
        </p>
      </PopoverContent>
    </Popover>
  );
}
