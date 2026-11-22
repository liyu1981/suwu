import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { appMenuAtom, getVisibleApps, type AppMenuState } from '../store/appMenu';
import { authFetch } from '../lib/api';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { getAppIconClasses, getAppIconLetter } from './appIcons';
import { getAllTilePlugins } from './tilePlugins';
import { setLeafType, type LayoutNode } from './layout';
import { ChevronRightIcon } from '../components/icons';

/** How many apps one page of the picker shows. */
const APP_PAGE_SIZE = 8;

const appRow =
  'flex w-full cursor-pointer select-none items-center gap-3 rounded px-3 py-2.5 text-left ' +
  'outline-none transition-colors ' +
  'hover:bg-white/10 hover:text-popover-foreground active:bg-white/15 active:text-popover-foreground ' +
  'focus-visible:bg-white/10 focus-visible:text-popover-foreground';

const pagerBtn =
  'flex items-center rounded px-2 py-1.5 text-xs text-slate-300 transition ' +
  'hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white';

function AppIcon({ id, label, pluginId }: { id: string; label?: string; pluginId?: string }) {
  const classes = getAppIconClasses(id, pluginId);
  const letter = getAppIconLetter(id, label ?? id, pluginId);
  return (
    <div
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-xs font-bold ${classes.bg} ${classes.text}`}
    >
      {letter}
    </div>
  );
}

/** iOS-settings-style dialog for choosing which application to open in a tile. */
export function TileTypePicker({
  paneId,
  setLayout,
  onSelect,
  onClose,
}: {
  paneId: string;
  setLayout: (fn: (prev: LayoutNode | null) => LayoutNode | null) => void;
  onSelect: (tileType: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const plugins = getAllTilePlugins();
  const [menuItems] = useAtom(appMenuAtom);
  const navRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // Get visible apps in user-defined order. Apps turned off in App Menu
  // settings never reach this list, so the search below only matches active
  // ones.
  const appState: AppMenuState =
    !menuItems || typeof menuItems !== 'object' || Array.isArray(menuItems)
      ? { hiddenApps: [], customApps: [] }
      : (menuItems as AppMenuState);
  const visibleApps = getVisibleApps(plugins, appState);

  // In-memory typeahead: the menu is small, so filtering the active list
  // locally beats any round-trip.
  const q = query.trim().toLowerCase();
  const filteredApps = q
    ? visibleApps.filter((item) => {
        const label = item.kind === 'plugin' ? item.plugin.label : item.config.label;
        const desc = item.kind === 'plugin' ? item.plugin.description : item.config.description;
        const ids =
          item.kind === 'plugin' ? item.plugin.id : `${item.config.pluginId} ${item.config.id}`;
        return `${label ?? ''} ${desc ?? ''} ${ids}`.toLowerCase().includes(q);
      })
    : visibleApps;

  const pageCount = Math.max(1, Math.ceil(filteredApps.length / APP_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedApps = filteredApps.slice(safePage * APP_PAGE_SIZE, (safePage + 1) * APP_PAGE_SIZE);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    authFetch('/api/home', { cache: 'no-store', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.path) setHomeDir(data.path);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const selectPlugin = (tileType: string, params?: Record<string, string>) => {
    const initialPath =
      tileType === 'filebrowser' || tileType === 'fileviewer' ? (homeDir ?? undefined) : undefined;
    setLayout((prev) => (prev ? setLeafType(prev, paneId, tileType, initialPath, params) : prev));
    onSelect(tileType);
    onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const rows = Array.from(navRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % rows.length;
        break;
      case 'ArrowUp':
        next = current < 0 ? rows.length - 1 : (current - 1 + rows.length) % rows.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    rows[next].focus();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="w-[min(92vw,28rem)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <DialogTitle>{t('wm.openApp')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('wm.chooseApp')}</p>
        <div className="mt-3">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.key === 'Enter' && pagedApps.length > 0)) {
                e.preventDefault();
                navRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
              }
            }}
            placeholder={t('wm.searchApps')}
            aria-label={t('wm.searchApps')}
            className="w-full rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-popover-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-sky-400/50"
          />
        </div>
        <nav ref={navRef} aria-label="Applications" onKeyDown={onKeyDown} className="mt-2">
          <div className="divide-y divide-white/5 rounded-[6px] border border-white/10 bg-black/20">
            {/* The empty-state message occupies exactly one reserved row
                (icon-height box, same padding as a slot), so an empty search
                still totals APP_PAGE_SIZE rows. */}
            {pagedApps.length === 0 && (
              <div className="flex w-full items-center px-3 py-2.5">
                <div className="flex h-8 w-full items-center justify-center text-xs text-muted-foreground">
                  {q ? t('wm.noAppsFound') : t('appMenu.allHidden')}
                </div>
              </div>
            )}
            {pagedApps.map((item) => {
              if (item.kind === 'plugin') {
                const p = item.plugin;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectPlugin(p.id)}
                    className={appRow}
                  >
                    <AppIcon id={p.id} label={p.label} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-popover-foreground">{p.label}</div>
                      {p.description && (
                        <div className="text-[11px] text-muted-foreground">{p.description}</div>
                      )}
                    </div>
                    <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 opacity-40" />
                  </button>
                );
              }
              const c = item.config;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectPlugin(c.pluginId, item.params ?? c.params)}
                  className={appRow}
                >
                  <AppIcon id={c.id} label={c.label} pluginId={c.pluginId} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-popover-foreground">{c.label}</div>
                    {c.description && (
                      <div className="text-[11px] text-muted-foreground">{c.description}</div>
                    )}
                  </div>
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 opacity-40" />
                </button>
              );
            })}
            {/* The list always reserves APP_PAGE_SIZE rows: a short page, a
                single-page search result, and the empty state all pad out
                with inert slots (the empty-state message counts as one row),
                and the pager row below is always mounted — so the dialog keeps
                the same height while searching or paging. Slots are plain
                divs, so arrow-key navigation skips them. */}
            {pagedApps.length < APP_PAGE_SIZE &&
              Array.from({ length: APP_PAGE_SIZE - Math.max(pagedApps.length, 1) }, (_, i) => (
                <div
                  key={`slot-${i}`}
                  aria-hidden="true"
                  className="flex w-full items-center gap-3 px-3 py-2.5"
                >
                  <div className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 flex-1" />
                </div>
              ))}
            {/* Back/Next are ordinary rows in the list: arrow keys reach them
                and Enter activates them. They stay mounted even on a single
                page (dimmed + guarded instead of `disabled`) so the dialog
                height never changes with the search or page count, and
                keyboard focus is never dropped when a page change would
                disable one of them. */}
            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
              <button
                type="button"
                aria-label={t('wm.pageBack')}
                onClick={() => {
                  if (safePage > 0) setPage(safePage - 1);
                }}
                className={`${pagerBtn} ${safePage === 0 ? 'opacity-30' : ''}`}
              >
                {t('wm.pageBack')}
              </button>
              <span aria-live="polite" className="text-[11px] text-muted-foreground">
                {safePage + 1} / {pageCount}
              </span>
              <button
                type="button"
                aria-label={t('wm.pageNext')}
                onClick={() => {
                  if (safePage < pageCount - 1) setPage(safePage + 1);
                }}
                className={`${pagerBtn} ${safePage >= pageCount - 1 ? 'opacity-30' : ''}`}
              >
                {t('wm.pageNext')}
              </button>
            </div>
          </div>
        </nav>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A tiling window-manager-style page: a tree of panes rendered as
 * same-origin iframes (each loading the content of its registered tile
 * plugin), with split / close / focus / resize controls.
 *
 * Rendering detail that matters: panes are NOT nested flex boxes mirroring
 * the layout tree — they are a flat list keyed by leaf id and positioned
 * absolutely from rects computed by `computeTiling`. Splitting or closing
 * then only mutates inline styles; an iframe's DOM node is never recreated
 * or reparented, so its PTY session survives layout changes.
 */
/**
 * True when a postMessage `source` is one of the tile iframes this WM owns.
 *
 * Tile messages (focus, shortcuts, close, open-file) are only trustworthy when
 * they come from a direct child iframe carrying `data-pane`. A sandboxed
 * extension runs one frame deeper on an opaque origin, so an extension that
 * posts straight at the shell has a `source` that fails this check — which is
 * what lets us relay focus/keys from extensions without also letting them
 * impersonate panes.
 */
