/**
 * Folder Sync tile panel.
 *
 * Manages the jobs (which server folder mirrors into which local folder),
 * starts/stops their engines, and shows the selected job's cycle stats and
 * activity log. Engine state is in memory only — closing the tile stops every
 * running job, and a reload brings each job back idle.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  CommonTileContainer,
  useReportTileState,
  useTileSessionState,
} from '../CommonTileContainer';
import { folderSyncZoomAtom } from '../../store/zoom';
import { folderSyncAtom } from '../../store/foldersync';
import { getEngine, stopAllEngines } from '../../lib/foldersync/engine';
import { supportsLocalFs } from '../../lib/foldersync/fs-access';
import type { JobRuntimeState, StartOutcome, SyncJobConfig } from '../../lib/foldersync/types';
import { formatSize } from '../../lib/format';
import { ActivityLog } from './ActivityLog';
import { JobEditorDialog } from './JobEditorDialog';
import { StatusChip } from './StatusChip';
import { btnDanger, btnGhost, btnPrimary, btnRow, sectionLabel } from './styles';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import type { FolderSyncSessionState } from '../../wm/sessionState';

const IDLE_STATE: JobRuntimeState = {
  jobId: '',
  status: 'idle',
  cycle: 0,
  running: false,
  progress: null,
  stats: null,
  errorCode: null,
  log: [],
};

/**
 * One subscription per job so every row (not just the selected one) shows its
 * live status. Engines live only as long as this tile, so the unsubscribe
 * cleanup on unmount is what stops the loops.
 */
