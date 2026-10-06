/**
 * Remote folder browser for the job editor. Lists server directories through
 * /api/files (same source as the file browser) and accepts a typed path.
 *
 * Clicking a folder, going up, using a path, or opening the editor all
 * navigate via `load()`, which makes the directory the single source of truth
 * for the listing, the current-path label and the text field. Typing is
 * different: the text is a path *prefix*, so it filters the parent by the last
 * segment (`suggest()`) instead of requiring the typed path to already exist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listRemoteDirs,
  fetchRemoteHome,
  type RemoteDirEntry,
} from '../../lib/foldersync/remoteApi';
import { joinPath, parentPath, splitPrefix } from '../../lib/foldersync/remotePath';
import { btnPrimary, inputClass } from './styles';

/** Debounce before a typed path is fetched, so a request is not sent per key. */
const TYPED_PATH_DEBOUNCE_MS = 300;

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
  const attemptedRef = useRef<string | null>(value.trim() || null);
  /** Monotonic id so a slow response cannot overwrite a newer one. */
  const requestSeq = useRef(0);

  /**
   * Navigates to a directory and syncs every surface: the listing, the
   * current-path label, the text field, and the job draft. A failed path
   * leaves the field alone (the user keeps what they typed) and reports.
   * Mid-typing misses go through `suggest()` instead and stay silent.
   */
  const load = useCallback(
    async (dir: string) => {
      const target = dir.trim();
      if (!target) return;
      attemptedRef.current = target;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const entries = await listRemoteDirs(target);
        if (seq !== requestSeq.current) return;
        setDirs(entries);
        setCurrent(target);
        setManual(target);
        onChange(target);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setDirs([]);
        setError(err instanceof Error ? err.message : t('foldersync.pickerError'));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
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

  // Follow the text field: after the user stops typing, list the directories
  // that match what they typed as a path *prefix*. The typed value need not be
  // an existing directory — typing "/home/yli/single" lists its parent and
  // keeps every entry whose name starts with "single" (so "single-store",
  // "singleton", … appear). A trailing slash means "open this directory".
  // Explicit actions (clicking an entry, Up, Use, initial open) still navigate
  // through load(). Silent: mid-typing misses must not flash an error.
  const suggest = useCallback(async (typed: string) => {
    attemptedRef.current = typed;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    const { dir, prefix } = splitPrefix(typed);
    try {
      const entries = await listRemoteDirs(dir);
      if (seq !== requestSeq.current) return;
      setDirs(prefix ? entries.filter((e) => e.name.startsWith(prefix)) : entries);
      setCurrent(dir);
    } catch {
      if (seq !== requestSeq.current) return;
      setDirs([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const typed = manual.trim();
    if (!typed || typed === attemptedRef.current) return;
    const timer = setTimeout(() => {
      // Re-check at fire time: the initial load() may have handled this path
      // (and set attemptedRef) while the debounce was pending.
      if (attemptedRef.current === typed) return;
      void suggest(typed);
    }, TYPED_PATH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [manual, suggest]);

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
