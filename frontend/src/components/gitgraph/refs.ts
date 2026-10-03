/**
 * Git ref helpers shared by the comparison tabs and the repo-tab model.
 *
 * Kept free of imports so both the tab model and the check scripts can use it
 * outside the bundler (see scripts/check-git-tabs.mjs).
 */

/**
 * Pseudo-revision for uncommitted changes. The server diffs the working tree
 * against the comparison's base (HEAD) instead of resolving a commit.
 */
export const WORKTREE_REF = 'WORKTREE';

/** Pseudo-revision for a repository's empty tree (root commit parent). */
export const EMPTY_TREE_REF = 'EMPTY';

/** Stable identity of a base → target comparison inside a repo tab. */
export function comparisonId(repoPath: string, base: string, target: string): string {
  return JSON.stringify([repoPath, base, target]);
}
