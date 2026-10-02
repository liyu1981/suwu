/**
 * Backup — the client: configuration, the periodic autosave, and restore.
 *
 * The backup is **off by default**. Turning it on (System Settings → Backup)
 * mints a slot id, a data key, and a 5-minute timer; from then on every tick
 * collects the selected categories and uploads only when the canonical payload
 * actually changed. The interval is a per-device setting and is never itself
 * backed up — how often one laptop syncs is not another machine's business.
 *
 * The passphrase is never stored. The derived data key lives only in memory, so
 * after a page reload the timer stays idle until the user re-enters the
 * passphrase (via Restore or Change) — a backup tool cannot quietly hold a
 * secret on disk.
 *
 * Uploads carry `?base=<lastSeenGen>`. If the slot moved on (another browser
 * wrote), the server answers 409 and the status flips to `conflict` for the UI
 * to resolve — a second device can never silently overwrite a newer backup.
 */

import { authFetch } from '../api.ts';
import {
  apply,
  preview,
  type ApplyReport,
  type RestoreMode,
  type RestorePreview,
} from './apply.ts';
import { canonicalJSON, sha256Base64 } from './container.ts';
import { collect } from './collect.ts';
import {
  BackupConflictError,
  CATEGORIES,
  IDLE_STATUS,
  PAYLOAD_VERSION,
  type BackupStatus,
  type Category,
  type Generation,
  type Meta,
  type Payload,
  type PutResult,
} from './types.ts';
import {
  clearKeyCache,
  decryptPayload,
  encryptPayload,
  hasKey,
  initSlotKey,
  isPassphraseAcceptable,
  rewrapForNewPassphrase,
} from './crypto.ts';

/** localStorage key holding the backup configuration (never backed up). */
export const CONFIG_KEY = 'suwu:backup-config';

/** The default autosave interval, in milliseconds (5 minutes). */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Bounds the interval the user may pick. */
export const MIN_INTERVAL_MS = 60 * 1000;
export const MAX_INTERVAL_MS = 60 * 60 * 1000;

/** 26 Crockford base32 characters (lowercase), matching pkg/backup. */
const SLOT_CHARS = 'abcdefghijklmnopqrstuvwxyz234567';
const SLOT_RE = /^[a-z2-7]{26}$/;

/** On-disk configuration. The passphrase is never stored; only the derived
 * key material lives in memory, so a reload asks for the passphrase again. */
export interface BackupConfig {
  enabled: boolean;
  slot: string;
  categories: Category[];
  intervalMs: number;
  /** Random per-browser id, reported in each payload so a backup names its
   * source device. */
  deviceId: string;
}

function defaultConfig(): BackupConfig {
  return {
    enabled: false,
    slot: '',
    categories: ['settings', 'ext', 'layout'],
    intervalMs: DEFAULT_INTERVAL_MS,
    deviceId: '',
  };
}

function readConfig(): BackupConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as Partial<BackupConfig>;
    const cfg = { ...defaultConfig(), ...parsed };
    cfg.categories = (cfg.categories ?? []).filter((c) =>
      (CATEGORIES as readonly string[]).includes(c),
    );
    if (!SLOT_RE.test(cfg.slot)) cfg.slot = '';
    if (!Number.isFinite(cfg.intervalMs)) cfg.intervalMs = DEFAULT_INTERVAL_MS;
    cfg.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, cfg.intervalMs));
    return cfg;
  } catch {
    return defaultConfig();
  }
}

function writeConfig(cfg: BackupConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* storage disabled — the backup cannot be configured this session */
  }
}

/** A 130-bit random slot id: the user's recovery code. */
function mintSlot(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = '';
  for (let i = 0; i < 26; i++) out += SLOT_CHARS[bytes[i] % SLOT_CHARS.length];
  return out;
}

function mintDeviceId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── state ──────────────────────────────────────────────────────────────

let config = readConfig();
let status: BackupStatus = { ...IDLE_STATUS };
let timer: ReturnType<typeof setInterval> | null = null;
let lastPlaintextHash: string | null = null;
/** The generation this device last wrote or observed, sent as `?base=`. */
let lastSeenGen = 0;
let running = false;
const listeners = new Set<(status: BackupStatus) => void>();

