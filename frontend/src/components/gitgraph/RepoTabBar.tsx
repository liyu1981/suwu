/**
 * RepoTabBar - the *outer* tab strip of the Git Graph tile: one tab per
 * repository. The inner strip of comparisons inside a repo is `ComparisonTabs`.
 *
 * House rules: the bar scrolls horizontally rather than wrapping, and its right
 * end holds only the `+` affordance — the WM's hover toolbar owns a tile's
 * top-right corner (see the tile-plugin skill §11).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { tabLabels, type RepoTab } from './repoTabs';

export function RepoTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onNew,
}: {
  tabs: RepoTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const labels = tabLabels(tabs.map((tab) => tab.repoPath));

  useEffect(() => {
    ref.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    setMenu({ id, x: e.clientX / zoom, y: e.clientY / zoom });
  };

  const menuItems = (id: string): ContextMenuItem[][] => [
    [
      {
        label: t('gitTabs.close'),
        onClick: () => onClose(id),
        disabled: tabs.length <= 1,
      },
      { label: t('gitTabs.closeOthers'), onClick: () => onCloseOthers(id) },
      { label: t('gitTabs.closeAll'), onClick: () => onCloseAll(), danger: true },
    ],
  ];

  return (
    <div className="flex shrink-0 items-stretch border-b border-white/10 glass-control">
      <div
        ref={ref}
        role="tablist"
        aria-label={t('gitTabs.tabs')}
        className="flex min-w-0 flex-1 overflow-x-auto scrollbar-thin"
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const index = tabs.findIndex((tab) => tab.id === activeId);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? tabs.length - 1
                : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          onSelect(tabs[next].id);
          ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`group flex shrink-0 items-center border-r border-white/10 ${selected ? 'bg-white/10 text-white' : 'text-white/55'}`}
              onContextMenu={(e) => openMenu(e, tab.id)}
            >
              <button
                type="button"
                role="tab"
                id={`repo-tab-${index}`}
                aria-controls="repo-panel"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="max-w-40 truncate px-3 py-2 text-xs outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
                title={tab.repoPath ?? t('gitTabs.noRepo')}
                aria-label={
                  tab.repoPath
                    ? t('gitTabs.select', { index: index + 1, label: tab.repoPath })
                    : t('gitTabs.selectEmpty', { index: index + 1 })
                }
                onClick={() => onSelect(tab.id)}
                // Middle click closes, like every other tab strip.
                onMouseDown={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  if (tabs.length > 1) onClose(tab.id);
                }}
              >
                {labels[index] || t('gitTabs.noRepo')}
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  aria-label={t('gitTabs.closeTab', { label: labels[index] || tab.id })}
                  title={t('gitTabs.closeTab', { label: labels[index] || tab.id })}
                  className={`mr-1 rounded px-1.5 text-xs transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400 ${selected ? 'opacity-80' : 'opacity-0 group-hover:opacity-80 focus-visible:opacity-80'}`}
                  onClick={() => onClose(tab.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        aria-label={t('gitTabs.new')}
        title={t('gitTabs.new')}
        className="grid w-8 shrink-0 place-items-center border-l border-white/10 text-white/50 transition hover:bg-white/10 hover:text-white"
      >
        +
      </button>
      {menu && (
        <ContextMenu
          items={menuItems(menu.id)}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
