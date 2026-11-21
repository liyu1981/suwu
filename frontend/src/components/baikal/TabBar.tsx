import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { statusTone, TONE_DOT, type BaikalTab, type BaikalTerminal } from '../../lib/baikal';

/**
 * The right panel's tab strip: one tab per attached terminal.
 *
 * Closing a tab detaches the viewer — the program keeps running, which is the
 * point of herdr and a thing users must be able to trust, so the close button is
 * a plain × with no confirmation.
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
    <div className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-white/[0.06] px-1.5 scrollbar-thin">
      {tabs.map((tab) => {
        const terminal = byAddress.get(tab.terminal);
        const tone = statusTone(terminal?.status);
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={cn(
              'group flex h-7 shrink-0 items-center gap-1.5 rounded-t-[6px] border border-b-0 px-2 text-[11px] transition',
              isActive
                ? 'border-white/[0.10] bg-white/[0.08] text-white'
                : 'border-transparent text-white/45 hover:bg-white/[0.04] hover:text-white/70',
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
                <span className="shrink-0 text-[9px] text-sky-300">{t('baikal.observeShort')}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              aria-label={t('baikal.detach')}
              title={t('baikal.detach')}
              className="shrink-0 rounded px-1 text-white/30 transition hover:bg-white/10 hover:text-white/80"
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
        className="grid h-7 w-7 shrink-0 place-items-center rounded-t-[6px] text-sm leading-none text-white/40 transition hover:bg-white/10 hover:text-white/80 disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
