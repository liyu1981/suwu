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
  sortSpaces,
  syncTabTitles,
  type BaikalSpace,
  type BaikalTab,
  type BaikalTerminal,
} from '../../lib/baikal';
import { useBaikalData } from './useBaikalData';
import { SpaceList } from './SpaceList';
import { TabBar } from './TabBar';
import { BaikalTerm } from './BaikalTerm';
import { PeekDialog } from './TerminalMenu';

/** Tabs of one space, with its own active tab. */
interface SpaceTabs {
  tabs: BaikalTab[];
  activeId: string;
}

interface BaikalSessionState {
  activeSpaceId?: string;
  spaces?: Record<string, SpaceTabs>;
}

const EMPTY_SPACE_TABS: SpaceTabs = { tabs: [], activeId: '' };

/**
 * The Baikal tile: a herdr-core client.
 *
 * Left: spaces (directories) with their terminals, collapsible; selecting one
 * switches the tab strip on the right, as Herdr's TUI switches tabs with the
 * workspace. Every terminal of every space stays mounted while its span is not
 * shown — an attachment is a viewer, and hiding it must not detach it.
 *
 * Closing a tab detaches; the program keeps running in the daemon.
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

  const [spaceTabs, setSpaceTabs] = useState<Record<string, SpaceTabs>>({});
  const [activeSpaceId, setActiveSpaceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [peek, setPeek] = useState<BaikalTerminal | null>(null);
  const hydrated = useRef(false);

  const sidebar = useSidebarCollapse('baikal');

  const orderedSpaces = useMemo(() => sortSpaces(spaces), [spaces]);
  const activeSpace = orderedSpaces.find((space) => space.id === activeSpaceId);
  const active = spaceTabs[activeSpaceId] ?? EMPTY_SPACE_TABS;
  const activeTab = active.tabs.find((tab) => tab.id === active.activeId);

  // Restore once, then keep everything in session state.
  useEffect(() => {
    if (hydrated.current || !saved) return;
    hydrated.current = true;
    const restored = saved.spaces && typeof saved.spaces === 'object' ? saved.spaces : {};
    setSpaceTabs(restored);
    if (saved.activeSpaceId) setActiveSpaceId(saved.activeSpaceId);
  }, [saved]);

  useEffect(() => {
    if (!hydrated.current) return;
    report({ activeSpaceId, spaces: spaceTabs });
  }, [activeSpaceId, spaceTabs, report]);

  // The first space is selected when the snapshot arrives (or when the selected
  // one is gone: forgotten, or every terminal in it finished).
  useEffect(() => {
    if (!snapshot) return;
    if (orderedSpaces.some((space) => space.id === activeSpaceId)) return;
    setActiveSpaceId(orderedSpaces[0]?.id ?? '');
  }, [snapshot, orderedSpaces, activeSpaceId]);

  // Terminals that are gone lose their tab; titles follow their terminals. An
  // empty snapshot is a real answer — that is what a core restart looks like.
  useEffect(() => {
    if (!snapshot) return;
    const live = new Set(
      terminals.filter((terminal) => terminal.live).map((terminal) => terminal.address),
    );
    setSpaceTabs((prev) => {
      let changed = false;
      const next: Record<string, SpaceTabs> = {};
      for (const [spaceId, entry] of Object.entries(prev)) {
        const kept = entry.tabs.filter((tab) => live.has(tab.terminal));
        const retitled = syncTabTitles(kept, terminals);
        const activeId = retitled.some((tab) => tab.id === entry.activeId)
          ? entry.activeId
          : (retitled[0]?.id ?? '');
        if (kept.length !== entry.tabs.length || retitled !== kept || activeId !== entry.activeId) {
          changed = true;
        }
        if (retitled.length > 0) next[spaceId] = { tabs: retitled, activeId };
      }
      return changed ? next : prev;
    });
  }, [snapshot, terminals]);

  const upsertSpaceTabs = useCallback((spaceId: string, fn: (entry: SpaceTabs) => SpaceTabs) => {
    setSpaceTabs((prev) => ({
      ...prev,
      [spaceId]: fn(prev[spaceId] ?? EMPTY_SPACE_TABS),
    }));
  }, []);

  /** Open a terminal as a tab of the space it belongs to, and select that space. */
  const open = useCallback(
    (terminal: BaikalTerminal, observe = false) => {
      const spaceId = terminal.spaceId || activeSpaceId;
      if (spaceId) setActiveSpaceId(spaceId);
      upsertSpaceTabs(spaceId, (entry) => {
        const next = openTab(entry.tabs, terminal, observe);
        return { tabs: next.tabs, activeId: next.activeId };
      });
    },
    [activeSpaceId, upsertSpaceTabs],
  );

  const close = useCallback(
    (id: string) => {
      upsertSpaceTabs(activeSpaceId, (entry) => {
        const next = closeTab(entry.tabs, entry.activeId, id);
        return { tabs: next.tabs, activeId: next.activeId };
      });
    },
    [activeSpaceId, upsertSpaceTabs],
  );

  // "+ shell" starts a shell in the active space; a new space starts one in the
  // same directory, so the spaces you open sit next to each other.
  const newShell = useCallback(
    async (freshSpace = false) => {
      if (creating) return;
      setCreating(true);
      setActionError(null);
      try {
        const result = await postJSON<{ terminal: string; spaceId: string; cwd: string }>(
          '/api/baikal/run',
          {
            cwd: activeSpace?.identityCwd ?? '',
            spaceId: freshSpace ? '' : (activeSpace?.id ?? ''),
          },
        );
        await refresh();
        setActiveSpaceId(result.spaceId);
        upsertSpaceTabs(result.spaceId, (entry) => {
          const next = openTab(entry.tabs, {
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
          return { tabs: next.tabs, activeId: next.activeId };
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'run failed');
      } finally {
        setCreating(false);
      }
    },
    [activeSpace, creating, refresh, upsertSpaceTabs],
  );

  const runTerminalAction = useCallback(
    async (terminal: BaikalTerminal, action: 'kill' | 'rm') => {
      try {
        await postJSON('/api/baikal/terminal', { action, terminal: terminal.address });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `${action} failed`);
      }
    },
    [refresh],
  );

  const assign = useCallback(
    async (terminal: BaikalTerminal, spaceId: string) => {
      try {
        await postJSON('/api/baikal/assign', { terminal: terminal.address, spaceId });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'assign failed');
      }
    },
    [refresh],
  );

  const renameSpace = useCallback(
    async (space: BaikalSpace, name: string) => {
      try {
        await postJSON(
          '/api/baikal/space',
          name ? { spaceId: space.id, name } : { spaceId: space.id, clearName: true },
        );
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'rename failed');
      }
    },
    [refresh],
  );

  const recolourSpace = useCallback(
    async (space: BaikalSpace, colour: string) => {
      try {
        await postJSON('/api/baikal/space', { spaceId: space.id, colour });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'colour failed');
      }
    },
    [refresh],
  );

  const forgetSpace = useCallback(
    async (space: BaikalSpace) => {
      try {
        await postJSON('/api/baikal/space', { spaceId: space.id, forget: true });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'forget failed');
      }
    },
    [refresh],
  );

  // Keyboard: Ctrl/Cmd+Alt+←/→ moves between the active space's tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (active.tabs.length < 2) return;
      event.preventDefault();
      event.stopPropagation();
      const index = active.tabs.findIndex((tab) => tab.id === active.activeId);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = active.tabs[(index + step + active.tabs.length) % active.tabs.length];
      if (next) upsertSpaceTabs(activeSpaceId, (entry) => ({ ...entry, activeId: next.id }));
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, activeSpaceId, upsertSpaceTabs]);

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
          {activeSpace && (
            <span className="truncate text-[10px] text-white/30" title={activeSpace.identityCwd}>
              {activeSpace.name}
            </span>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          {!sidebar.collapsed && (
            <aside className="w-56 shrink-0 border-r border-white/[0.06]">
              <SpaceList
                spaces={spaces}
                unassigned={snapshot?.unassigned ?? []}
                activeSpaceId={activeSpaceId}
                activeTerminal={activeTab?.terminal}
                onSelectSpace={(space) => setActiveSpaceId(space.id)}
                onOpen={open}
                onNewSpace={() => void newShell(true)}
                creating={creating}
                onAssign={(terminal, spaceId) => void assign(terminal, spaceId)}
                onKill={(terminal) => void runTerminalAction(terminal, 'kill')}
                onRemove={(terminal) => void runTerminalAction(terminal, 'rm')}
                onPeek={setPeek}
                onRename={(space, name) => void renameSpace(space, name)}
                onColour={(space, colour) => void recolourSpace(space, colour)}
                onForget={(space) => void forgetSpace(space)}
              />
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <TabBar
              tabs={active.tabs}
              activeId={active.activeId}
              terminals={terminals}
              onSelect={(id) =>
                upsertSpaceTabs(activeSpaceId, (entry) => ({ ...entry, activeId: id }))
              }
              onClose={close}
              onNewShell={() => void newShell()}
              creating={creating}
            />

            <div className="relative min-h-0 flex-1">
              {/* Every tab of every space stays mounted; only the active one is
                  shown. Hiding an attachment with display:none keeps its stream
                  (and the program) alive — the same invariant as the tiling WM. */}
              {Object.entries(spaceTabs).flatMap(([spaceId, entry]) =>
                entry.tabs.map((tab) => {
                  const visible = spaceId === activeSpaceId && tab.id === active.activeId;
                  return (
                    <div
                      key={`${spaceId}:${tab.id}`}
                      className="absolute inset-0"
                      style={{ display: visible ? undefined : 'none' }}
                    >
                      <BaikalTerm
                        terminal={tab.terminal}
                        session={session}
                        observe={tab.observe}
                        onDetached={(terminal) => {
                          // A program that ended has no tab left to show.
                          setSpaceTabs((prev) => {
                            const current = prev[spaceId];
                            if (!current) return prev;
                            const kept = current.tabs.filter(
                              (candidate) => candidate.terminal !== terminal,
                            );
                            if (kept.length === current.tabs.length) return prev;
                            const next = { ...prev };
                            if (kept.length === 0) delete next[spaceId];
                            else next[spaceId] = { tabs: kept, activeId: kept[0].id };
                            return next;
                          });
                        }}
                      />
                    </div>
                  );
                }),
              )}

              {!activeTab && (
                <Empty
                  terminals={activeSpace?.terminals ?? terminals}
                  onOpen={open}
                  onNewShell={() => void newShell()}
                  creating={creating}
                />
              )}
            </div>

            <PeekDialog terminal={peek} onClose={() => setPeek(null)} />

            {actionError && (
              <div className="shrink-0 border-t border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                {actionError}
              </div>
            )}

            {loading && !snapshot ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-[11px] text-white/40">
                {t('baikal.loading')}
              </div>
            ) : error && !snapshot ? (
              <div className="absolute inset-0 grid place-items-center px-6">
                <CoreError error={error} hint={hint} />
              </div>
            ) : null}
          </main>
        </div>
      </div>
    </CommonTileContainer>
  );
}

/**
 * The panel with no tab open in the selected space. "No terminals" and "no tab"
 * are different states, and the second is common on a phone where the space list
 * collapses — so it offers the terminals directly instead of only telling the
 * user to start a shell.
 */
function Empty({
  terminals,
  onOpen,
  onNewShell,
  creating,
}: {
  terminals: BaikalTerminal[];
  onOpen: (terminal: BaikalTerminal, observe: boolean) => void;
  onNewShell: () => void;
  creating: boolean;
}) {
  const { t } = useTranslation();
  const live = terminals.filter((terminal) => terminal.live).slice(0, 8);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div>
        <div className="text-sm font-medium text-white/70">
          {live.length > 0 ? t('baikal.pickTerminal') : t('baikal.empty')}
        </div>
        <div className="mt-1 max-w-sm text-[11px] leading-relaxed text-white/35">
          {live.length > 0 ? t('baikal.pickTerminalHint') : t('baikal.emptyHint')}
        </div>
      </div>
      {live.length > 0 && (
        <div className="flex max-w-sm flex-wrap justify-center gap-1.5">
          {live.map((terminal) => (
            <button
              key={terminal.address}
              type="button"
              onClick={() => onOpen(terminal, false)}
              title={terminal.cwd}
              className="max-w-40 truncate rounded-[6px] border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.10] hover:text-white"
            >
              {terminal.name || terminal.address}
            </button>
          ))}
        </div>
      )}
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
    <div className="max-w-md rounded-[6px] border border-amber-500/20 bg-amber-500/5 p-4 text-center">
      <div className="text-xs font-semibold text-amber-300">{t('baikal.coreOffline')}</div>
      <p className="mt-1 break-words text-[11px] leading-relaxed text-white/50">{hint ?? error}</p>
    </div>
  );
}

async function postJSON<T = { ok: boolean }>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `${path} failed (${response.status})`);
  return payload as T;
}
