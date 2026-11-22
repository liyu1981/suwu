import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { statusTone, TONE_DOT, type BaikalTab, type BaikalTerminal } from '../../lib/baikal';

/**
 * The right panel's tab strip: one pill per open terminal.
 *
 * A pill is the whole tab: name, status dot and close button in one rounded
 * shape, because the strip is a list of *terminals the user opened*, not a stack
 * of document folders — the content under it is one terminal at a time, mounted
 * only while its pill is selected. Pills also read correctly when the strip
 * scrolls, which a folder tab (joined to the panel edge) does not.
 *
 * Closing a tab ends the program — the tile's `×` is the deliberate "stop this",
 * so it keeps the same plain × with no confirmation.
 */
export interface TabBarProps {
  tabs: BaikalTab[];
  activeId: string;
  terminals: BaikalTerminal[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewShell: () => void;
  creating?: boolean;
}

export function TabBar({
  tabs,
  activeId,
  terminals,
  onSelect,
  onClose,
  onNewShell,
  creating,
}: TabBarProps) {
  const { t } = useTranslation();
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-1.5 scrollbar-thin">
      {tabs.map((tab) => {
        const terminal = byAddress.get(tab.terminal);
        const tone = statusTone(terminal?.status);
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={cn(
              'group flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs transition',
              isActive
                ? 'border-white/[0.20] bg-white/[0.13] text-white'
                : 'border-white/[0.07] bg-white/[0.04] text-white/50 hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white/80',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
              title={terminal ? `${tab.terminal} — ${terminal.cwd}` : tab.terminal}
              className="flex min-w-0 max-w-40 items-center gap-1.5"
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
              <span className="truncate">{tab.title}</span>
              {tab.observe && (
                <span className="shrink-0 text-[10px] text-sky-300">
                  {t('baikal.observeShort')}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              aria-label={t('baikal.detach')}
              title={t('baikal.detachHint')}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-white/30 transition group-hover:text-white/50 hover:bg-white/15 hover:text-white/85"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onNewShell}
        disabled={creating}
        aria-label={t('baikal.newShell')}
        title={t('baikal.newShell')}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-dashed border-white/[0.14] text-sm leading-none text-white/45 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-white/85 disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
