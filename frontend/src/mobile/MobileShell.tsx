import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import { BackgroundCanvas, loadExternalBackgrounds } from '../components/background';
import { NotificationBell } from '../components/NotificationBell';
import { NotificationPanel } from '../components/NotificationPanel';
import SuwuDialog from '../components/dialogs/SuwuDialog';
import { initBackup } from '../lib/backup/client';
import { cycleTile, tileAfterClose } from '../lib/mobile';
import { useNotifications } from '../routes/hooks/useNotifications';
import { useUpdateCheck } from '../routes/hooks/useUpdateCheck';
import { fontDefaultAtom } from '../store/fonts';
import { backgroundAtom } from '../store/settings';
import {
  activeSpaceAtom,
  focusedIdAtom,
  layoutAtom,
  menuOpenAtom,
  menuViewAtom,
  spacesAtom,
} from '../wm/atoms';
import {
  addSpace,
  closeAt,
  createLeaf,
  findLeaf,
  getPaneData,
  leaves,
  moveLeafBetweenSpaces,
  removeSpace,
  setPaneData,
  spaceIndexForPane,
  splitAndFocus,
} from '../wm/layout';
import { getTilePlugin } from '../wm/tilePlugins';
import '../wm/registerPlugins';
import { TileTypePicker } from '../wm/TileTypePicker';
import { usePaneBus } from '../wm/usePaneBus';
import { MobileHeader } from './MobileHeader';
import { OverviewSheet } from './OverviewSheet';
import { SpaceSheet } from './SpaceSheet';

/**
 * The phone shell at `/mobile`.
 *
 * It is the desktop tiling WM with different chrome, not a second window manager:
 * the same `spacesAtom` layout tree, the same tile plugins and the same iframe
 * routes, so the tiles are literally the ones the desktop shows. What changes:
 *
 *   - the header is fixed at the top and cannot be docked (`headerPositionAtom`
 *     is a desktop setting; this shell never reads it);
 *   - one tile fills the screen — the space's *selected* tile, i.e. focus mode is
 *     the only mode — and the header's arrows cycle through the space's tiles;
 *   - there is no hover toolbar, no divider, no drag/swap and no keyboard
 *     shortcut handling: a phone has no hover and no pointer precision, so the
 *     actions live in the sheets instead;
 *   - everything else (spaces, settings, the app menu, notifications, per-tile
 *     fonts, session restore) is the desktop's, unchanged.
 *
 * The pane layer keeps the desktop invariant: **every pane stays mounted**, in
 * one flat keyed list across every space, and switching tiles only flips
 * `display`. A terminal therefore keeps its WebSocket session, a folder sync
 * keeps running, and a half-typed form survives, exactly as when the desktop
 * hides a space.
 */
