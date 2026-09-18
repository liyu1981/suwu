import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileIcon, FolderIcon } from '../icons';
import { authFetch } from '../../lib/api';

interface OpenFileDialogProps {
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onNewFile: (path: string) => void;
  /** Folder to start in (e.g. the active file's directory). Falls back to home. */
  defaultDir?: string | null;
}

interface DirEntry {
  name: string;
  isDir: boolean;
}

function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === '/' || dir === '') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Directory + file browser for opening an existing file or creating a new one. */
export function OpenFileDialog({
  onClose,
  onOpenFile,
  onNewFile,
  defaultDir,
}: OpenFileDialogProps) {
  const { t } = useTranslation();
  const [currentDir, setCurrentDir] = useState(defaultDir || '/');
  const [pathInput, setPathInput] = useState(defaultDir || '/');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (defaultDir) return;
    authFetch('/api/home', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.path) {
          setCurrentDir(data.path);
          setPathInput(data.path);
        }
      })
      .catch(() => {});
  }, [defaultDir]);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    authFetch(`/api/files?path=${encodeURIComponent(currentDir)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list: DirEntry[] = Array.isArray(data?.entries) ? data.entries : [];
        setEntries(
          list
            .filter((entry) => entry.name !== '.')
            .sort((a, b) =>
              a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
            ),
        );
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : 'Cannot read folder');
        setLoading(false);
      });
    return () => controller.abort();
  }, [currentDir, refreshKey]);

  const navigate = useCallback((path: string) => {
    setCurrentDir(path);
    setPathInput(path);
    setNewName('');
  }, []);

  const createFile = useCallback(() => {
    const name = newName.trim();
    if (!name || name.includes('/')) return;
    onNewFile(joinPath(currentDir, name));
    onClose();
  }, [currentDir, newName, onClose, onNewFile]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="glass-control menu-glass flex h-[75%] w-[min(92%,44rem)] flex-col gap-2 rounded-lg p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-base tracking-tight">{t('codeExplorer.openFile')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('codeExplorer.cancel')}
            className="grid h-6 w-6 place-items-center rounded text-white/50 transition hover:bg-white/10 hover:text-white"
          >
            <svg
              className="h-3.5 w-3.5"
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

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigate(parentPath(currentDir))}
            aria-label={t('codeExplorer.up')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.78 3.72a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 0 1-1.06 1.06L9 5.56v7.69a.75.75 0 0 1-1.5 0V5.56L5.03 8.53a.75.75 0 0 1-1.06-1.06l3.81-3.75z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            aria-label={t('codeExplorer.refresh')}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
          </button>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(pathInput.trim() || '/');
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white/80 outline-none placeholder:text-white/30 focus:border-white/25 focus:bg-white/10"
            placeholder="/path/to/folder"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-white/10 bg-black/30 scrollbar-thin">
          {loading ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
            </div>
          ) : error ? (
            <div className="p-4 text-[11px] text-red-300">{error}</div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-[11px] text-white/40">{t('codeExplorer.emptyFolder')}</div>
          ) : (
            <div className="divide-y divide-white/5">
              {entries.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  onClick={() =>
                    entry.isDir
                      ? navigate(joinPath(currentDir, entry.name))
                      : (onOpenFile(joinPath(currentDir, entry.name)), onClose())
                  }
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  {entry.isDir ? (
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-yellow-400/80" />
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-white/40" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createFile();
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white/80 outline-none placeholder:text-white/30 focus:border-white/25 focus:bg-white/10"
            placeholder={t('codeExplorer.newFileName')}
          />
          <button
            type="button"
            onClick={createFile}
            disabled={newName.trim() === '' || newName.includes('/')}
            className="glass-btn shrink-0 rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('codeExplorer.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