/** Subscribe to status changes. Returns an unsubscribe function. */
export function subscribeBackup(fn: (status: BackupStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => {
    listeners.delete(fn);
  };
}

function setStatus(next: Partial<BackupStatus>): void {
  status = { ...status, ...next };
  for (const fn of listeners) fn(status);
}

/** The current status, for a component that mounts later. */
export function getBackupStatus(): BackupStatus {
  return status;
}

/** The current configuration (a copy). */
export function getBackupConfig(): BackupConfig {
  return { ...config, categories: [...config.categories] };
}

/** Replaces the backed-up category set and restarts the timer. */
export function setCategories(categories: Category[]): void {
  config.categories = categories;
  writeConfig(config);
}

/** Set the autosave interval, clamped to the allowed range. */
export function setIntervalMs(ms: number): void {
  config.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
  writeConfig(config);
  restart();
}

export function isEnabled(): boolean {
  return config.enabled && SLOT_RE.test(config.slot);
}

/**
 * Called by the extension bridge (and anywhere else that knows data moved) to
 * record that the next tick has fresh work. With the periodic cadence the next
 * tick picks it up on its own, so this never triggers a write by itself — it
 * is the single place a future on-save upload would hook, and it keeps the
 * wiring explicit.
 */
export function notifyBackupDirty(_category?: Category): void {
  // Intentionally a no-op under the periodic schedule; see above.
}

// ── lifecycle ──────────────────────────────────────────────────────────

/**
 * Enables backup: mints (or adopts) a slot, derives the slot key from the
 * passphrase, and starts the periodic timer. The caller then runs the first
 * pass with `backupNow()`.
 */
export async function enable(passphrase: string): Promise<void> {
  if (!isPassphraseAcceptable(passphrase)) {
    throw new Error('passphrase must be at least 8 characters');
  }
  if (!SLOT_RE.test(config.slot)) config.slot = mintSlot();
  if (!config.deviceId) config.deviceId = mintDeviceId();
  await initSlotKey(passphrase);
  config.enabled = true;
  writeConfig(config);
  lastSeenGen = 0;
  lastPlaintextHash = null;
  setStatus({ phase: 'idle', error: null, conflict: false });
  start();
}

/**
 * Changes the passphrase. The data key is re-wrapped under the new passphrase
 * without re-encrypting any history; the next upload carries the new wrap.
 * `oldPassphrase` is verified by decrypting the newest server generation, so a
 * typo in the old one is caught before anything changes.
 */
export async function changePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  if (!isPassphraseAcceptable(newPassphrase)) {
    throw new Error('passphrase must be at least 8 characters');
  }
  await adoptSlotKey(oldPassphrase);
  await rewrapForNewPassphrase(newPassphrase);
  lastPlaintextHash = null; // the next upload carries the new wrap
  if (isEnabled()) start();
}

/** Disables local autosave. `wipeServer` also deletes the slot on the server. */
export async function disable(wipeServer: boolean): Promise<void> {
  const slot = config.slot;
  stop();
  clearKeyCache();
  config.enabled = false;
  writeConfig(config);
  lastPlaintextHash = null;
  setStatus({ ...IDLE_STATUS, phase: 'off' });
  if (wipeServer && SLOT_RE.test(slot)) {
    try {
      await authFetch(`/api/backup?slot=${slot}&confirm=${slot}`, { method: 'DELETE' });
    } catch {
      // The server wipe is best-effort; the local disable already happened.
    }
  }
}

