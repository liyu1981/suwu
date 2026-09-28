/**
 * Folder Sync — shared types for the one-way (server → local) mirror engine.
 *
 * The engine has no React dependency: it is driven from FolderSyncPanel and
 * reports state through subscribe() callbacks.
 */

/** A managed sync job — persisted in localStorage under `suwu:folder-sync`. */
export interface SyncJobConfig {
  id: string;
  name: string;
  /** Absolute path on the Suwu host. */
  remotePath: string;
  /** Key of the local directory handle in IndexedDB (handles are not JSON). */
  dirId: string;
  /** Display name of the chosen local folder. */
  localDirName: string;
  /** Cycle interval in ms. */
  intervalMs: number;
  /** Remove local files/dirs that no longer exist on the server. */
  removeExtra: boolean;
}

export const DEFAULT_INTERVAL_MS = 5000;
export const INTERVAL_OPTIONS = [2000, 5000, 10000, 30000, 60000] as const;

/** Largest file the mirror transfers or hashes; above it the plan skips. */
export const MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024;
/** Caps shared with the server manifest endpoint (pkg/server/sync.go). */
export const MAX_SYNC_ENTRIES = 20000;
export const MAX_SYNC_DEPTH = 32;

/**
 * The sync journal, stored at the root of the local folder. The algorithm
 * never mirrors it: it is stripped from both sides, never deleted by
 * `removeExtra`, and removing it by hand is the supported way to reset a job.
 * It is a plain constant here so the pure diff module stays dependency-free
 * (and therefore testable from scripts/check-foldersync-diff.mjs).
 */
export const META_NAME = '.suwu-sync.json';
export const META_VERSION = 1;
export const META_PLUGIN = 'suwu-foldersync';

export function isMetaName(rel: string): boolean {
  return rel === META_NAME;
}

/** One side's view of a file or directory, keyed by root-relative path. */
export interface FileRecord {
  rel: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export type ManifestMap = Map<string, FileRecord>;

export interface ScanResult {
  entries: ManifestMap;
  /** True when a depth/entry cap cut the scan short — never mirror partially. */
  truncated: boolean;
}

/** One mirrored file as recorded in `.suwu-sync.json`. */
export interface FileMetaEntry {
  size: number;
  remoteMtimeMs: number;
  localMtimeMs: number;
}

export interface SyncMeta {
  version: number;
  plugin: string;
  remotePath: string;
  lastCycleAt?: number;
  files: Record<string, FileMetaEntry>;
}

export type PullReason = 'new' | 'remote-changed' | 'local-diverged' | 'first-run';

export type PlanAction =
  /** Local entry of the wrong kind (file where the server has a dir, …). */
  | { kind: 'remove-obstacle'; rel: string; isDir: boolean }
  | { kind: 'mkdir-local'; rel: string }
  | { kind: 'pull'; rel: string; size: number; mtimeMs: number; reason: PullReason }
  | { kind: 'delete-local'; rel: string }
  | { kind: 'rmdir-local'; rel: string };

export interface SkippedEntry {
  rel: string;
  reason: 'too-large';
}

export interface Plan {
  /** Ordered: obstacles → mkdirs → pulls → file deletes → rmdirs. */
  actions: PlanAction[];
  skipped: SkippedEntry[];
  /** Identical files to record so the next cycle can skip without hashing. */
  seeds: Record<string, FileMetaEntry>;
  checked: number;
  /** Local extras left alone because `removeExtra` is off. */
  extrasIgnored: number;
}

export type JobStatus = 'idle' | 'starting' | 'preflight' | 'syncing' | 'cooldown' | 'error';

export interface ActivityEvent {
  at: number;
  level: 'info' | 'warn' | 'error';
  /** i18n key under `foldersync.log.`. */
  key: string;
  params?: Record<string, string | number>;
}

export interface CycleStats {
  cycle: number;
  at: number;
  durationMs: number;
  checked: number;
  pulled: number;
  pulledBytes: number;
  deleted: number;
  /** Pulls that overwrote a local edit (reason `local-diverged`). */
  overwritten: number;
  skipped: number;
  errors: number;
}

export interface JobRuntimeState {
  jobId: string;
  status: JobStatus;
  cycle: number;
  /** True while the periodic loop is scheduled (never persisted). */
  running: boolean;
  progress: { done: number; total: number } | null;
  stats: CycleStats | null;
  /** Machine code, translated by the UI as `foldersync.error.<code>`. */
  errorCode: string | null;
  log: ActivityEvent[];
}

export type StartReason = 'permission-denied' | 'meta-mismatch' | 'unsupported' | 'no-handle';

export type StartOutcome = { ok: true } | { ok: false; reason: StartReason };
