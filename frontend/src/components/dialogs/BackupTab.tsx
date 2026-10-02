import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, CopyIcon, RefreshIcon, TrashIcon, UploadIcon } from '../icons';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import { authFetch } from '../../lib/api';
import {
  backupNow,
  changePassphrase,
  disable,
  enable,
  fetchAndDecrypt,
  getBackupConfig,
  getBackupStatus,
  isEnabled,
  listGenerations,
  resolveConflictOverwrite,
  restore,
  setCategories,
  setIntervalMs,
  subscribeBackup,
  previewRestore,
} from '../../lib/backup/client';
import type { RestoreMode } from '../../lib/backup/apply';
import type { BackupStatus, Category, Generation } from '../../lib/backup/types';

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3';
const sectionLabel = 'text-xs font-medium text-muted-foreground';
const sectionHint = 'mt-2 text-[11px] leading-relaxed text-muted-foreground';

const segBtn =
  'rounded px-2 py-1.5 text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60';

const smallBtn =
  'shrink-0 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none ' +
  'transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

const toggle =
  'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ' +
  'bg-white/15 data-[state=checked]:bg-sky-500/60';

const toggleThumb =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform ' +
  'data-[state=checked]:translate-x-4';

const field =
  'h-8 min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 text-xs ' +
  'text-popover-foreground outline-none transition-colors placeholder:text-muted-foreground ' +
  'focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30';

const dangerBtn =
  'shrink-0 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300 ' +
  'outline-none transition-colors hover:bg-red-500/20 focus-visible:ring-1 focus-visible:ring-red-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/** Renders a byte count compactly. */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "2 minutes ago", in the current locale. */
