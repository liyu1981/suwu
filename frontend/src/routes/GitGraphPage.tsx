/**
 * GitGraphPage - full-space git graph tile for the tiling window manager.
 *
 * The tile is a tab host: every tab is an independent git graph for one
 * repository (`RepoGraphPanel`) carrying the whole feature set, and the tab
 * list itself is the tile's persisted session state (`useRepoTabs`).
 *
 * Row 1: toolbar (Git Graph label + refresh + auto-refresh) — glass material
 * Row 2: repository tab bar
 * Row 3: per-tab comparison strip, repo path bar and content
 *
 * See docs/GIT_GRAPH_TABS_PLAN.md for the state model and restore rules.
 */

import { useCallback, useEffect, useState } from 'react';
import { CommonTileContainer } from '../components/CommonTileContainer';
import { gitGraphZoomAtom } from '../store/zoom';
import { setPageTransparent } from '../lib/constants';
import { RefreshIcon } from '../components/icons';
import {
  useAutoRefreshDropdown,
  AutoRefreshDropdown,
  AutoRefreshTrigger,
} from '../components/AutoRefreshDropdown';
import { RepoPicker } from '../components/gitgraph/RepoPicker';
import { RepoTabBar } from '../components/gitgraph/RepoTabBar';
import { RepoGraphPanel } from '../components/gitgraph/RepoGraphPanel';
import { useRepoTabs } from '../components/gitgraph/useRepoTabs';
import type { RepoTab } from '../components/gitgraph/repoTabs';
import { useTranslation } from 'react-i18next';

export default function GitGraphPage() {
  return (
    <CommonTileContainer zoomAtom={gitGraphZoomAtom} noPadding>
      <GitGraphContent />
    </CommonTileContainer>
  );
}

function GitGraphContent() {
  const { t } = useTranslation();
  const dropdown = useAutoRefreshDropdown();
  const [refreshToken, setRefreshToken] = useState(0);
  const {
    tabs,
    activeTab,
    activeTabId,
    activeIndex,
    select,
    addTab,
    close,
    closeOthers,
    closeAll,
    openRepo,
    patch,
  } = useRepoTabs(new URLSearchParams(window.location.search).get('path'));

  useEffect(() => {
    setPageTransparent();
  }, []);

  const autoRefresh = activeTab?.autoRefreshMs ?? 0;
  // Stable identity so the panel's callbacks do not churn on every render.
  const patchActive = useCallback(
    (next: Partial<RepoTab>) => {
      if (activeTab) patch(activeTab.id, next);
    },
    [activeTab, patch],
  );
  const setAutoRefresh = useCallback(
    (ms: number) => {
      patchActive({ autoRefreshMs: ms });
      dropdown.close();
    },
    [patchActive, dropdown],
  );

  // Toolbar button in the parent window: open a tab in this tile.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'gitgraph-new-tab') addTab();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [addTab]);

  // Tile-level tab shortcuts. WM shortcuts are all Alt+<letter> (wm/shortcuts),
  // so the digit and bracket combinations below never collide with them; the
  // Ctrl/Cmd variants are accepted too for browsers that let them through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey) return;
      const accel = e.ctrlKey || e.metaKey || e.altKey;
      if (!accel || tabs.length === 0) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      if (/^[1-9]$/.test(e.key)) {
        const next = tabs[Number(e.key) - 1];
        if (next) {
          e.preventDefault();
          select(next.id);
        }
        return;
      }
      switch (e.key) {
        case '[':
        case '{':
          e.preventDefault();
          select(tabs[(index - 1 + tabs.length) % tabs.length].id);
          break;
        case ']':
        case '}':
          e.preventDefault();
          select(tabs[(index + 1) % tabs.length].id);
          break;
        case 't':
        case 'T':
          e.preventDefault();
          addTab();
          break;
        case 'w':
        case 'W':
          if (index >= 0 && tabs.length > 1) {
            e.preventDefault();
            close(activeTabId);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeTabId, select, addTab, close]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Row 1 — toolbar (file viewer style) */}
      <div className="flex h-8 shrink-0 items-center gap-1 rounded-t-[6px] border-b border-white/10 px-3 py-1.5 glass-control">
        <button
          type="button"
          onClick={() => setRefreshToken((n) => n + 1)}
          disabled={!activeTab?.repoPath}
          className={`grid h-5 w-5 place-items-center rounded transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent ${
            autoRefresh > 0
              ? 'text-green-400'
              : 'text-white/50 hover:text-white/70 disabled:text-white/50'
          }`}
          title="Refresh"
        >
          <RefreshIcon />
        </button>
        <AutoRefreshTrigger
          btnRef={dropdown.btnRef}
          isActive={autoRefresh > 0}
          onClick={dropdown.toggle}
        />
        <span className="text-base font-semibold tracking-wide text-white/60">Git Graph</span>
      </div>

      {/* Auto-refresh dropdown */}
      {dropdown.showDropdown && (
        <AutoRefreshDropdown
          value={autoRefresh}
          onChange={setAutoRefresh}
          dropdownRef={dropdown.dropdownRef}
          dropdownPos={dropdown.dropdownPos}
        />
      )}

      {tabs.length > 0 && (
        <RepoTabBar
          tabs={tabs}
          activeId={activeTabId}
          onSelect={select}
          onClose={close}
          onCloseOthers={closeOthers}
          onCloseAll={closeAll}
          onNew={addTab}
        />
      )}

      <div
        id="repo-panel"
        role={tabs.length > 0 ? 'tabpanel' : undefined}
        aria-labelledby={activeIndex >= 0 ? `repo-tab-${activeIndex}` : undefined}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {activeTab ? (
          // Keyed by tab: switching repos remounts the panel, which resets its
          // fetches, scroll restore and transient menus.
          <RepoGraphPanel
            key={activeTab.id}
            tab={activeTab}
            refreshToken={refreshToken}
            onPatch={patchActive}
            onSelectRepo={(path) => openRepo(path, activeTab.id)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin rounded-b-[6px] border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 p-4">
            <RepoPicker onSelect={(path) => openRepo(path)} />
            <p className="mt-3 text-[11px] text-white/35">{t('gitTabs.emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
