import { authFetch } from '../../lib/api';

/**
 * Pseudo-revision for uncommitted changes. The server diffs the working tree
 * against the comparison's base (HEAD) instead of resolving a commit.
 */
export const WORKTREE_REF = 'WORKTREE';

export interface ComparisonFile {
  id: string;
  oldPath: string;
  newPath: string;
  status: string;
  oldMode: string;
  newMode: string;
  adds: number;
  dels: number;
  binary: boolean;
  submodule: boolean;
}
export interface Comparison {
  base: string;
  target: string;
  parents: string[];
  files: ComparisonFile[];
  adds: number;
  dels: number;
}
export interface DiffTab {
  id: string;
  repoPath: string;
  base: string;
  target: string;
  focusFile?: string;
}
export interface PatchLine {
  kind: 'context' | 'remove' | 'add' | 'note';
  text: string;
  old: number | null;
  new: number | null;
}
export interface PatchHunk {
  header: string;
  lines: PatchLine[];
}
export interface FilePatch {
  hunks: PatchHunk[];
  limited: boolean;
}

export function comparisonId(repoPath: string, base: string, target: string) {
  return JSON.stringify([repoPath, base, target]);
}

export async function comparisonRequest<T>(
  endpoint: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  const response = await authFetch(`/api/git/${endpoint}?${new URLSearchParams(params)}`, {
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
