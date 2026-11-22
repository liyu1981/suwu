/**
 * POSIX path helpers for the tiles' own file pickers and browsers.
 *
 * Every picker in this app (git repo, code open/create, SFTP, remote folder sync)
 * walks a POSIX path: join a name onto a directory, climb to the parent, and
 * normalise whatever a user typed. They had each grown their own copy — four
 * copies of `joinPath` and `parentPath`, which drifted in their handling of a
 * trailing slash and of an empty path. One copy, one set of rules:
 *
 * - there is no "relative" form: an empty path is the root, and a bare name has
 *   the root as its parent, because every caller starts at `/` and the server
 *   resolves relative paths against the home directory anyway;
 * - trailing slashes are noise and are dropped, except on the root;
 * - `..` may not climb above `/`.
 *
 * No imports: `scripts/check-folder-prefix.mjs` exercises these under Node's type
 * stripping, and Node resolves `.ts` imports only when the specifier says so.
 */

/** Join a POSIX directory and a name. `joinPath('/', 'home')` is `/home`. */
export function joinPath(dir: string, name: string): string {
  if (dir === '' || dir === '/') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The parent of a POSIX path; the root stays the root. */
export function parentPath(dir: string): string {
  if (dir === '' || dir === '/') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Collapse `.`, `..` and duplicate slashes into an absolute POSIX path. */
export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/**
 * Split a typed path into the directory to list and the name prefix to filter by.
 * A trailing slash (or the root) means "list this directory's children", so the
 * prefix is empty; otherwise the last segment is the prefix. That is what lets a
 * partial path such as `/home/yli/single` suggest every sibling starting with
 * `single`, even though `/home/yli/single` is not itself a directory.
 */
export function splitPrefix(input: string): { dir: string; prefix: string } {
  if (input === '/' || input.endsWith('/')) return { dir: input, prefix: '' };
  const idx = input.lastIndexOf('/');
  if (idx < 0) return { dir: '/', prefix: input };
  return { dir: idx === 0 ? '/' : input.slice(0, idx), prefix: input.slice(idx + 1) };
}
