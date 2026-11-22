import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CommonTileContainer,
  useReportTileState,
  useTileSessionReady,
  useTileSessionState,
} from '../CommonTileContainer';
import { DENSE_TILE_BG } from '../../store/appearance';
import { useSidebarCollapse } from '../hooks/useSidebarCollapse';
import { useVerticalSplit } from './useVerticalSplit';
import { authFetch } from '../../lib/api';
import { FONT_DEFAULT, clampFont } from '../../store/fonts';
import {
  closeTab,
  listAgents,
  openTab,
  sortSpaces,
  syncTabTitles,
  terminalLabel,
  type BaikalSpace,
  type BaikalTab,
  type BaikalTerminal,
} from '../../lib/baikal';
import { useBaikalData } from './useBaikalData';
import { AgentList } from './AgentList';
import { cn } from '@/lib/utils';
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
 * workspace. Only the tab on screen is mounted: a hidden xterm keeps parsing and
 * rendering every byte its agent writes, which is what made a tile with a dozen
 * tabs cost a core (§13.5 of the plan). Unmounting detaches the viewer, never the
 * program — and the next attach replays the core's scrollback, so a tab shows what
 * happened while it was away.
 *
 * Closing a tab ends the program; the × is the deliberate "stop this".
 *
 * `CommonTileContainer` *provides* the session-state context, so the page itself
 * is a thin wrapper: the workspace below is a child, and only there do
 * `useTileSessionState` / `useReportTileState` read the provider. A panel that
 * rendered the container *and* called those hooks read the default context
 * instead — `state: null, ready: false`, forever — which silently disabled the
 * tab persistence this tile needs.
 */
export function BaikalPanel() {
  return (
    <CommonTileContainer noPadding background={DENSE_TILE_BG}>
      <BaikalWorkspace />
    </CommonTileContainer>
  );
}

