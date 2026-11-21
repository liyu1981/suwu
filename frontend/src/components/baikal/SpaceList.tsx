import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  TONE_DOT,
  groupUnassigned,
  spaceColour,
  statusTone,
  terminalSubtitle,
  terminalTitle,
  type BaikalSpace,
  type BaikalTerminal,
} from '../../lib/baikal';

/**
 * The left panel: spaces, and the terminals that live in them.
 *
 * Collapsing the whole panel is the parent's business (`useSidebarCollapse`,
 * shared with the REST helper and DB browser); collapsing one space is local
 * state, because a phone-sized list is mostly about hiding groups you are not
 * using right now.
 */
export interface SpaceListProps {
  spaces: BaikalSpace[];
  unassigned: BaikalTerminal[];
  active?: string;
  onOpen: (terminal: BaikalTerminal) => void;
  onNewShell: () => void;
  creating?: boolean;
}

export function SpaceList({
  spaces,
  unassigned,
  active,
  onOpen,
  onNewShell,
  creating,
}: SpaceListProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (terminal: BaikalTerminal) =>
      !needle ||
      terminalTitle(terminal).toLowerCase().includes(needle) ||
      terminalSubtitle(terminal).toLowerCase().includes(needle) ||
      terminal.address.toLowerCase().includes(needle) ||
      (terminal.cwd ?? '').toLowerCase().includes(needle);

    const spaceGroups = spaces
      .map((space) => ({ space, terminals: space.terminals.filter(matches) }))
      .filter((group) => group.terminals.length > 0);
    const loose = groupUnassigned(unassigned.filter(matches));
    return { spaceGroups, loose };
  }, [spaces, unassigned, filter]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const terminalRow = (terminal: BaikalTerminal) => {
    const tone = statusTone(terminal.status);
    return (
      <button
        key={terminal.address}
        type="button"
        onClick={() => onOpen(terminal)}
        title={`${terminalTitle(terminal)} — ${terminalSubtitle(terminal)}`}
        className={cn(
          'flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left transition',
          active === terminal.address ? 'bg-white/[0.10]' : 'hover:bg-white/[0.05]',
        )}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] text-white/80">
            {terminalTitle(terminal)}
          </span>
          <span className="block truncate text-[10px] text-white/35">
            {terminalSubtitle(terminal)}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-1.5 pb-1">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('baikal.filter')}
          aria-label={t('baikal.filter')}
          className="h-7 w-full rounded-[6px] border border-white/10 bg-black/30 px-2 text-[11px] text-slate-100 placeholder:text-white/25 focus-visible:border-sky-400/50 focus-visible:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
        {groups.spaceGroups.map(({ space, terminals }) => {
          const { dot } = spaceColour(space.colour);
          const isCollapsed = collapsed.has(space.id);
          return (
            <div key={space.id} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(space.id)}
                aria-expanded={!isCollapsed}
                title={space.identityCwd}
                className="flex w-full items-center gap-1.5 rounded-[6px] px-1 py-1 text-left transition hover:bg-white/[0.05]"
              >
                <span className="w-3 shrink-0 text-[10px] text-white/30">
                  {isCollapsed ? '▸' : '▾'}
                </span>
                <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/75">
                  {space.name}
                </span>
                <span className="shrink-0 text-[10px] text-white/25">{terminals.length}</span>
              </button>
              {!isCollapsed && (
                <div className="mt-0.5 flex flex-col gap-0.5 pl-4">
                  {terminals.map(terminalRow)}
                </div>
              )}
            </div>
          );
        })}

        {groups.loose.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] uppercase tracking-wider text-white/25">
              {t('baikal.unassigned')}
            </div>
            {groups.loose.map((group) => (
              <div key={group.cwd} className="mb-1">
                <div className="truncate px-1 pl-4 text-[10px] text-white/35" title={group.cwd}>
                  {group.name}
                </div>
                <div className="mt-0.5 flex flex-col gap-0.5 pl-4">
                  {group.terminals.map(terminalRow)}
                </div>
              </div>
            ))}
          </div>
        )}

        {groups.spaceGroups.length === 0 && groups.loose.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] text-white/30">
            {filter ? t('baikal.noMatches') : t('baikal.empty')}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] p-1.5">
        <button
          type="button"
          onClick={onNewShell}
          disabled={creating}
          className="w-full rounded-[6px] border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
        >
          {creating ? t('baikal.creating') : `+ ${t('baikal.newShell')}`}
        </button>
      </div>
    </div>
  );
}
