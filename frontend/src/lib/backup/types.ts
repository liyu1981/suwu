/**
 * Backup — shared types.
 *
 * The backup carries three kinds of data (see registry.ts): app settings from
 * `localStorage`, per-extension records from the IndexedDB `ext-store`, and the
 * window-manager layout/session keys. Everything is encrypted in the browser
 * (crypto.ts) before it reaches the network, so the server only ever handles
 * opaque bytes.
 */

/** Payload schema version. Bump only with a migration in apply.ts. */
export const PAYLOAD_VERSION = 1;

/** Container format version, stored in the clear header of every blob. */
export const CONTAINER_VERSION = 1;

/** The three data groups a backup can carry. */
export type Category = 'settings' | 'ext' | 'layout';

export const CATEGORIES: readonly Category[] = ['settings', 'ext', 'layout'] as const;

/** Namespace tag for one backed-up item. */
export type Namespace = 'ls' | 'ext';

/** One stored value, from either localStorage or an extension's IndexedDB. */
export interface Item {
  ns: Namespace;
  /** For `ls`: the localStorage key. For `ext`: `<ext-id>/<key>`. */
  path: string;
  /** Epoch ms of the last local change, used for merge decisions. */
  mtime: number;
  /** The stored value (JSON-compatible). */
  value: unknown;
}

/** The decrypted backup payload. */
export interface Payload {
  v: number;
  /** Random per-browser id, so a backup says which device wrote it. */
  deviceId: string;
  /** Epoch ms. */
  createdAt: number;
  categories: Category[];
  items: Item[];
}

/** Per-generation metadata the server keeps about a ciphertext. */
export interface Generation {
  gen: number;
  size: number;
  sha256: string;
  mtime: string;
}

/** The server's plaintext index of one slot. */
export interface Meta {
  slot: string;
  generations: Generation[];
  bytes: number;
}

/** Response body of a successful upload. */
export interface PutResult {
  ok: boolean;
  gen: number;
  mtime: string;
  size: number;
  generations: number;
  bytes: number;
}

/** Thrown when the server reports a newer generation in the same slot. */
export class BackupConflictError extends Error {
  currentGen: number;
  currentMTime: string;
  constructor(currentGen: number, currentMTime: string) {
    super('a newer backup exists on the server');
    this.name = 'BackupConflictError';
    this.currentGen = currentGen;
    this.currentMTime = currentMTime;
  }
}

/** Thrown when decryption fails — wrong passphrase or damaged blob. */
export class BackupDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDecryptError';
  }
}

/** Thrown when a blob's plaintext does not match the current schema. */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Live status the Settings UI renders. */
export type BackupPhase = 'off' | 'idle' | 'backing-up' | 'error';

export interface BackupStatus {
  phase: BackupPhase;
  /** Epoch ms of the last successful upload. */
  lastBackupAt: number | null;
  /** Server generation the last upload produced. */
  gen: number | null;
  /** Plaintext (pre-encryption) size of the last upload. */
  size: number | null;
  /** Short message for the error phase. */
  error: string | null;
  /** True when the server holds a newer generation than this device. */
  conflict: boolean;
}

/** The idle status, also used as the reset value. */
export const IDLE_STATUS: BackupStatus = {
  phase: 'off',
  lastBackupAt: null,
  gen: null,
  size: null,
  error: null,
  conflict: false,
};