function formatAgo(timestamp: number | null): string {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Interval choices, in minutes. The cadence is a per-device setting. */
const INTERVAL_CHOICES = [1, 5, 15, 30, 60];

interface Props {
  /** Called after a restore so the shell can reload and re-read its state. */
  onRestored?: () => void;
}

export function BackupTab({ onRestored }: Props) {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(() => isEnabled());
  const [config, setConfig] = useState(() => getBackupConfig());
  const [status, setStatus] = useState<BackupStatus>(() => getBackupStatus());
  const [generations, setGenerations] = useState<Generation[]>([]);

  // Passphrase entry: 'enable' shows the setup form, 'change' re-wraps.
  const [passphraseMode, setPassphraseMode] = useState<'idle' | 'enable' | 'change'>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [oldPassphrase, setOldPassphrase] = useState('');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSlot, setShowSlot] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  // Restore flow.
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [selectedGen, setSelectedGen] = useState<number | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');

  useEffect(() => subscribeBackup(setStatus), []);

  // Refresh the generation list when the tab becomes enabled.
  useEffect(() => {
    if (!enabled) {
      setGenerations([]);
      return;
    }
    void listGenerations()
      .then(setGenerations)
      .catch(() => setGenerations([]));
  }, [enabled, status.gen]);

  const intervalMinutes = Math.round(config.intervalMs / 60000);

  const refreshConfig = useCallback(() => setConfig(getBackupConfig()), []);

  const doEnable = async () => {
    setError(null);
    if (passphrase !== passphrase2) {
      setError(t('settings.backupPassphraseMismatch'));
      return;
    }
    setBusy(true);
    try {
      await enable(passphrase);
      setPassphrase('');
      setPassphrase2('');
      setPassphraseMode('idle');
      setEnabled(true);
      refreshConfig();
      await backupNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doChangePassphrase = async () => {
    setError(null);
    if (passphrase !== passphrase2) {
      setError(t('settings.backupPassphraseMismatch'));
      return;
    }
    setBusy(true);
    try {
      await changePassphrase(oldPassphrase, passphrase);
      setOldPassphrase('');
      setPassphrase('');
      setPassphrase2('');
      setPassphraseMode('idle');
      setNotice(t('settings.backupPassphraseChanged'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDisable = async (wipeServer: boolean) => {
    setBusy(true);
    try {
      await disable(wipeServer);
      setEnabled(false);
      setConfirmWipe(false);
      setGenerations([]);
      setNotice(wipeServer ? t('settings.backupDisabledWiped') : t('settings.backupDisabled'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doBackupNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await backupNow();
      if (next.error) setError(next.error);
      setGenerations(await listGenerations().catch(() => generations));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async () => {
    if (selectedGen === null) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await fetchAndDecrypt(selectedGen, restorePassphrase);
      const summary = await previewRestore(payload, restoreMode);
      const confirmed = window.confirm(
        `${t('settings.backupRestoreSummary', {
          settings: summary.settings,
          extensions: summary.extensions.length,
          layout: summary.layout,
          changed: summary.changed,
          removed: summary.localOnly,
        })}`,
      );
      if (!confirmed) return;
      const report = await restore(payload, restoreMode);
      setNotice(
        t('settings.backupRestored', {
          applied: report.applied,
          skipped: report.skippedLocalNewer,
        }),
      );
      setRestorePassphrase('');
      onRestored?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    const gen = status.gen ?? generations[0]?.gen;
    if (gen === undefined) return;
    setBusy(true);
    setError(null);
    try {
      // Downloading the newest generation as a file is the user's own copy:
      // it works with the server down and survives a lost disk.
      const res = await authFetch(`/api/backup/blob?slot=${config.slot}&gen=${gen}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`export failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `suwu-backup-g${gen}.bin`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = (category: Category, on: boolean) => {
    const next = on
      ? [...config.categories, category]
      : config.categories.filter((c) => c !== category);
    setCategories(next);
    refreshConfig();
  };

  const statusLine = useMemo(() => {
    if (status.phase === 'backing-up') return t('settings.backupStatusBackingUp');
    if (status.conflict) return t('settings.backupStatusConflict');
    if (status.error) return t('settings.backupStatusError', { error: status.error });
    if (status.lastBackupAt) {
      return t('settings.backupStatusOk', {
        ago: formatAgo(status.lastBackupAt),
        gen: status.gen,
        size: formatBytes(status.size),
      });
    }
    return t('settings.backupStatusWaiting');
  }, [status, t]);

  const maskedSlot = config.slot ? `${config.slot.slice(0, 4)}·····${config.slot.slice(-4)}` : '';

  return (
    <div className="min-w-0 flex-1">
      {/* ── disabled (the default) ─────────────────────────────────────── */}
      {!enabled && (
        <>
          <div className={section}>
            <span className={sectionLabel}>{t('settings.backupTitle')}</span>
            <p className={sectionHint}>{t('settings.backupIntro')}</p>
            <button
              type="button"
              className={`${smallBtn} mt-3 inline-flex items-center gap-1.5`}
              onClick={() => setPassphraseMode('enable')}
              disabled={busy}
            >
              <UploadIcon className="h-3.5 w-3.5" />
              {t('settings.backupEnable')}
            </button>
          </div>

          {passphraseMode === 'enable' && (
            <div className={`${section} mt-4`}>
              <span className={sectionLabel}>{t('settings.backupPassphraseTitle')}</span>
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={t('settings.backupPassphrasePlaceholder')}
                  aria-label={t('settings.backupPassphraseTitle')}
                  autoComplete="new-password"
                  className={`${field} w-full`}
                />
                <input
                  type="password"
                  value={passphrase2}
                  onChange={(e) => setPassphrase2(e.target.value)}
                  placeholder={t('settings.backupPassphraseRepeat')}
                  aria-label={t('settings.backupPassphraseRepeat')}
                  autoComplete="new-password"
                  className={`${field} w-full`}
                />
              </div>
              <p className={sectionHint}>{t('settings.backupPassphraseWarning')}</p>
              {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className={`${smallBtn} bg-sky-500/20 text-sky-200`}
                  onClick={doEnable}
                  disabled={busy || passphrase.length < 8}
                >
                  {t('settings.backupTurnOn')}
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => {
                    setPassphraseMode('idle');
                    setError(null);
                  }}
                  disabled={busy}
                >
                  {t('settings.backupCancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── enabled ────────────────────────────────────────────────────── */}
      {enabled && (
        <>
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.backupTitle')}</span>
              <span className="text-[10px] tracking-wider text-muted-foreground">
                {t('settings.backupStatusLabel')}
              </span>
            </div>
            <p className="mt-2 text-xs text-popover-foreground" aria-live="polite">
              {statusLine}
            </p>

            {status.conflict && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className={smallBtn}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await resolveConflictOverwrite();
                      setNotice(t('settings.backupConflictOverwritten'));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  {t('settings.backupConflictOverwrite')}
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => void doRestore()}
                  disabled={busy || selectedGen === null}
                >
                  {t('settings.backupConflictRestore')}
                </button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={`${smallBtn} inline-flex items-center gap-1.5`}
                onClick={doBackupNow}
                disabled={busy}
              >
                <RefreshIcon className="h-3.5 w-3.5" />
                {t('settings.backupNow')}
              </button>
              <button type="button" className={smallBtn} onClick={doExport} disabled={busy}>
                {t('settings.backupExport')}
              </button>
            </div>
            {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
            {notice && <p className="mt-2 text-[11px] text-emerald-300">{notice}</p>}
          </div>

          {/* Recovery code */}
          <div className={`${section} mt-4`}>
            <span className={sectionLabel}>{t('settings.backupSlotTitle')}</span>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-black/30 px-2 py-1.5 font-mono text-xs text-popover-foreground">
                {showSlot ? config.slot : maskedSlot}
              </code>
              <button
                type="button"
                className={smallBtn}
                onClick={() => setShowSlot((v) => !v)}
                disabled={busy}
              >
                {showSlot ? t('settings.backupSlotHide') : t('settings.backupSlotShow')}
              </button>
              <button
                type="button"
                className={smallBtn}
                onClick={() => {
                  void navigator.clipboard?.writeText(config.slot);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                disabled={busy}
              >
                {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                {copied ? t('settings.backupCopied') : t('settings.backupCopy')}
              </button>
            </div>
            <p className={sectionHint}>{t('settings.backupSlotHint')}</p>
          </div>

          {/* Passphrase */}
          <div className={`${section} mt-4`}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.backupPassphraseTitle')}</span>
              {passphraseMode !== 'change' && (
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => setPassphraseMode('change')}
                  disabled={busy}
                >
                  {t('settings.backupPassphraseChange')}
                </button>
              )}
            </div>
            {passphraseMode === 'change' ? (
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  value={oldPassphrase}
                  onChange={(e) => setOldPassphrase(e.target.value)}
                  placeholder={t('settings.backupPassphraseOld')}
                  aria-label={t('settings.backupPassphraseOld')}
                  autoComplete="current-password"
                  className={`${field} w-full`}
                />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={t('settings.backupPassphrasePlaceholder')}
                  aria-label={t('settings.backupPassphraseTitle')}
                  autoComplete="new-password"
                  className={`${field} w-full`}
                />
                <input
                  type="password"
                  value={passphrase2}
                  onChange={(e) => setPassphrase2(e.target.value)}
                  placeholder={t('settings.backupPassphraseRepeat')}
                  aria-label={t('settings.backupPassphraseRepeat')}
                  autoComplete="new-password"
                  className={`${field} w-full`}
                />
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className={`${smallBtn} bg-sky-500/20 text-sky-200`}
                    onClick={doChangePassphrase}
                    disabled={busy || passphrase.length < 8}
                  >
                    {t('settings.backupPassphraseSave')}
                  </button>
                  <button
                    type="button"
                    className={smallBtn}
                    onClick={() => {
                      setPassphraseMode('idle');
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    {t('settings.backupCancel')}
                  </button>
                </div>
              </div>
            ) : (
              <p className={sectionHint}>{t('settings.backupPassphraseSet')}</p>
            )}
          </div>

          {/* Categories */}
          <div className={`${section} mt-4`}>
            <span className={sectionLabel}>{t('settings.backupCategories')}</span>
            <div className="mt-2 space-y-2">
              {(
                [
                  ['settings', t('settings.backupCategorySettings')],
                  ['ext', t('settings.backupCategoryExt')],
                  ['layout', t('settings.backupCategoryLayout')],
                ] as Array<[Category, string]>
              ).map(([category, label]) => (
                <label key={category} className="flex cursor-pointer items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={config.categories.includes(category)}
                    aria-label={label}
                    className={toggle}
                    onClick={() => toggleCategory(category, !config.categories.includes(category))}
                    disabled={busy}
                  >
                    <span
                      className={`${toggleThumb} ${config.categories.includes(category) ? '' : 'translate-x-0'}`}
                      data-state={config.categories.includes(category) ? 'checked' : 'unchecked'}
                    />
                  </button>
                  <span className="text-xs text-popover-foreground">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Interval */}
          <div className={`${section} mt-4`}>
            <span className={sectionLabel}>{t('settings.backupInterval')}</span>
            <div className="mt-2">
              <Select
                value={String(intervalMinutes)}
                onValueChange={(v) => {
                  setIntervalMs(Number(v) * 60 * 1000);
                  refreshConfig();
                }}
              >
                <SelectTrigger aria-label={t('settings.backupInterval')}>
                  <span>{t('settings.backupEvery', { minutes: intervalMinutes })}</span>
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_CHOICES.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {t('settings.backupEvery', { minutes })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className={sectionHint}>{t('settings.backupIntervalHint')}</p>
          </div>

          {/* Restore */}
          <div className={`${section} mt-4`}>
            <span className={sectionLabel}>{t('settings.backupRestore')}</span>
            <div className="mt-2 space-y-2">
              <Select
                value={selectedGen === null ? '' : String(selectedGen)}
                onValueChange={(v) => setSelectedGen(Number(v))}
              >
                <SelectTrigger aria-label={t('settings.backupRestoreFrom')}>
                  <span>
                    {selectedGen === null
                      ? t('settings.backupRestorePick')
                      : t('settings.backupGeneration', { gen: selectedGen })}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {generations.length === 0 && (
                    <SelectItem value="" disabled>
                      {t('settings.backupNoGenerations')}
                    </SelectItem>
                  )}
                  {generations.map((g) => (
                    <SelectItem key={g.gen} value={String(g.gen)}>
                      {t('settings.backupGeneration', { gen: g.gen })} · {formatBytes(g.size)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  role="radio"
                  aria-checked={restoreMode === 'merge'}
                  className={`${segBtn} ${restoreMode === 'merge' ? 'bg-white/10' : ''}`}
                  onClick={() => setRestoreMode('merge')}
                >
                  {t('settings.backupModeMerge')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={restoreMode === 'replace'}
                  className={`${segBtn} ${restoreMode === 'replace' ? 'bg-white/10' : ''}`}
                  onClick={() => setRestoreMode('replace')}
                >
                  {t('settings.backupModeReplace')}
                </button>
              </div>

              <input
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                placeholder={t('settings.backupPassphrasePlaceholder')}
                aria-label={t('settings.backupPassphraseTitle')}
                autoComplete="current-password"
                className={`${field} w-full`}
              />

              <button
                type="button"
                className={`${smallBtn} inline-flex items-center gap-1.5`}
                onClick={doRestore}
                disabled={busy || selectedGen === null || restorePassphrase.length < 8}
              >
                <RefreshIcon className="h-3.5 w-3.5" />
                {t('settings.backupRestoreNow')}
              </button>
            </div>
            <p className={sectionHint}>{t('settings.backupRestoreHint')}</p>
          </div>

          {/* Forget */}
          <div className={`${section} mt-4`}>
            <span className={sectionLabel}>{t('settings.backupForgetTitle')}</span>
            <p className={sectionHint}>{t('settings.backupForgetHint')}</p>
            {confirmWipe ? (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className={`${dangerBtn} inline-flex items-center gap-1.5`}
                  onClick={() => doDisable(true)}
                  disabled={busy}
                >
                  <TrashIcon className="h-3 w-3" />
                  {t('settings.backupForgetConfirm')}
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => setConfirmWipe(false)}
                  disabled={busy}
                >
                  {t('settings.backupCancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${dangerBtn} mt-3 inline-flex items-center gap-1.5`}
                onClick={() => setConfirmWipe(true)}
                disabled={busy}
              >
                <TrashIcon className="h-3 w-3" />
                {t('settings.backupForget')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
