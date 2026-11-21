import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  TONE_DOT,
  statusTone,
  terminalSubtitle,
  terminalTitle,
  type BaikalSpace,
  type BaikalTerminal,
} from '../../lib/baikal';

/**
 * The agents half of the left panel: every terminal that announced a status
 * over OSC 7501, most actionable first.
 *
 * This is the list you check when something needs you (Herdr's TUI puts the same
 * information in its sidebar). A row takes you straight to that terminal — its
 * space and its tab — because an agent you cannot get to is just a notification.
 */
export interface AgentListProps {
  agents: BaikalTerminal[];
  spaces: BaikalSpace[];
  activeTerminal?: string;
  onOpenAgent: (terminal: BaikalTerminal) => void;
}

export function AgentList({ agents, spaces, activeTerminal, onOpenAgent }: AgentListProps) {
  const { t } = useTranslation();

  const spaceName = (terminal: BaikalTerminal) =>
    spaces.find((space) => space.id === terminal.spaceId)?.name ?? t('baikal.unassigned');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-[10px] uppercase tracking-wider text-white/25">
        {t('baikal.agents')}
        <span className="text-white/20">{agents.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
        {agents.length === 0 ? (
          <div className="px-2 py-3 text-[10px] leading-relaxed text-white/25">
            {t('baikal.noAgents')}
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
