/**
 * Remote folder browser for the job editor. Lists server directories through
 * /api/files (same source as the file browser) and accepts a typed path.
 *
 * The two are one control: the loaded directory is the single source of truth.
 * Clicking a folder, going up, or typing a path all end up in `load()`, which
 * refreshes the listing, the current-path label and the text field together.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listRemoteDirs,
  fetchRemoteHome,
  type RemoteDirEntry,
} from '../../lib/foldersync/remoteApi';
import { btnPrimary, inputClass } from './styles';

/** Debounce before a typed path is fetched, so a request is not sent per key. */
const TYPED_PATH_DEBOUNCE_MS = 300;

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

export function RemoteDirPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [home, setHome] = useState('');
  const [dirs, setDirs] = useState<RemoteDirEntry[]>([]);
  const [manual, setManual] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Last path we asked the server for — keeps typing from re-requesting it. */
  const attemptedRef = useRef<string | null>(null);

  /**
   * Navigates to a directory and syncs every surface: the listing, the
   * current-path label, the text field, and the job draft. A failed path
   * leaves the field alone (the user keeps what they typed) and reports,
   * unless it was an automatic follow of the text field — mid-typing an
   * intermediate path must not flash an error.
   */
  const load = useCallback(
    async (dir: string, options?: { silent?: boolean }) => {
      const target = dir.trim();
      if (!target) return;
      attemptedRef.current = target;
      setLoading(true);
      setError(null);
      try {
        setDirs(await listRemoteDirs(target));
        setCurrent(target);
        setManual(target);
        onChange(target);
      } catch (err) {
        setDirs([]);
        if (!options?.silent) {
          setError(err instanceof Error ? err.message : t('foldersync.pickerError'));
        }
      } finally {
        setLoading(false);
      }
    },
    [onChange, t],
  );

  // Runs once per mount (the panel remounts this picker each time the job
  // editor opens). A preset folder wins; otherwise the browser opens at the
  // backend user's home and the field is prefilled with it, so saving a fresh
  // job never depends on an extra click.
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      let start = '/';
      try {
        start = await fetchRemoteHome();
      } catch {
        start = '/';
      }
      if (cancelled) return;
      setHome(start);
      await load(value || start);
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the text field: navigate once the user stops typing. A path we have
  // already requested is skipped, so this never loops after a successful load.
  useEffect(() => {
    const typed = manual.trim();
    if (!typed || typed === attemptedRef.current) return;
    const timer = setTimeout(() => {
      void load(typed, { silent: true });
    }, TYPED_PATH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [manual, load]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="shrink-0 rounded-lg bg-white/[0.08] px-2 py-1.5 text-xs text-white/70 transition-all duration-150 hover:bg-white/[0.14] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
          onClick={() => void load(parentPath(current))}
          disabled={!current}
        >
          {t('foldersync.pickerUp')}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/45">
          {loading || !current ? t('foldersync.loading') : current}
        </span>
      </div>

      <div className="max-h-40 overflow-y-auto rounded-lg border border-white/[0.08] bg-black/20 scrollbar-thin">
        {dirs.length === 0 && !loading && !error && (
          <div className="px-2.5 py-2 text-[11px] text-white/30">{t('foldersync.pickerEmpty')}</div>
        )}
        {dirs.map((entry) => (
          <button
            key={entry.name}
            type="button"
            className="block w-full truncate px-2.5 py-1.5 text-left font-mono text-xs text-white/70 transition-colors duration-150 hover:bg-white/[0.06]"
            onClick={() => void load(joinPath(current, entry.name))}
          >
            {entry.name}/
          </button>
        ))}
      </div>

      {error && <span className="text-[11px] text-red-400/85">{error}</span>}

      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          value={manual}
          placeholder={home}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            // A fresh edit re-arms the follow-the-field navigation, even if it
            // matches a path that failed before.
            attemptedRef.current = null;
            setManual(e.target.value);
            onChange(e.target.value);
          }}
        />
        <button
          type="button"
          className={btnPrimary}
          onClick={() => void load(manual)}
          disabled={!manual.trim()}
        >
          {t('foldersync.pickerUse')}
        </button>
      </div>
    </div>
  );
}
