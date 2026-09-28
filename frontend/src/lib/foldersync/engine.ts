/**
 * Sync engine for one job: pre-flight → sync → cooldown, on a `setTimeout`
 * chain so cycles can never overlap.
 *
 * All runtime state lives in memory. Nothing here is persisted, so closing the
 * tile (or reloading) always returns the job to idle — the user starts it
 * again, which is also what re-grants directory permission.
 */

import { buildPlan, type HashProbe } from './diff';
import { isAbortError, requestPermission } from './fs-access';
import { deleteHandle, loadHandle } from './handleStore';
import { sha256Hex } from './hash';
import {
  deleteLocalFile,
  mkdirLocal,
  queryPermission,
  readLocalFile,
  removeLocalDir,
  scanLocal,
  supportsLocalFs,
  writeLocalFile,
} from './localFs';
import { emptyMeta, readMeta, writeMeta, type MetaStatus } from './meta';
import { fetchFile, fetchManifest, joinRemote, SyncApiError } from './remoteApi';
import type {
  ActivityEvent,
  CycleStats,
  JobRuntimeState,
  PlanAction,
  StartOutcome,
  SyncJobConfig,
  SyncMeta,
} from './types';

const MAX_LOG = 200;
const MAX_CONSECUTIVE_FAILURES = 3;
const PULL_CONCURRENCY = 4;

class SyncFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SyncFailure';
    this.code = code;
  }
}

function errorCodeOf(err: unknown): string {
  if (err instanceof SyncFailure) return err.code;
  if (err instanceof SyncApiError) return err.code;
  if (err instanceof DOMException) return err.name === 'NotFoundError' ? 'local-io' : 'local-io';
  return 'unknown';
}

interface ExecResult {
  pulled: number;
  pulledBytes: number;
  deleted: number;
  overwritten: number;
  errors: number;
  metaTouched: boolean;
}

type PullAction = Extract<PlanAction, { kind: 'pull' }>;

type Listener = (state: JobRuntimeState) => void;

export class SyncEngine {
  private job: SyncJobConfig;
  private state: JobRuntimeState;
  private listeners = new Set<Listener>();
  private dir: FileSystemDirectoryHandle | null = null;
  private meta: SyncMeta | null = null;
  private metaStatus: MetaStatus = 'missing';
  private running = false;
  private busy = false;
  private timer: number | null = null;
  private waker: (() => void) | null = null;
  private controller: AbortController | null = null;
  private failures = 0;

  constructor(job: SyncJobConfig) {
    this.job = job;
    this.state = {
      jobId: job.id,
      status: 'idle',
      cycle: 0,
      running: false,
      progress: null,
      stats: null,
      errorCode: null,
      log: [],
    };
  }

  getState(): JobRuntimeState {
    return this.snapshot();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Config edits only take effect while the job is stopped. */
  updateJob(job: SyncJobConfig): void {
    if (this.running) return;
    this.job = job;
  }

  private snapshot(): JobRuntimeState {
    return { ...this.state, log: [...this.state.log] };
  }

  private patch(partial: Partial<JobRuntimeState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private log(key: string, level: ActivityEvent['level'], params?: ActivityEvent['params']): void {
    const event: ActivityEvent = { at: Date.now(), level, key, params };
    const log = [...this.state.log, event];
    this.state = {
      ...this.state,
      log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log,
    };
    this.emit();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Starts the periodic loop. Must be called from a user gesture: Chromium
   * requires one before it will show the directory permission prompt.
   */
  async start(): Promise<StartOutcome> {
    if (this.running) return { ok: true };
    if (!supportsLocalFs()) return { ok: false, reason: 'unsupported' };

    this.patch({ status: 'starting', errorCode: null });
    const prepared = await this.prepare(true);
    if (!prepared.ok) {
      if (prepared.reason !== 'meta-mismatch') this.patch({ status: 'idle' });
      return prepared;
    }

    this.failures = 0;
    this.running = true;
    this.patch({ running: true, status: 'starting', errorCode: null });
    this.log('foldersync.log.started', 'info', { path: this.job.remotePath });
    void this.loop();
    return { ok: true };
  }

  /**
   * Confirms a journal written for a different server folder: reset it and
   * start. Called from the confirmation dialog's button.
   */
  async resetMetaAndStart(): Promise<StartOutcome> {
    if (!this.dir) return { ok: false, reason: 'no-handle' };
    let perm = await queryPermission(this.dir);
    if (perm !== 'granted') perm = await requestPermission(this.dir);
    if (perm !== 'granted') return { ok: false, reason: 'permission-denied' };
    await writeMeta(this.dir, emptyMeta(this.job.remotePath));
    this.meta = emptyMeta(this.job.remotePath);
    this.metaStatus = 'ok';
    this.log('foldersync.log.metaReset', 'info');
    return this.start();
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.wake();
    this.controller?.abort();
    this.patch({ running: false, status: 'idle', progress: null });
    if (wasRunning) this.log('foldersync.log.stopped', 'info');
  }

  /**
   * Runs one cycle immediately: skips the remaining cooldown when the loop is
   * running, otherwise a single pre-flight + sync without starting the loop.
   * Permission cannot be requested here (a toolbar postMessage is not a user
   * gesture in this frame) — a job that was never started logs a hint instead.
   */
  async runNow(): Promise<void> {
    if (this.busy) return;
    if (this.running) {
      this.wake();
      return;
    }
    if (!this.dir) {
      const prepared = await this.prepare(false);
      if (!prepared.ok) {
        this.log('foldersync.log.needsStart', 'warn');
        return;
      }
    }
    await this.runCycle();
  }

  /** Forgets the local folder handle (used when a job is deleted). */
  async forgetHandle(): Promise<void> {
    this.stop();
    await deleteHandle(this.job.dirId);
    this.dir = null;
    this.meta = null;
  }

  // ----------------------------------------------------------------- internals

  /**
   * Resolves the local handle (prompting for permission when allowed) and
   * loads the journal. Rejects when the journal belongs to a different server
   * folder — the caller must confirm a reset first.
   */
  private async prepare(allowPrompt: boolean): Promise<StartOutcome> {
    const handle = await loadHandle(this.job.dirId);
    if (!handle) return { ok: false, reason: 'no-handle' };
    let perm = await queryPermission(handle);
    if (perm !== 'granted' && allowPrompt) perm = await requestPermission(handle);
    if (perm !== 'granted') return { ok: false, reason: 'permission-denied' };
    this.dir = handle;

    const lookup = await readMeta(handle);
    this.metaStatus = lookup.status;
    if (lookup.meta && lookup.meta.remotePath !== this.job.remotePath) {
      return { ok: false, reason: 'meta-mismatch' };
    }
    this.meta = lookup.meta ?? emptyMeta(this.job.remotePath);
    return { ok: true };
  }

  private wake(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const waker = this.waker;
    this.waker = null;
    waker?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waker = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.waker = null;
        resolve();
      }, ms);
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.runCycle();
      if (!this.running) break;
      await this.sleep(this.job.intervalMs);
    }
  }

