/**
 * Persisted Folder Sync configuration.
 *
 * Only the job list lives here. Whether a job is running, its plan, progress
 * and log are engine state in memory: on reload every job comes back idle,
 * waiting for the user to start it again (which is also what re-grants the
 * local folder permission).
 */

import { atomWithStorage } from 'jotai/utils';
import type { SyncJobConfig } from '../lib/foldersync/types';

export interface FolderSyncState {
  jobs: SyncJobConfig[];
}

const EMPTY: FolderSyncState = { jobs: [] };

export const folderSyncAtom = atomWithStorage<FolderSyncState>('suwu:folder-sync', EMPTY);