/** The panel itself: spaces, tabs, attached terminals, and every action on them. */
function BaikalWorkspace() {
  const { t } = useTranslation();
  const session = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get('session');
    return value ?? undefined;
  }, []);

  const { snapshot, error, hint, loading, terminals, spaces, refresh } = useBaikalData(session);
  const saved = useTileSessionState<BaikalSessionState>();
  const sessionReady = useTileSessionReady();
  const report = useReportTileState();

  const [spaceTabs, setSpaceTabs] = useState<Record<string, SpaceTabs>>({});
  const [activeSpaceId, setActiveSpaceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [peek, setPeek] = useState<BaikalTerminal | null>(null);
  const hydrated = useRef(false);
  /** Grid of the last terminal shown, so a new shell starts at that size. */
  const lastSize = useRef<{ cols: number; rows: number } | null>(null);
  /** Bumped whenever the user asks for a tab, so that tab's terminal takes the
   *  focus back: the click landed on a button, and typing should reach the shell
   *  — including when the tab was already the active one. */
  const [focusTick, setFocusTick] = useState(0);

  const sidebar = useSidebarCollapse('baikal');
  const split = useVerticalSplit();
  /** The pane's tile font size, owned by the shell (same contract as /term). */
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  const paneId = useMemo(
    () => new URLSearchParams(window.location.search).get('pane') ?? undefined,
    [],
  );

  const orderedSpaces = useMemo(() => sortSpaces(spaces), [spaces]);
  const agents = useMemo(() => listAgents(terminals), [terminals]);
  const activeSpace = orderedSpaces.find((space) => space.id === activeSpaceId);
  const active = spaceTabs[activeSpaceId] ?? EMPTY_SPACE_TABS;
  const activeTab = active.tabs.find((tab) => tab.id === active.activeId);

  // Restore once, as soon as the WM has answered — an answer of `null` means
  // "nothing saved", which is not the same as "not answered yet" and must still
  // end the hydration: from then on this tile reports its state.
  useEffect(() => {
    if (hydrated.current || !sessionReady) return;
    hydrated.current = true;
    const restored = saved && saved.spaces && typeof saved.spaces === 'object' ? saved.spaces : {};
    setSpaceTabs(restored);
    if (saved?.activeSpaceId) setActiveSpaceId(saved.activeSpaceId);
  }, [saved, sessionReady]);

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

  // The tile's font size comes from the shell, exactly as it does for a /term
  // pane: the same pane menu that sizes a terminal sizes these terminals. Until
  // the first message arrives the stored default is used.
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const data = event.data as { type?: string; fontSize?: number } | undefined;
      if (data?.type === 'tile-font-size' && typeof data.fontSize === 'number') {
        setFontSize(clampFont(data.fontSize));
      }
    };
    window.addEventListener('message', onMsg);
    // Ask on mount: the shell's broadcast can land before this listener exists.
    window.parent?.postMessage({ type: 'request-font-size', paneId: paneId ?? '' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, [paneId]);

  const upsertSpaceTabs = useCallback((spaceId: string, fn: (entry: SpaceTabs) => SpaceTabs) => {
    setSpaceTabs((prev) => ({
      ...prev,
      [spaceId]: fn(prev[spaceId] ?? EMPTY_SPACE_TABS),
    }));
  }, []);

  // A space with tabs always has one selected: if the id points at a tab that
  // is gone (pruned above, or restored state written by an older build), fall
  // back to the first instead of showing the empty picker under a full strip.
  useEffect(() => {
    if (activeTab || active.tabs.length === 0) return;
    upsertSpaceTabs(activeSpaceId, (entry) => ({ ...entry, activeId: entry.tabs[0].id }));
  }, [activeSpaceId, active, activeTab, upsertSpaceTabs]);

  /** Open a terminal as a tab of the space it belongs to, and select that space. */
  const open = useCallback(
    (terminal: BaikalTerminal, observe = false) => {
      const spaceId = terminal.spaceId || activeSpaceId;
      if (spaceId) setActiveSpaceId(spaceId);
      setFocusTick((n) => n + 1);
      upsertSpaceTabs(spaceId, (entry) => {
        const next = openTab(entry.tabs, terminal, observe);
        return { tabs: next.tabs, activeId: next.activeId };
      });
    },
    [activeSpaceId, upsertSpaceTabs],
  );

  // Closing a tab ends that terminal's program. Hiding a tab (switching space)
  // only detaches the view; the × is the deliberate "stop this" — so it kills the
  // terminal first and removes the tab, rather than leaving an orphan running in
  // the daemon with nothing pointing at it.
  const close = useCallback(
    async (id: string) => {
      const tab = (spaceTabs[activeSpaceId]?.tabs ?? []).find((candidate) => candidate.id === id);
      const terminal = tab
        ? terminals.find((candidate) => candidate.address === tab.terminal)
        : undefined;
      // Remove the tab in the same turn: the kill makes the core close the
      // stream, whose handler also prunes the tab, and both are idempotent.
      upsertSpaceTabs(activeSpaceId, (entry) => {
        const next = closeTab(entry.tabs, entry.activeId, id);
        return { tabs: next.tabs, activeId: next.activeId };
      });
      if (!terminal) return;
      try {
        // A terminal that ended between the snapshot and this click is already
        // what we wanted; only removing its record is left to do.
        if (terminal.live) {
          await postJSON('/api/baikal/terminal', { action: 'kill', terminal: terminal.address });
        } else {
          await postJSON('/api/baikal/terminal', { action: 'rm', terminal: terminal.address });
        }
      } catch {
        // Kill racing the program's own exit surfaces as EOF or "no such
        // terminal" — the tab is gone either way, so keep it quiet.
      }
      await refresh();
    },
    [activeSpaceId, refresh, spaceTabs, terminals, upsertSpaceTabs],
  );

  // "+ shell" starts a shell in the active space; a new space starts one in the
  // same directory, so the spaces you open sit next to each other.
  const newShell = useCallback(
    async (freshSpace = false) => {
      if (creating) return;
      setCreating(true);
      setActionError(null);
      try {
        // Create the shell at the size the pane will have. Core's default is
        // 200×120, and attaching a 30-row viewer then scrolls the first prompt
        // above the visible rows — the pane looks empty until a keypress.
        const size = lastSize.current ?? estimateGrid();
        const result = await postJSON<{ terminal: string; spaceId: string; cwd: string }>(
          '/api/baikal/run',
          {
            cwd: activeSpace?.identityCwd ?? '',
            spaceId: freshSpace ? '' : (activeSpace?.id ?? ''),
            cols: size.cols,
            rows: size.rows,
          },
        );
        await refresh();
        setActiveSpaceId(result.spaceId);
        setFocusTick((n) => n + 1);
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
      if (next) {
        upsertSpaceTabs(activeSpaceId, (entry) => ({ ...entry, activeId: next.id }));
        setFocusTick((n) => n + 1);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, activeSpaceId, upsertSpaceTabs]);

  const core = snapshot?.core;

  return (
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
        <span className="text-base font-semibold tracking-wide text-white/60">
          {t('plugin.baikal')}
        </span>
        {core?.version && (
          <span className="truncate text-[11px] text-white/40">
            {t('baikal.coreVersion', { version: core.version })}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {!sidebar.collapsed && (
          <aside
            ref={split.containerRef}
            className="flex w-56 shrink-0 flex-col border-r border-white/[0.06]"
          >
            {/* Spaces on top, agents below, split 50/50 until the divider is
                  dragged: both are lists of the same thing at different stages
                  of wanting your attention. */}
            <div className="flex min-h-0 flex-col" style={{ flex: `0 0 ${split.ratio * 100}%` }}>
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
            </div>
            <div
              {...split.handleProps}
              aria-label={t('baikal.resizeSplit')}
              title={t('baikal.resizeSplit')}
              className={cn(
                'group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-y border-white/[0.06] transition',
                split.dragging ? 'bg-sky-400/20' : 'hover:bg-white/[0.06]',
              )}
            >
              <span
                className={cn(
                  'h-px w-6 rounded transition',
                  split.dragging ? 'bg-sky-300/70' : 'bg-white/15 group-hover:bg-white/30',
                )}
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <AgentList
                agents={agents}
                spaces={spaces}
                activeTerminal={activeTab?.terminal}
                onOpenAgent={(terminal) => open(terminal)}
              />
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            tabs={active.tabs}
            activeId={active.activeId}
            terminals={terminals}
            onSelect={(id) => {
              upsertSpaceTabs(activeSpaceId, (entry) => ({ ...entry, activeId: id }));
              setFocusTick((n) => n + 1);
            }}
            onClose={(id) => void close(id)}
            onNewShell={() => void newShell()}
            creating={creating}
          />

          <div className="relative min-h-0 flex-1">
            {/* Only the tab on screen is mounted. A hidden xterm is not free:
                it keeps parsing and rendering every byte its agent writes, so a
                tile with a dozen tabs spent a core and hundreds of megabytes on
                terminals nobody was looking at. Unmounting detaches the viewer;
                the next attach replays the core's scrollback, so a tab shows
                what happened while it was away. The program itself is not
                touched — it keeps running in the daemon, as before. */}
            {activeTab && (
              <div key={activeTab.id} className="absolute inset-0 p-1.5">
                <BaikalTerm
                  terminal={activeTab.terminal}
                  session={session}
                  observe={activeTab.observe}
                  focusToken={focusTick}
                  fontSize={fontSize}
                  onSize={(cols, rows) => {
                    lastSize.current = { cols, rows };
                  }}
                  onDetached={(ended) => {
                    // A program that ended has no tab left to show.
                    setSpaceTabs((prev) => {
                      const current = prev[activeSpaceId];
                      if (!current) return prev;
                      const kept = current.tabs.filter((candidate) => candidate.terminal !== ended);
                      if (kept.length === current.tabs.length) return prev;
                      const next = { ...prev };
                      if (kept.length === 0) delete next[activeSpaceId];
                      else next[activeSpaceId] = { tabs: kept, activeId: kept[0].id };
                      return next;
                    });
                  }}
                />
              </div>
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
        <div className="text-base font-semibold text-white/70">
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
              className="max-w-40 truncate rounded-[6px] border border-white/10 bg-white/[0.05] px-2 py-1 text-xs text-white/70 transition hover:bg-white/[0.10] hover:text-white"
            >
              {terminalLabel(terminal)}
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

/**
 * A grid guess for the first shell of a session, when no terminal has reported a
 * size yet. Monospace at the default 14 px is ~8.4×17 px per cell; the shell is
 * created at this size so its first prompt lands inside the visible rows, and the
 * real attach resizes it by at most a few cells.
 */
function estimateGrid(): { cols: number; rows: number } {
  const width = window.innerWidth || 800;
  const height = window.innerHeight || 600;
  const cols = Math.max(20, Math.floor((width - 240 - 12) / 8.4));
  const rows = Math.max(6, Math.floor((height - 32 - 36 - 24 - 12) / 17));
  return { cols, rows };
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
