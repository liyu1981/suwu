import { useTranslation } from 'react-i18next';
import type { CodeTab } from './useCodeExplorer';

interface TabBarProps {
  tabs: CodeTab[];
  activeId: string | null;
  dirty: Record<string, boolean>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpen: () => void;
}

const iconBtn =
  'grid h-6 w-6 shrink-0 place-items-center rounded text-white/50 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent';

/** Tab strip with the new-file button on the left. */
export function TabBar({ tabs, activeId, dirty, onSelect, onClose, onOpen }: TabBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/5 bg-black/20 pr-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('codeExplorer.openFile')}
        title={t('codeExplorer.openFile')}
        className={`${iconBtn} ml-1`}
      >
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 scrollbar-thin">
        {tabs.map((tab) => {
          const name = tab.path.split('/').pop() ?? tab.path;
          const isActive = tab.id === activeId;
          const isDirty = dirty[tab.id];
          return (
            <div
              key={tab.id}
              className={`group flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs tracking-[-0.01em] transition ${
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-white/50 hover:bg-white/5 hover:text-white/80'
              }`}
              title={tab.path}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="max-w-[12rem] truncate"
              >
                {name}
              </button>
              {isDirty && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  aria-label={t('codeExplorer.unsaved')}
                />
              )}
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                aria-label={t('codeExplorer.closeTab')}
                className="grid h-4 w-4 shrink-0 place-items-center rounded text-white/40 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-white"
              >
                <svg
                  className="h-2.5 w-2.5"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
