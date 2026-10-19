import { atomWithStorage } from 'jotai/utils';

/**
 * SFTP tile state that survives reloads. Passwords and private keys are never
 * persisted — only the connection target, so the user re-enters the secret.
 */

export type SftpAuthMode = 'password' | 'key';

export interface SavedSftpConnection {
  id: string;
  label: string;
  host: string;
  port?: number;
  user: string;
  auth: SftpAuthMode;
}

/** Saved connection targets (kept newest first, capped). */
export const sftpSavedConnectionsAtom = atomWithStorage<SavedSftpConnection[]>(
  'suwu:sftp-connections',
  [],
);

/** Add or replace a saved connection (by target signature), newest first. */
export function upsertSavedConnection(
  list: SavedSftpConnection[],
  next: SavedSftpConnection,
): SavedSftpConnection[] {
  const sig = (c: SavedSftpConnection) => `${c.user}@${c.host}:${c.port ?? ''}:${c.auth}`;
  const filtered = list.filter((c) => sig(c) !== sig(next));
  return [next, ...filtered].slice(0, 8);
}
