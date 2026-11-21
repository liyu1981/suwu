import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  TONE_DOT,
  groupUnassigned,
  sortSpaces,
  spaceColour,
  spaceInitial,
  statusTone,
  terminalSubtitle,
  terminalTitle,
  type BaikalSpace,
  type BaikalTerminal,
} from '../../lib/baikal';
import { SpaceMenu } from './SpaceMenu';
import { TerminalMenu } from './TerminalMenu';

/**
 * The left panel: spaces, and the terminals that live in them.
 *
 * Clicking a space selects it — the tab strip on the right shows that space's
 * terminals only, the way Herdr's TUI switches its tabs with the workspace.
 * Collapsing the whole panel is the parent's business (`useSidebarCollapse`);
 * collapsing one space is local state, because a phone-sized list is mostly
 * about hiding groups you are not using right now.
 */
export interface SpaceListProps {
  spaces: BaikalSpace[];
  /** Terminals that announced a status (OSC 7501), most actionable first. */
  agents: BaikalTerminal[];
  onOpenAgent: (terminal: BaikalTerminal) => void;
  unassigned: BaikalTerminal[];
  activeSpaceId: string;
  activeTerminal?: string;
  onSelectSpace: (space: BaikalSpace) => void;
  onOpen: (terminal: BaikalTerminal, observe: boolean) => void;
  onNewSpace: () => void;
  creating?: boolean;
  onAssign: (terminal: BaikalTerminal, spaceId: string) => void;
  onKill: (terminal: BaikalTerminal) => void;
  onRemove: (terminal: BaikalTerminal) => void;
  onPeek: (terminal: BaikalTerminal) => void;
  onRename: (space: BaikalSpace, name: string) => void;
  onColour: (space: BaikalSpace, colour: string) => void;
  onForget: (space: BaikalSpace) => void;
}

export function SpaceList({
  spaces,
  agents,
  onOpenAgent,
  unassigned,
  activeSpaceId,
  activeTerminal,
  onSelectSpace,
  onOpen,
  onNewSpace,
  creating,
  onAssign,
  onKill,
  onRemove,
  onPeek,
  onRename,
  onColour,
  onForget,
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

    const spaceGroups = sortSpaces(spaces)
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
      <div
        key={terminal.address}
        className={cn(
          'flex w-full items-center gap-1 rounded-[6px] pr-0.5 transition',
          activeTerminal === terminal.address ? 'bg-white/[0.10]' : 'hover:bg-white/[0.05]',
        )}
      >
        <button
          type="button"
          onClick={() => onOpen(terminal, false)}
          title={`${terminalTitle(terminal)} — ${terminalSubtitle(terminal)}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1.5 py-1 text-left"
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
        <TerminalMenu
          terminal={terminal}
          spaces={spaces}
          onOpen={onOpen}
          onAssign={onAssign}
          onKill={onKill}
          onRemove={onRemove}
          onPeek={onPeek}
        />
      </div>
    );
  };

  const spaceName = (terminal: BaikalTerminal) =>
    spaces.find((space) => space.id === terminal.spaceId)?.name ?? t('baikal.unassigned');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Same height and paddings as the tab strip beside it, so the two "+"
          buttons read as one row of chrome rather than two stray controls. */}
      <div className="flex h-9 shrink-0 items-center gap-1 px-1.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('baikal.filter')}
          aria-label={t('baikal.filter')}
          className="h-7 min-w-0 flex-1 rounded-[6px] border border-white/10 bg-black/30 px-2 text-[11px] text-slate-100 placeholder:text-white/25 focus-visible:border-sky-400/50 focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={onNewSpace}
          disabled={creating}
          aria-label={t('baikal.newSpace')}
          title={t('baikal.newSpaceHint')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px] border border-white/10 bg-white/[0.04] text-sm leading-none text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
        >
          +
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
        {/* Agents first: this is the list you check when something needs you,
            and a row takes you straight to that terminal's space and tab. */}
        {agents.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] uppercase tracking-wider text-white/25">
              {t('baikal.agents')}
              <span className="text-white/20">{agents.length}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {agents.map((terminal) => {
                const tone = statusTone(terminal.status);
                return (
                  <button
                    key={`agent-${terminal.address}`}
                    type="button"
                    onClick={() => onOpenAgent(terminal)}
                    title={`${terminalTitle(terminal)} — ${terminalSubtitle(terminal)}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left transition',
                      activeTerminal === terminal.address
                        ? 'bg-white/[0.10]'
                        : 'hover:bg-white/[0.05]',
                    )}
                  >
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-white/80">
                        {terminalTitle(terminal)}
                      </span>
                      <span className="block truncate text-[10px] text-white/35">
                        {terminal.status?.state}
                        {terminal.status?.msg ? ` · ${terminal.status.msg}` : ''}
                      </span>
                    </span>
                    <span className="max-w-16 shrink-0 truncate text-[9px] text-white/25">
                      {spaceName(terminal)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mx-1 mt-2 border-t border-white/[0.06]" />
          </div>
        )}

        {groups.spaceGroups.map(({ space, terminals }) => {
          const colour = spaceColour(space.colour);
          const isCollapsed = collapsed.has(space.id);
          const isActive = space.id === activeSpaceId;
          return (
            <div key={space.id} className="group relative mb-0.5">
              <div
                className={cn(
                  'flex items-center gap-1 rounded-[6px] pr-0.5 transition',
                  isActive ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]',
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(space.id)}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? t('baikal.expandSpace') : t('baikal.collapseSpace')}
                  className="grid h-5 w-4 shrink-0 place-items-center text-[10px] text-white/30 transition hover:text-white/70"
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <button
                  type="button"
                  onClick={() => onSelectSpace(space)}
                  title={space.identityCwd}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                >
                  <span
                    className={cn(
                      'grid h-4 w-4 shrink-0 place-items-center rounded-[4px] text-[9px] font-semibold text-black/70',
                      colour.dot,
                    )}
                  >
                    {spaceInitial(space.name)}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[11px] font-semibold',
                      isActive ? 'text-white' : 'text-white/75',
                    )}
                  >
                    {space.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-white/25">{terminals.length}</span>
                </button>
                <SpaceMenu
                  space={space}
                  onRename={onRename}
                  onColour={onColour}
                  onForget={onForget}
                />
              </div>
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
    </div>
  );
}
