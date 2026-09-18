import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export interface CodeFileSpec {
  path: string;
  ranges?: Array<{ start: number; end: number }>;
}

/** Action payload variants emitted by the `suwu` CLI. */
export type NotificationPayload =
  | { type: 'dir' | 'file' | 'gitgraph'; path: string }
  | { type: 'diff'; file1: string; file2: string }
  | {
      type: 'forward';
      localPort?: number;
      targetHost?: string;
      targetPort?: number;
      protocol?: string;
    }
  | { type: 'code'; files: CodeFileSpec[] };

export interface NotificationData {
  action: string;
  payload: NotificationPayload;
}

export interface Notification {
  id: string;
  message: string;
  timestamp: number;
  data?: NotificationData;
}

/** Persisted message history, capped at maxEntries. */
export const notificationsAtom = atomWithStorage<Notification[]>('suwu:notifications', []);

/** Number of unread notifications since the panel was last opened. */
export const unreadCountAtom = atom(0);

/** Max entries kept in localStorage (configurable in settings). */
export const maxEntriesAtom = atomWithStorage('suwu:max-entries', 999);

/** Whether the notification panel is open. */
export const panelOpenAtom = atom(false);