export function MobileShell() {
  const { t } = useTranslation();
  const store = useStore();
  const [spaces] = useAtom(spacesAtom);
  const [activeSpace] = useAtom(activeSpaceAtom);
  const layout = useAtomValue(layoutAtom);
  const [focused, setFocused] = useAtom(focusedIdAtom);
  const fontPreset = useAtomValue(fontDefaultAtom);
  const [background] = useAtom(backgroundAtom);
  const [, setMenuOpen] = useAtom(menuOpenAtom);
  const [, setMenuView] = useAtom(menuViewAtom);

  const [pickerPaneId, setPickerPaneId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'overview' | 'space' | null>(null);

  // The same shell <-> tile protocol as the desktop: server-started-at, per-pane
  // font size, per-tile session state.
  const { sessionState } = usePaneBus({ layout, spaces, activeSpace, fontPreset });

  useNotifications();
  useUpdateCheck();
  useEffect(() => {
    void loadExternalBackgrounds();
  }, []);
  useEffect(() => {
    initBackup();
  }, []);
  useEffect(() => {
    document.title = `Suwu@${window.location.hostname || window.location.host || 'localhost'}`;
  }, []);

  const openMenu = useCallback(() => {
    setMenuView('menu');
    setMenuOpen(true);
  }, [setMenuOpen, setMenuView]);

  const ids = useMemo(() => leaves(layout), [layout]);

  // Keep the selection valid: first render, after a close, after a storage load,
  // and when the visible space has no selection of its own yet.
  useEffect(() => {
    if (ids.length > 0 && !ids.includes(focused)) setFocused(ids[0]);
  }, [ids, focused, setFocused]);

  const selected = ids.includes(focused) ? focused : (ids[0] ?? '');

  const step = useCallback(
    (delta: number) => {
      const next = cycleTile(ids, selected, delta);
      if (next) setFocused(next);
    },
    [ids, selected, setFocused],
  );

  // The empty space offers the picker; the tile is created first so the picker
  // has a pane to fill (same flow as the desktop's empty state).
  const openPickerInNewLeaf = useCallback(() => {
    const leaf = createLeaf();
    store.set(layoutAtom, leaf);
    setFocused(leaf.id);
    setPickerPaneId(leaf.id);
  }, [setFocused, store]);

  // The overview's cards: the active space's tiles, in arrow order, with the
  // per-tile font the shell would use (paneData, else the preset).
  // Close a tile from the overview. Mobile never uses the desktop's focus mode,
  // so the plain close path applies: remove the leaf, then select the tile that
  // takes its place in the arrow order.
  const closeTile = useCallback(
    (paneId: string) => {
      const cur = store.get(layoutAtom);
      if (!cur) return;
      const order = leaves(cur);
      const next = closeAt(cur, paneId);
      const survivor = tileAfterClose(order, paneId);
      store.set(layoutAtom, next);
      if (survivor) setFocused(survivor);
      setSheet(null);
    },
    [setFocused, store],
  );

  // Per-tile font, stored in the paneData of the space that owns the tile (the
  // same place the desktop's A−/A+ writes).
  const setTileFontSize = useCallback(
    (paneId: string, size: number) => {
      const current = store.get(spacesAtom);
      const index = spaceIndexForPane(current, paneId);
      if (index < 0) return;
      store.set(
        spacesAtom,
        current.map((space, i) =>
          i === index ? setPaneData(space, paneId, 'fontSize', size) : space,
        ),
      );
    },
    [store],
  );

  const moveTileToSpace = useCallback(
    (paneId: string, target: number) => {
      const current = store.get(spacesAtom);
      const from = spaceIndexForPane(current, paneId);
      if (from < 0 || from === target) return;
      store.set(spacesAtom, moveLeafBetweenSpaces(current, paneId, from, target));
      store.set(activeSpaceAtom, target);
      setFocused(paneId);
      setSheet(null);
    },
    [setFocused, store],
  );

  // "+ Open app" adds a tile beside the selected one and opens the picker on it.
  // The split geometry is invisible on a phone and stays correct on the desktop.
  const addTile = useCallback(() => {
    const cur = store.get(layoutAtom);
    const id = selected || store.get(focusedIdAtom);
    if (!cur || !id) {
      openPickerInNewLeaf();
      return;
    }
    const { next, focus } = splitAndFocus(cur, id, 'vertical');
    store.set(layoutAtom, next);
    setFocused(focus);
    setPickerPaneId(focus);
    setSheet(null);
  }, [openPickerInNewLeaf, selected, setFocused, store]);

  const selectSpace = useCallback(
    (index: number) => {
      store.set(activeSpaceAtom, index);
      setSheet(null);
    },
    [store],
  );

  const addSpaceHere = useCallback(() => {
    const { spaces: next, index } = addSpace(store.get(spacesAtom));
    store.set(spacesAtom, next);
    store.set(activeSpaceAtom, index);
    setFocused('');
    setSheet(null);
  }, [setFocused, store]);

  const removeSpaceHere = useCallback(
    (index: number) => {
      const { spaces: next, index: active } = removeSpace(store.get(spacesAtom), index);
      store.set(spacesAtom, next);
      store.set(activeSpaceAtom, active);
      setFocused('');
      setSheet(null);
    },
    [setFocused, store],
  );

  const overviewTiles = useMemo(() => {
    const space = spaces[activeSpace];
    if (!space) return [];
    return leaves(space.layout).map((paneId) => {
      const leaf = findLeaf(space.layout, paneId);
      const pane = getPaneData<{ fontSize?: number }>(space, paneId);
      return {
        paneId,
        tileType: leaf?.type === 'leaf' ? leaf.tileType : undefined,
        initialPath: leaf?.type === 'leaf' ? leaf.initialPath : undefined,
        fontSize: pane?.fontSize,
      };
    });
  }, [activeSpace, spaces]);

  const spaceSummaries = useMemo(
    () => spaces.map((space) => ({ name: space.name, tileCount: leaves(space.layout).length })),
    [spaces],
  );

  const tileLabel = useMemo(() => {
    if (!selected) return t('mobile.emptyTitle');
    const leaf = findLeaf(layout, selected);
    const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined;
    return (tileType && getTilePlugin(tileType)?.label) ?? t('plugin.empty');
  }, [layout, selected, t]);

  return (
    <div className="ambient-bg flex h-dvh w-full flex-col overflow-hidden text-slate-100">
      <BackgroundCanvas background={background} />

      <MobileHeader
        onMenu={openMenu}
        spaceLabel={String(activeSpace + 1)}
        onSpace={() => setSheet('space')}
        onOverview={() => setSheet('overview')}
        tileLabel={tileLabel}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        canSwitch={ids.length > 1}
      >
        <NotificationBell />
      </MobileHeader>

      <main
        className="relative z-0 min-h-0 flex-1"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {ids.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <button
              type="button"
              onClick={openPickerInNewLeaf}
              className="glass-control glass-btn rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 transition hover:text-white"
            >
              + {t('wm.openApp')}
            </button>
          </div>
        )}

        {/* Flat, keyed pane layer across every space (see the doc comment). */}
        {spaces.map((space, spaceIndex) =>
          leaves(space.layout).map((paneId) => {
            const leaf = findLeaf(space.layout, paneId);
            const tileType = leaf?.type === 'leaf' ? leaf.tileType : undefined;
            const plugin = tileType ? getTilePlugin(tileType) : undefined;
            const initialPath = leaf?.type === 'leaf' ? leaf.initialPath : undefined;
            const params = leaf?.type === 'leaf' ? leaf.params : undefined;
            const visible = spaceIndex === activeSpace && paneId === selected;

            return (
              <div
                key={paneId}
                className="absolute inset-0 overflow-hidden"
                style={{ display: visible ? undefined : 'none' }}
              >
                {(plugin ?? getTilePlugin('empty'))?.render(paneId, {
                  paneId,
                  initialPath,
                  onOpenPicker: setPickerPaneId,
                  params,
                })}
              </div>
            );
          }),
        )}
      </main>

      <SuwuDialog />
      <NotificationPanel />

      <OverviewSheet
        open={sheet === 'overview'}
        onOpenChange={(open) => setSheet(open ? 'overview' : null)}
        tiles={overviewTiles}
        selected={selected}
        sessionState={sessionState}
        fontDefault={fontPreset}
        spaces={spaceSummaries}
        activeSpace={activeSpace}
        onSelect={(paneId) => {
          setFocused(paneId);
          setSheet(null);
        }}
        onCloseTile={closeTile}
        onFontSize={setTileFontSize}
        onMoveToSpace={moveTileToSpace}
        onAddApp={addTile}
      />

      <SpaceSheet
        open={sheet === 'space'}
        onOpenChange={(open) => setSheet(open ? 'space' : null)}
        spaces={spaceSummaries}
        activeSpace={activeSpace}
        onSelect={selectSpace}
        onAdd={addSpaceHere}
        onRemove={removeSpaceHere}
      />

      {pickerPaneId && (
        <TileTypePicker
          paneId={pickerPaneId}
          setLayout={(fn) => store.set(layoutAtom, fn)}
          onSelect={() => {
            // Keep the new tile selected: on a phone the tap that filled the
            // picker should leave the user looking at what they picked.
            setFocused(pickerPaneId);
          }}
          onClose={() => setPickerPaneId(null)}
        />
      )}
    </div>
  );
}
