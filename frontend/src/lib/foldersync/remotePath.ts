/**
 * Pure path helpers shared by the remote folder picker.
 *
 * Kept free of imports so the picker's prefix logic can be checked under Node's
 * type stripping (scripts/check-folder-prefix.mjs).
 */

/** Absolute path of `name` inside `dir`. */
export function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Parent of `dir`, clamped at the filesystem root. */
export function parentPath(dir: string): string {
  if (dir === '/' || dir === '') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/**
 * Split a typed path into the directory to list and the name prefix to filter
 * by. A trailing slash (or root) means "list this directory's children", so the
 * prefix is empty; otherwise the last segment is the prefix. This is what lets
 * a partial path such as "/home/yli/single" suggest every sibling that starts
 * with "single", even though "/home/yli/single" is not itself a directory.
 */
export function splitPrefix(input: string): { dir: string; prefix: string } {
  if (input === '/' || input.endsWith('/')) return { dir: input, prefix: '' };
  const idx = input.lastIndexOf('/');
  if (idx < 0) return { dir: '/', prefix: input };
  return { dir: idx === 0 ? '/' : input.slice(0, idx), prefix: input.slice(idx + 1) };
}
