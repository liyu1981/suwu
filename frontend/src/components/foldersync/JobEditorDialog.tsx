/**
 * Create / edit dialog for one sync job: server folder, local folder (picked
 * through the OS dialog), cycle interval, and the `removeExtra` mirror toggle.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { pickDirectory, supportsLocalFs } from '../../lib/foldersync/fs-access';
import { newHandleId, saveHandle } from '../../lib/foldersync/handleStore';
import {
  DEFAULT_INTERVAL_MS,
  INTERVAL_OPTIONS,
  type SyncJobConfig,
} from '../../lib/foldersync/types';
import { RemoteDirPicker } from './RemoteDirPicker';
import { btnGhost, btnPrimary, inputClass, sectionLabel } from './styles';

interface Props {
  open: boolean;
  /** null → create a new job. */
  job: SyncJobConfig | null;
  /** Pre-filled values for a new job (e.g. a custom app's URL params). */
  defaults?: Partial<SyncJobConfig>;
  onClose: () => void;
  onSave: (job: SyncJobConfig) => void;
}

interface Draft {
  name: string;
  remotePath: string;
  dirId: string;
  localDirName: string;
  intervalMs: number;
  removeExtra: boolean;
  /** Handle picked in this session, stored on save. */
  pending: FileSystemDirectoryHandle | null;
}

function draftFrom(job: SyncJobConfig | null, defaults?: Partial<SyncJobConfig>): Draft {
  if (!job) {
    return {
      name: defaults?.name ?? '',
      remotePath: defaults?.remotePath ?? '',
      dirId: newHandleId(),
      localDirName: defaults?.localDirName ?? '',
      intervalMs: defaults?.intervalMs ?? DEFAULT_INTERVAL_MS,
      removeExtra: defaults?.removeExtra ?? true,
      pending: null,
    };
  }
  return {
    name: job.name,
    remotePath: job.remotePath,
    dirId: job.dirId,
    localDirName: job.localDirName,
    intervalMs: job.intervalMs,
    removeExtra: job.removeExtra,
    pending: null,
  };
}

export function JobEditorDialog({ open, job, defaults, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(job, defaults));
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(draftFrom(job, defaults));
      setError(null);
    }
  }, [open, job, defaults]);

  const pickFolder = async () => {
    setPicking(true);
    setError(null);
    try {
      const handle = await pickDirectory(draft.dirId);
      if (!handle) return; // cancelled
      setDraft((prev) => ({ ...prev, pending: handle, localDirName: handle.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('foldersync.pickFailed'));
    } finally {
      setPicking(false);
    }
  };

  const canSave =
    draft.remotePath.trim().startsWith('/') &&
    (draft.pending !== null || draft.localDirName !== '');

  const save = async () => {
    if (!canSave) return;
    const remotePath = draft.remotePath.trim();
    if (draft.pending) {
      const stored = await saveHandle(draft.dirId, draft.pending);
      if (!stored) {
        setError(t('foldersync.handleStoreFailed'));
        return;
      }
    }
    onSave({
      id: job?.id ?? newHandleId(),
      name: draft.name.trim() || remotePath.split('/').filter(Boolean).pop() || remotePath,
      remotePath,
      dirId: draft.dirId,
      localDirName: draft.localDirName,
      intervalMs: draft.intervalMs,
      removeExtra: draft.removeExtra,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[min(94vw,30rem)]">
        <DialogTitle>{job ? t('foldersync.editJob') : t('foldersync.addJob')}</DialogTitle>

        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={sectionLabel}>{t('foldersync.fieldName')}</span>
            <input
              className={inputClass}
              value={draft.name}
              placeholder={t('foldersync.fieldNamePlaceholder')}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className={sectionLabel}>{t('foldersync.fieldRemote')}</span>
            <RemoteDirPicker
              value={draft.remotePath}
              onChange={(remotePath) => setDraft((prev) => ({ ...prev, remotePath }))}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={sectionLabel}>{t('foldersync.fieldLocal')}</span>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-lg border border-white/[0.12] bg-white/[0.05] px-2.5 py-1.5 text-sm text-white/75">
                {draft.localDirName || t('foldersync.fieldLocalEmpty')}
              </span>
              <button
                type="button"
                className={btnPrimary}
                onClick={() => void pickFolder()}
                disabled={picking || !supportsLocalFs()}
              >
                {picking ? t('foldersync.loading') : t('foldersync.chooseFolder')}
              </button>
            </div>
            <span className="text-[11px] text-white/35">{t('foldersync.localHint')}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={sectionLabel}>{t('foldersync.fieldInterval')}</span>
            <div className="flex shrink-0 overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.04]">
              {INTERVAL_OPTIONS.map((ms) => (
                <button
                  key={ms}
                  type="button"
                  className={`px-2.5 py-1 text-xs font-semibold transition-all duration-150 ${
                    draft.intervalMs === ms
                      ? 'bg-fuchsia-500/20 text-fuchsia-200'
                      : 'text-white/45 hover:bg-white/[0.08] hover:text-white/65'
                  }`}
                  onClick={() => setDraft((prev) => ({ ...prev, intervalMs: ms }))}
                >
                  {ms / 1000}s
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className={sectionLabel}>{t('foldersync.fieldRemoveExtra')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.removeExtra}
                onClick={() => setDraft((prev) => ({ ...prev, removeExtra: !prev.removeExtra }))}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ${
                  draft.removeExtra ? 'bg-fuchsia-500/50' : 'bg-white/[0.12]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150 ${
                    draft.removeExtra ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </button>
            </div>
            {draft.removeExtra && (
              <span className="text-[11px] text-amber-300/70">
                {t('foldersync.removeExtraWarn')}
              </span>
            )}
          </div>

          {error && <span className="text-[11px] text-red-400/85">{error}</span>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            {t('foldersync.cancel')}
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => void save()}
            disabled={!canSave}
          >
            {t('foldersync.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
