/** Minimal model interface so save bookkeeping can be tested without Monaco. */
interface VersionedModel {
  getAlternativeVersionId(): number;
  isDisposed(): boolean;
}

interface SaveState {
  model: VersionedModel;
  savedVersionId: number;
  mtimeMs: number | null;
  isNew: boolean;
  error?: string;
}

/** Record the version sent to disk, not edits made while the request ran. */
export function completeSave(
  tab: SaveState,
  submittedVersionId: number,
  mtimeMs?: number,
): boolean | null {
  if (tab.model.isDisposed()) return null;
  tab.savedVersionId = submittedVersionId;
  if (typeof mtimeMs === 'number') tab.mtimeMs = mtimeMs;
  tab.isNew = false;
  tab.error = undefined;
  return tab.model.getAlternativeVersionId() !== submittedVersionId;
}