  private async runCycle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    const cycle = this.state.cycle + 1;
    this.patch({ cycle, status: 'preflight', progress: null, errorCode: null });
    this.log('foldersync.log.cycle', 'info', { cycle });

    try {
      const dir = this.dir;
      const meta = this.meta;
      if (!dir || !meta) throw new SyncFailure('no-handle');

      const [remote, local] = await Promise.all([
        fetchManifest(this.job.remotePath, controller.signal),
        scanLocal(dir, controller.signal),
      ]);
      if (remote.truncated || local.truncated) throw new SyncFailure('truncated');

      const plan = await buildPlan(
        remote.entries,
        local.entries,
        meta,
        this.job.removeExtra,
        this.probe(dir),
      );
      this.log('foldersync.log.preflight', 'info', {
        checked: plan.checked,
        changes: plan.actions.length,
      });
      for (const skip of plan.skipped) {
        this.log('foldersync.log.tooLarge', 'warn', { rel: skip.rel });
      }

      const result = await this.execute(plan.actions, dir, meta, controller);

      // Journal maintenance: record identical files, forget server-deleted ones.
      for (const [rel, entry] of Object.entries(plan.seeds)) {
        meta.files[rel] = entry;
      }
      let seedsAdded = Object.keys(plan.seeds).length > 0;
      for (const rel of Object.keys(meta.files)) {
        if (remote.entries.has(rel)) continue;
        delete meta.files[rel];
        seedsAdded = true;
      }
      if (seedsAdded) result.metaTouched = true;
      meta.lastCycleAt = Date.now();
      if (result.metaTouched || this.metaStatus !== 'ok') {
        try {
          await writeMeta(dir, meta);
          this.metaStatus = 'ok';
        } catch (err) {
          this.log('foldersync.log.metaWriteFailed', 'error', { error: errorCodeOf(err) });
        }
      }

      this.failures = 0;
      const stats: CycleStats = {
        cycle,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        checked: plan.checked,
        pulled: result.pulled,
        pulledBytes: result.pulledBytes,
        deleted: result.deleted,
        overwritten: result.overwritten,
        skipped: plan.skipped.length,
        errors: result.errors,
      };
      this.log('foldersync.log.cycleDone', 'info', {
        pulled: result.pulled,
        deleted: result.deleted,
        ms: stats.durationMs,
      });
      this.patch({
        status: this.running ? 'cooldown' : 'idle',
        progress: null,
        stats,
        errorCode: null,
      });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        this.patch({ status: this.running ? 'cooldown' : 'idle', progress: null });
      } else {
        this.failures += 1;
        const code = errorCodeOf(err);
        this.log('foldersync.log.cycleFailed', 'error', { error: code });
        if (!this.running || this.failures >= MAX_CONSECUTIVE_FAILURES) {
          this.running = false;
          this.wake();
          this.patch({ running: false, status: 'error', progress: null, errorCode: code });
        } else {
          this.patch({ status: 'cooldown', progress: null, errorCode: code });
        }
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.emit();
    }
  }

  private probe(dir: FileSystemDirectoryHandle): HashProbe {
    return async (rel: string) => {
      const [localBytes, remoteBytes] = await Promise.all([
        readLocalFile(dir, rel).then((file) => file.arrayBuffer()),
        fetchFile(joinRemote(this.job.remotePath, rel), this.controller?.signal).then(
          (res) => res.bytes,
        ),
      ]);
      const [localHash, remoteHash] = await Promise.all([
        sha256Hex(localBytes),
        sha256Hex(remoteBytes),
      ]);
      return { local: localHash, remote: remoteHash };
    };
  }

  private async execute(
    actions: PlanAction[],
    dir: FileSystemDirectoryHandle,
    meta: SyncMeta,
    controller: AbortController,
  ): Promise<ExecResult> {
    const result: ExecResult = {
      pulled: 0,
      pulledBytes: 0,
      deleted: 0,
      overwritten: 0,
      errors: 0,
      metaTouched: false,
    };
    const total = actions.length;
    let done = 0;
    const step = () => {
      done += 1;
      this.patch({ progress: { done, total } });
    };

    // 1. Clear wrong-kind obstacles before anything is created in their place.
    for (const action of actions) {
      if (action.kind !== 'remove-obstacle') continue;
      try {
        if (action.isDir) await removeLocalDir(dir, action.rel, true);
        else await deleteLocalFile(dir, action.rel);
      } catch (err) {
        this.actionFailed(action.rel, err);
        result.errors += 1;
      }
      step();
    }

    // 2. Directories (parents of pulled files are created on demand).
    for (const action of actions) {
      if (action.kind !== 'mkdir-local') continue;
      try {
        await mkdirLocal(dir, action.rel);
        this.log('foldersync.log.mkdir', 'info', { rel: action.rel });
      } catch (err) {
        this.actionFailed(action.rel, err);
        result.errors += 1;
      }
      step();
    }

    // 3. Downloads, bounded concurrency.
    const pullActions = actions.filter((a): a is PullAction => a.kind === 'pull');
    let cursor = 0;
    let pullErrors = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const action = pullActions[cursor];
        cursor += 1;
        if (!action) return;
        try {
          const { bytes } = await fetchFile(
            joinRemote(this.job.remotePath, action.rel),
            controller.signal,
          );
          const written = await writeLocalFile(dir, action.rel, new Blob([bytes]));
          meta.files[action.rel] = {
            size: action.size,
            remoteMtimeMs: action.mtimeMs,
            localMtimeMs: written.mtimeMs,
          };
          result.pulled += 1;
          result.pulledBytes += written.size;
          result.metaTouched = true;
          if (action.reason === 'local-diverged') {
            result.overwritten += 1;
            this.log('foldersync.log.overwrite', 'warn', { rel: action.rel });
          } else {
            this.log('foldersync.log.pull', 'info', { rel: action.rel, size: written.size });
          }
        } catch (err) {
          if (controller.signal.aborted || isAbortError(err)) return;
          pullErrors += 1;
          result.errors += 1;
          this.actionFailed(action.rel, err);
        }
        step();
      }
    };
    const workers = Math.max(1, Math.min(PULL_CONCURRENCY, pullActions.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    // 4. Deletions run last, and only when every download landed — a
    //    half-finished cycle must never remove data it failed to re-fetch.
    const deletes = actions.filter((a) => a.kind === 'delete-local');
    const rmdirs = actions.filter((a) => a.kind === 'rmdir-local');
    if (deletes.length > 0 || rmdirs.length > 0) {
      if (pullErrors > 0) {
        this.log('foldersync.log.deletesDeferred', 'warn', {
          count: deletes.length + rmdirs.length,
        });
        for (let i = 0; i < deletes.length + rmdirs.length; i += 1) step();
      } else {
        for (const action of deletes) {
          try {
            await deleteLocalFile(dir, action.rel);
            if (delete meta.files[action.rel]) result.metaTouched = true;
            result.deleted += 1;
            this.log('foldersync.log.delete', 'info', { rel: action.rel });
          } catch (err) {
            this.actionFailed(action.rel, err);
            result.errors += 1;
          }
          step();
        }
        for (const action of rmdirs) {
          try {
            await removeLocalDir(dir, action.rel, false);
            result.deleted += 1;
            this.log('foldersync.log.rmdir', 'info', { rel: action.rel });
          } catch (err) {
            this.actionFailed(action.rel, err);
            result.errors += 1;
          }
          step();
        }
      }
    }

    return result;
  }

  private actionFailed(rel: string, err: unknown): void {
    this.log('foldersync.log.actionFailed', 'error', { rel, error: errorCodeOf(err) });
  }
}

// ------------------------------------------------------------------- registry

const engines = new Map<string, SyncEngine>();

export function getEngine(job: SyncJobConfig): SyncEngine {
  let engine = engines.get(job.id);
  if (!engine) {
    engine = new SyncEngine(job);
    engines.set(job.id, engine);
  } else {
    engine.updateJob(job);
  }
  return engine;
}

/**
 * Stops every engine. The panel calls this when its last pane unmounts (and
 * on pagehide): sync only ever runs while a Folder Sync tile is open.
 */
export function stopAllEngines(): void {
  for (const engine of engines.values()) engine.stop();
  engines.clear();
}