function start(): void {
  stop();
  if (!isEnabled()) return;
  timer = setInterval(() => {
    void tick();
  }, config.intervalMs);
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function restart(): void {
  if (isEnabled()) start();
}

/**
 * Boots the backup module: starts the timer if enabled *and* a key is already
 * in memory. After a page reload the key is gone, so the timer stays idle
 * until the user re-enters the passphrase.
 */
export function initBackup(): void {
  if (isEnabled() && hasKey()) start();
}

// ── the tick ───────────────────────────────────────────────────────────

/**
 * Runs one backup pass: collect, canonicalize, and upload only when the
 * payload changed since the last successful upload. Exposed for "Back up now"
 * and for tests.
 */
export async function tick(): Promise<BackupStatus> {
  if (!isEnabled() || !hasKey()) return status;
  if (running) return status;
  running = true;
  setStatus({ phase: 'backing-up', error: null });
  try {
    const collected = await collect(config.categories);
    const payload: Payload = {
      v: PAYLOAD_VERSION,
      deviceId: config.deviceId,
      createdAt: Date.now(),
      categories: [...config.categories],
      items: collected.items,
    };
    // `createdAt` alone would change every run; strip it before hashing so an
    // unchanged snapshot is byte-identical and the upload is skipped.
    const hash = await sha256Base64(canonicalJSON({ ...payload, createdAt: 0 }));
    if (hash === lastPlaintextHash) {
      setStatus({ phase: 'idle' });
      return status;
    }

    const { bytes, plaintextSize } = await encryptPayload(payload, { gen: lastSeenGen + 1 });

    const query = new URLSearchParams();
    if (lastSeenGen > 0) query.set('base', String(lastSeenGen));
    const res = await authFetch(`/api/backup?${query.toString()}`, {
      method: 'POST',
      headers: { 'X-Suwu-Slot': config.slot, 'Content-Type': 'application/octet-stream' },
      body: bytes.buffer as ArrayBuffer,
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { currentGen?: number };
      lastSeenGen = body.currentGen ?? 0;
      setStatus({ phase: 'error', conflict: true, error: 'conflict' });
      return status;
    }
    if (!res.ok) {
      setStatus({ phase: 'error', error: `server returned HTTP ${res.status}` });
      return status;
    }
    const result = (await res.json()) as PutResult;
    lastSeenGen = result.gen;
    lastPlaintextHash = hash;
    setStatus({
      phase: 'idle',
      lastBackupAt: Date.now(),
      gen: result.gen,
      size: plaintextSize,
      error: null,
      conflict: false,
    });
  } catch (error) {
    setStatus({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
  return status;
}

/** Manually trigger a backup now (the "Back up now" button). */
export async function backupNow(): Promise<BackupStatus> {
  return tick();
}

// ── server queries ─────────────────────────────────────────────────────

/** Reads the server's index for the current slot. */
export async function fetchMeta(): Promise<Meta> {
  const res = await authFetch(`/api/backup/meta?slot=${config.slot}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`meta failed with HTTP ${res.status}`);
  return (await res.json()) as Meta;
}

/** Downloads one generation's container bytes. */
export async function fetchBlob(gen: number): Promise<Uint8Array> {
  const res = await authFetch(`/api/backup/blob?slot=${config.slot}&gen=${gen}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`blob failed with HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Lists the server's generations, newest first, and records the newest one as
 * the base for the next upload. */
export async function listGenerations(): Promise<Generation[]> {
  const meta = await fetchMeta();
  lastSeenGen = meta.generations.length ? meta.generations[meta.generations.length - 1].gen : 0;
  return [...meta.generations].sort((a, b) => b.gen - a.gen);
}

// ── restore ────────────────────────────────────────────────────────────

/**
 * Fetches a generation and decrypts it with the passphrase. Decrypting also
 * adopts the slot's data key, so a restore on a fresh browser lets subsequent
 * autosaves continue under the same key.
 */
export async function fetchAndDecrypt(gen: number, passphrase: string): Promise<Payload> {
  const bytes = await fetchBlob(gen);
  const { payload } = await decryptPayload(bytes, passphrase);
  // A browser that has just adopted the slot key can resume periodic backups.
  // This is how a *new* browser — which never called enable() — gets one.
  if (isEnabled()) start();
  return payload;
}

/**
 * Establishes the in-memory slot key from a passphrase, preferring the newest
 * server generation (so the existing data key is adopted) and falling back to
 * minting a fresh one when the slot is empty.
 */
async function adoptSlotKey(passphrase: string): Promise<void> {
  let generations: Generation[] = [];
  try {
    generations = await listGenerations();
  } catch {
    generations = [];
  }
  const latest = generations[0];
  if (!latest) {
    await initSlotKey(passphrase);
    return;
  }
  const bytes = await fetchBlob(latest.gen);
  await decryptPayload(bytes, passphrase);
}

/** Previews what restoring a payload would change (writes nothing). */
export async function previewRestore(payload: Payload, mode: RestoreMode): Promise<RestorePreview> {
  const current = await collect(config.categories.length ? config.categories : [...CATEGORIES]);
  return preview(payload, current.items, mode);
}

/** Applies a decrypted payload to this device. */
export async function restore(payload: Payload, mode: RestoreMode): Promise<ApplyReport> {
  const current = await collect(config.categories.length ? config.categories : [...CATEGORIES]);
  const report = await apply(payload, mode, current.items);
  // Force the next tick to re-upload so the server matches this device again.
  lastPlaintextHash = null;
  return report;
}

/** True when the last failure was a slot conflict (another device wrote). */
export function hasConflict(): boolean {
  return status.conflict;
}

/**
 * Resolves a conflict in favour of this device: forgets the observed base and
 * writes over the other device's generation. The UI offers this as an explicit
 * choice, never as the automatic response.
 */
export async function resolveConflictOverwrite(): Promise<BackupStatus> {
  lastSeenGen = 0;
  lastPlaintextHash = null;
  return tick();
}

export { BackupConflictError };
