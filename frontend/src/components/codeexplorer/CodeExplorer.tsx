import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { useTileSessionState } from '../CommonTileContainer';
import { OpenFileDialog } from './OpenFileDialog';
import { SearchOccurrencesDialog } from './SearchOccurrencesDialog';
import { useOccurrenceSearch } from './useOccurrenceSearch';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';
import { parseFileSpecs } from './spec';
import { useCodeExplorer } from './useCodeExplorer';
import { authFetch } from '../../lib/api';
import { fileBrowserBgAtom } from '../../store/appearance';
import type { CodeFileSpec } from '../../store/notifications';
import type { CodeExplorerSessionState } from '../../wm/sessionState';

/** Multi-tab Monaco editor with optional gutter marks and explicit saving. */
export function CodeExplorer() {
  const { t } = useTranslation();
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialSpecs = useMemo<CodeFileSpec[]>(
    () => parseFileSpecs(urlParams.get('files')),
    [urlParams],
  );
  // Tile default directory handed over by `suwu code`: the first file's base
  // directory, or the directory itself for `suwu code <dir>`.
  const tileDefaultDir = useMemo(() => {
    const raw = urlParams.get('dir');
    return raw && raw.startsWith('/') ? raw : null;
  }, [urlParams]);
  const saved = useTileSessionState<CodeExplorerSessionState>();
  const restoreSpecs = useMemo<CodeFileSpec[]>(
    () => (saved?.tabs ?? []).map((tab) => ({ path: tab.path, ranges: tab.ranges })),
    [saved],
  );

  const explorer = useCodeExplorer(initialSpecs, restoreSpecs);
  const search = useOccurrenceSearch(explorer.searchSelection);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const background = useAtomValue(fileBrowserBgAtom);

  useEffect(() => {
    if (explorer.openSignal > 0) setDialogOpen(true);
  }, [explorer.openSignal]);

  // Fall back to the home directory when the tile has no default directory.
  useEffect(() => {
    if (tileDefaultDir) return;
    authFetch('/api/home', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.path) setHomeDir(data.path);
      })
      .catch(() => {});
  }, [tileDefaultDir]);

  const activeTab = explorer.tabs.find((tab) => tab.id === explorer.activeId) ?? null;
  const activeError = explorer.activeId ? explorer.errors[explorer.activeId] : undefined;
  const anyDirty = Object.values(explorer.dirty).some(Boolean);

  // Start the open/new-file dialog in the active file's folder.
  const activeDir = useMemo(() => {
    const path = activeTab?.path;
    if (!path) return null;
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? '/' : path.slice(0, idx);
  }, [activeTab?.path]);

  // Search starts in the active file's directory, then the tile default
  // directory, then home.
  const searchDir = activeDir ?? tileDefaultDir ?? homeDir;
  const openSearch = () => {
    if (searchDir) search.openSearch(searchDir, '');
  };

  useEffect(() => {
    if (explorer.searchSignal > 0) openSearch();
  }, [explorer.searchSignal]);

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden"
      style={{ backgroundColor: background }}
    >
      <TabBar
        tabs={explorer.tabs}
        activeId={explorer.activeId}
        dirty={explorer.dirty}
        onSelect={explorer.setActive}
        onClose={explorer.closeTab}
        onOpen={() => setDialogOpen(true)}
        onSearch={openSearch}
      />

      {(activeError || activeTab?.readOnly) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/5 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-200">
          <span className="min-w-0 truncate">{activeError ?? t('codeExplorer.readOnly')}</span>
          {activeTab && !activeTab.isNew && (
            <button
              type="button"
              onClick={() => explorer.reload()}
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              {t('codeExplorer.reload')}
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-transparent">
        <div ref={explorer.containerRef} className="absolute inset-0" />
        {explorer.tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40">
            <span className="text-sm">{t('codeExplorer.noFiles')}</span>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="glass-btn rounded-md bg-white/10 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/15"
            >
              {t('codeExplorer.openFile')}
            </button>
          </div>
        )}
      </div>

      {search.hasSearch && (
        <div className="flex shrink-0 justify-end border-t border-white/5 px-2 py-1">
          <button
            type="button"
            onClick={search.reopen}
            className="glass-btn rounded px-2 py-1 text-xs text-white/70"
          >
            {t('codeExplorer.search.showResults')}
          </button>
        </div>
      )}

      <SearchOccurrencesDialog
        search={search}
        onNavigate={explorer.openLocation}
        onRestoreFocus={explorer.focusEditor}
      />

      <StatusBar
        path={activeTab?.path ?? null}
        language={activeTab?.language ?? null}
        line={explorer.cursor.line}
        column={explorer.cursor.column}
        saving={explorer.saving}
        anyDirty={anyDirty}
        savedAt={explorer.savedAt}
        canReload={!!activeTab && !activeTab.isNew}
        onSave={() => explorer.save()}
        onReload={() => explorer.reload()}
      />

      {dialogOpen && (
        <OpenFileDialog
          defaultDir={activeDir ?? tileDefaultDir}
          onClose={() => setDialogOpen(false)}
          onOpenFile={(path) => void explorer.openPath(path)}
          onNewFile={explorer.openNewFile}
        />
      )}
    </div>
  );
}