function useJobStates(jobs: SyncJobConfig[]): Record<string, JobRuntimeState> {
  const [states, setStates] = useState<Record<string, JobRuntimeState>>({});
  useEffect(() => {
    const unsubscribes = jobs.map((job) =>
      getEngine(job).subscribe((next) => {
        setStates((prev) => ({ ...prev, [job.id]: next }));
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [jobs]);
  return states;
}

export function FolderSyncPanel() {
  const { t } = useTranslation();
  const [store, setStore] = useAtom(folderSyncAtom);
  const jobs = store.jobs;
  const saved = useTileSessionState<FolderSyncSessionState>();
  const reportState = useReportTileState();

  const [selectedId, setSelectedId] = useState<string | null>(saved?.selectedJobId ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SyncJobConfig | null>(null);
  const [mismatchJob, setMismatchJob] = useState<SyncJobConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );
  const states = useJobStates(jobs);
  const state = (selected ? states[selected.id] : undefined) ?? IDLE_STATE;

  // Keep a selection alive as jobs come and go.
  useEffect(() => {
    if (selectedId && !jobs.some((job) => job.id === selectedId)) setSelectedId(null);
    if (!selectedId && jobs.length > 0) setSelectedId(jobs[0].id);
  }, [jobs, selectedId]);

  useEffect(() => {
    reportState({ selectedJobId: selectedId ?? undefined });
  }, [selectedId, reportState]);

  // Sync only runs while this tile is alive: the last unmount tears the
  // registry down, and pagehide covers reload/navigation.
  useEffect(() => {
    const onHide = () => stopAllEngines();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      stopAllEngines();
    };
  }, []);

  const handleOutcome = useCallback(
    (job: SyncJobConfig, outcome: StartOutcome) => {
      if (outcome.ok) {
        setNotice(null);
        return;
      }
      if (outcome.reason === 'meta-mismatch') {
        setMismatchJob(job);
        return;
      }
      setNotice(t(`foldersync.startDenied.${outcome.reason}`));
    },
    [t],
  );

  const startJob = useCallback(
    (job: SyncJobConfig) => {
      setSelectedId(job.id);
      void getEngine(job)
        .start()
        .then((outcome) => handleOutcome(job, outcome));
    },
    [handleOutcome],
  );

  // Toolbar "Run now" (postMessage from the parent window).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (data?.type !== 'foldersync-run') return;
      if (selected) void getEngine(selected).runNow();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [selected]);

  // A custom app may open this tile with a remote folder pre-filled.
  const [prefill, setPrefill] = useState<Partial<SyncJobConfig> | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const remotePath = params.get('remotePath');
    if (!remotePath) return;
    const interval = Number(params.get('interval'));
    setPrefill({
      remotePath,
      intervalMs: Number.isFinite(interval) && interval > 0 ? interval : undefined,
    });
    setEditorOpen(true);
  }, []);

  const saveJob = useCallback(
    (job: SyncJobConfig) => {
      setStore((prev) => {
        const index = prev.jobs.findIndex((entry) => entry.id === job.id);
        if (index === -1) return { jobs: [...prev.jobs, job] };
        const jobs = [...prev.jobs];
        jobs[index] = job;
        return { jobs };
      });
      setSelectedId(job.id);
      setEditorOpen(false);
      setEditing(null);
    },
    [setStore],
  );

  const removeJob = useCallback(
    (job: SyncJobConfig) => {
      void getEngine(job).forgetHandle();
      setStore((prev) => ({ jobs: prev.jobs.filter((entry) => entry.id !== job.id) }));
    },
    [setStore],
  );

  const stats = state.stats;
  const supported = supportsLocalFs();

  return (
    <CommonTileContainer zoomAtom={folderSyncZoomAtom}>
      <div className="flex h-full min-h-0 flex-col gap-2">
        {/* Header — every control stays in the left cluster: the top-right
            224×48 corner belongs to TileTools, so nothing lands there. */}
        <div className="flex shrink-0 items-center gap-2 py-1.5">
          <span className="text-base font-semibold tracking-tight text-white/70">
            {t('foldersync.title')}
          </span>
          {selected && <StatusChip status={state.status} />}
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            disabled={!supported}
            title={supported ? t('foldersync.addJob') : t('foldersync.unsupportedShort')}
          >
            {t('foldersync.addJob')}
          </button>
          <div className="flex-1" />
        </div>

        {!supported && (
          <div className="shrink-0 rounded-lg bg-amber-500/10 px-3 py-2">
            <p className="text-sm text-amber-200/90">{t('foldersync.unsupportedTitle')}</p>
            <p className="mt-0.5 text-[11px] text-white/50">{t('foldersync.unsupportedBody')}</p>
          </div>
        )}

        {notice && (
          <div className="flex shrink-0 items-center gap-2 rounded-lg bg-red-500/10 px-3 py-1.5">
            <button type="button" className={btnRow} onClick={() => setNotice(null)}>
              <span className="text-[10px]">✕</span>
            </button>
            <span className="min-w-0 flex-1 text-[11px] text-red-300/85">{notice}</span>
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-center">
            <p className="text-sm text-white/60">{t('foldersync.emptyTitle')}</p>
            <p className="max-w-xs text-[11px] text-white/40">{t('foldersync.emptyBody')}</p>
          </div>
        ) : (
          <>
            {/* Job list */}
            <div className="max-h-[45%] shrink-0 overflow-y-auto rounded-lg border border-white/[0.08] bg-white/[0.04] scrollbar-thin">
              {jobs.map((job) => {
                const isSelected = job.id === selectedId;
                return (
                  <JobRow
                    key={job.id}
                    job={job}
                    selected={isSelected}
                    state={states[job.id] ?? null}
                    onSelect={() => setSelectedId(job.id)}
                    onStart={() => startJob(job)}
                    onStop={() => getEngine(job).stop()}
                    onEdit={() => {
                      setEditing(job);
                      setEditorOpen(true);
                    }}
                    onDelete={() => removeJob(job)}
                  />
                );
              })}
            </div>

            {/* Detail: cycle stats + activity log */}
            {selected && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.04]">
                <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
                  <span className={sectionLabel}>{t('foldersync.detailTitle')}</span>
                  <div className="flex-1" />
                  {state.progress && state.progress.total > 0 && (
                    <span className="text-[10px] tabular-nums text-white/45">
                      {t('foldersync.progress', {
                        done: state.progress.done,
                        total: state.progress.total,
                      })}
                    </span>
                  )}
                  {stats && (
                    <span className="text-[10px] tabular-nums text-white/40">
                      {t('foldersync.statsLine', {
                        cycle: stats.cycle,
                        checked: stats.checked,
                        pulled: stats.pulled,
                        deleted: stats.deleted,
                        size: formatSize(stats.pulledBytes),
                        ms: stats.durationMs,
                      })}
                    </span>
                  )}
                </div>
                {state.errorCode && state.status === 'error' && (
                  <div className="shrink-0 px-3 py-1.5 text-[11px] text-red-400/85">
                    {t(`foldersync.error.${state.errorCode}`)}
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
                  <ActivityLog log={state.log} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <JobEditorDialog
        // Remount per open: the remote picker initializes (home lookup) once
        // per session instead of on every keystroke in the path field.
        key={editorOpen ? 'editor-open' : 'editor-closed'}
        open={editorOpen}
        job={editing}
        defaults={prefill ?? undefined}
        onClose={() => {
          setEditorOpen(false);
          setEditing(null);
          setPrefill(null);
        }}
        onSave={saveJob}
      />

      <Dialog open={mismatchJob !== null} onOpenChange={(next) => !next && setMismatchJob(null)}>
        <DialogContent>
          <DialogTitle>{t('foldersync.metaMismatch.title')}</DialogTitle>
          <p className="mt-2 text-[11px] leading-relaxed text-white/60">
            {mismatchJob && mismatchJob.localDirName
              ? t('foldersync.metaMismatch.body', { folder: mismatchJob.localDirName })
              : t('foldersync.metaMismatch.bodyGeneric')}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-white/45">
            {t('foldersync.metaMismatch.hint')}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setMismatchJob(null)}>
              {t('foldersync.cancel')}
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                const job = mismatchJob;
                setMismatchJob(null);
                if (!job) return;
                void getEngine(job)
                  .resetMetaAndStart()
                  .then((outcome) => handleOutcome(job, outcome));
              }}
            >
              {t('foldersync.metaMismatch.reset')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </CommonTileContainer>
  );
}

function JobRow({
  job,
  selected,
  state,
  onSelect,
  onStart,
  onStop,
  onEdit,
  onDelete,
}: {
  job: SyncJobConfig;
  selected: boolean;
  state: JobRuntimeState | null;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const running = state?.running ?? false;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`flex cursor-pointer items-center gap-2 border-b border-white/[0.05] px-2.5 py-2 transition-colors duration-150 last:border-b-0 ${
        selected ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-white/80">{job.name}</span>
          <StatusChip status={state?.status ?? 'idle'} />
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-white/40">
          <span className="truncate">{job.remotePath}</span>
          <span className="shrink-0">→</span>
          <span className="truncate">{job.localDirName}</span>
          <span className="shrink-0 text-[10px] tabular-nums">· {job.intervalMs / 1000}s</span>
          {job.removeExtra && (
            <span className="shrink-0 text-[10px] text-amber-300/60">
              · {t('foldersync.mirrorBadge')}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {running ? (
          <button
            type="button"
            className={btnDanger}
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            {t('foldersync.stop')}
          </button>
        ) : (
          <button
            type="button"
            className={btnPrimary}
            onClick={(e) => {
              e.stopPropagation();
              onStart();
            }}
          >
            {t('foldersync.start')}
          </button>
        )}
        <button
          type="button"
          className={btnRow}
          aria-label={t('foldersync.editJob')}
          title={t('foldersync.editJob')}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <span className="text-[10px]">✎</span>
        </button>
        <button
          type="button"
          className={btnRow}
          aria-label={t('foldersync.deleteJob')}
          title={t('foldersync.deleteJob')}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <span className="text-[10px]">🗑</span>
        </button>
      </div>
    </div>
  );
}
