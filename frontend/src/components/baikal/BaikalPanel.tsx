import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CommonTileContainer,
  useReportTileState,
  useTileSessionState,
} from '../CommonTileContainer';
import { DENSE_TILE_BG } from '../../store/appearance';
import { useSidebarCollapse } from '../hooks/useSidebarCollapse';
import { authFetch } from '../../lib/api';
import {
  closeTab,
  openTab,
  syncTabTitles,
  type BaikalTab,
  type BaikalTerminal,
} from '../../lib/baikal';
import { useBaikalData } from './useBaikalData';
import { SpaceList } from './SpaceList';
import { TabBar } from './TabBar';
import { BaikalTerm } from './BaikalTerm';

interface BaikalSessionState {
  tabs?: BaikalTab[];
  activeId?: string;
}

/**
 * The Baikal tile: a herdr-core client.
 *
 * Left: spaces (directories) with their terminals, collapsible. Right: tabs, one
 * attached terminal each. The whole thing is a view over the core's own state —
 * closing a tab detaches, and the programs keep running in the daemon.
 */
export function BaikalPanel() {
  const { t } = useTranslation();
  const session = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get('session');
    return value ?? undefined;
  }, []);

  const { snapshot, error, hint, loading, terminals, spaces, refresh } = useBaikalData(session);
  const saved = useTileSessionState<BaikalSessionState>();
  const report = useReportTileState();

  const [tabs, setTabs] = useState<BaikalTab[]>([]);
  const [activeId, setActiveId] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const hydrated = useRef(false);

  const sidebar = useSidebarCollapse('baikal');

  // Restore tabs once, then keep them in session state.
  useEffect(() => {
    if (hydrated.current || !saved) return;
    hydrated.current = true;
    const savedTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
    if (savedTabs.length > 0) {
      setTabs(savedTabs);
      setActiveId(
        saved.activeId && savedTabs.some((tab) => tab.id === saved.activeId)
          ? saved.activeId
          : savedTabs[0].id,
      );
    }
  }, [saved]);

  useEffect(() => {
    if (!hydrated.current) return;
    report({ tabs, activeId });
  }, [tabs, activeId, report]);

  // Tab titles follow their terminals; a terminal that vanished (finished and
  // removed elsewhere) closes its tab.
  useEffect(() => {
    if (terminals.length === 0) return;
    const live = new Set(
      terminals.filter((terminal) => terminal.live).map((terminal) => terminal.address),
    );
    setTabs((prev) => {
      const titles = syncTabTitles(prev, terminals);
      const kept = titles.filter((tab) => live.has(tab.terminal));
      if (kept.length !== titles.length && !kept.some((tab) => tab.id === activeId)) {
        setActiveId(kept[0]?.id ?? '');
      }
      return kept.length === titles.length ? titles : kept;
    });
  }, [terminals, activeId]);

  const open = useCallback((terminal: BaikalTerminal) => {
    setTabs((prev) => {
      const next = openTab(prev, terminal);
      setActiveId(next.activeId);
      return next.tabs;
    });
  }, []);

  const close = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = closeTab(prev, activeId, id);
        setActiveId(next.activeId);
        return next.tabs;
      });
    },
    [activeId],
  );

  // "+" starts a shell in the active space's directory (or home).
  const newShell = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const activeSpace = spaces.find((space) =>
        space.terminals.some((terminal: BaikalTerminal) => terminal.address === activeTerminal()),
      );
      const body = {
        cwd: activeSpace?.identityCwd ?? '',
        spaceId: activeSpace?.id ?? '',
      };
      const response = await authFetch('/api/baikal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setActionError(payload.error ?? `run failed (${response.status})`);
        return;
      }
      const result = (await response.json()) as { terminal: string; spaceId: string; cwd: string };
      await refresh();
      setTabs((prev) => {
        const next = openTab(prev, {
          address: result.terminal,
          name: result.terminal,
          title: '',
          agent: '',
          cwd: result.cwd,
          state: 'live',
          live: true,
          createdMs: Date.now(),
          spaceId: result.spaceId,
        });
        setActiveId(next.activeId);
        return next.tabs;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'run failed');
    } finally {
      setCreating(false);
    }
  }, [creating, spaces, refresh, activeTerminal]);

  function activeTerminal(): string {
    return tabs.find((tab) => tab.id === activeId)?.terminal ?? '';
  }

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const core = snapshot?.core;

  return (
    <CommonTileContainer noPadding background={DENSE_TILE_BG}>
      <div ref={sidebar.containerRef} className="flex h-full min-h-0 flex-col">
        <header className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2">
          <button
            type="button"
            onClick={sidebar.toggle}
            aria-expanded={!sidebar.collapsed}
            aria-label={t('baikal.toggleSpaces')}
            title={t('baikal.toggleSpaces')}
            className="-ml-1 grid h-6 w-6 shrink-0 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white/80"
          >
            {sidebar.collapsed ? '›' : '‹'}
          </button>
          <span className="text-sm font-semibold tracking-wide text-white/60">
            {t('plugin.baikal')}
          </span>
          {core?.version && (
            <span className="truncate text-[10px] text-white/25">
              {t('baikal.coreVersion', { version: core.version })}
            </span>
          )}
          <div className="flex-1" />
        </header>

        <div className="flex min-h-0 flex-1">
          {!sidebar.collapsed && (
            <aside className="w-56 shrink-0 border-r border-white/[0.06]">
              <SpaceList
                spaces={spaces}
                unassigned={snapshot?.unassigned ?? []}
                active={activeTab?.terminal}
                onOpen={open}
                onNewShell={() => void newShell()}
                creating={creating}
              />
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <TabBar
              tabs={tabs}
              activeId={activeId}
              terminals={terminals}
              onSelect={setActiveId}
              onClose={close}
              onNewShell={() => void newShell()}
              creating={creating}
            />

            <div className="min-h-0 flex-1">
              {activeTab ? (
                <BaikalTerm
                  key={`${activeTab.terminal}:${activeTab.observe ? 'ro' : 'rw'}`}
                  terminal={activeTab.terminal}
                  session={session}
                  observe={activeTab.observe}
                />
              ) : loading ? (
                <Centered>{t('baikal.loading')}</Centered>
              ) : error ? (
                <CoreError error={error} hint={hint} />
              ) : (
                <Empty onNewShell={() => void newShell()} creating={creating} />
              )}
            </div>

            {actionError && (
              <div className="shrink-0 border-t border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                {actionError}
              </div>
            )}
          </main>
        </div>
      </div>
    </CommonTileContainer>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[11px] text-white/40">{children}</div>
    </div>
  );
}

function Empty({ onNewShell, creating }: { onNewShell: () => void; creating: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div>
        <div className="text-sm font-medium text-white/70">{t('baikal.empty')}</div>
        <div className="mt-1 max-w-sm text-[11px] leading-relaxed text-white/35">
          {t('baikal.emptyHint')}
        </div>
      </div>
      <button
        type="button"
        onClick={onNewShell}
        disabled={creating}
        className="rounded-[6px] border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/[0.10] hover:text-white disabled:opacity-40"
      >
        {creating ? t('baikal.creating') : `+ ${t('baikal.newShell')}`}
      </button>
    </div>
  );
}

function CoreError({ error, hint }: { error: string; hint: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md rounded-[6px] border border-amber-500/20 bg-amber-500/5 p-4 text-center">
        <div className="text-xs font-semibold text-amber-300">{t('baikal.coreOffline')}</div>
        <p className="mt-1 break-words text-[11px] leading-relaxed text-white/50">
          {hint ?? error}
        </p>
      </div>
    </div>
  );
}
