export interface SearchLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface SearchMatch extends SearchLocation {
  preview: string;
  previewStart: number;
  previewEnd: number;
}

export interface SearchResponse {
  directory: string;
  files: { path: string; relativePath: string; matches: SearchMatch[] }[];
  returnedMatches: number;
  truncated: boolean;
  warnings: string[];
}

export interface SearchSelection {
  id: number;
  query: string;
  directory: string;
  custom: boolean;
  extensions: string[];
}

export function extensionForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** Curated fallback used to seed the typeahead before disk suggestions load. */
export const COMMON_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'md',
  'css',
  'scss',
  'html',
  'vue',
  'svelte',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'rb',
  'sh',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sql',
  'lua',
  'r',
];

// Mirrors the server-side rule: one or more literal suffixes, each separated by
// a dot, with no glob or flag metacharacters.
const EXTENSION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_+-]*(\.[A-Za-z0-9_+-]+)*$/;

/** Trim a typed extension token, or return null when it is not valid. */
export function normalizeExtensionToken(raw: string): string | null {
  const token = raw.trim().replace(/^\.+/, '');
  if (!token || token.length > 64 || !EXTENSION_PATTERN.test(token)) return null;
  return token;
}

/**
 * Rank typeahead suggestions for the current query, dropping already-selected
 * extensions. With a query, prefix matches come first.
 */
export function filterExtensionSuggestions(
  suggestions: string[],
  query: string,
  selected: string[],
  limit = 8,
): string[] {
  const selectedKeys = new Set(selected.map((extension) => extension.toLowerCase()));
  const needle = query.trim().replace(/^\.+/, '').toLowerCase();
  const matches = suggestions.filter(
    (extension) =>
      !selectedKeys.has(extension.toLowerCase()) &&
      (needle === '' || extension.toLowerCase().includes(needle)),
  );
  // With no query, keep the caller's ranking (disk frequency, then curated
  // order). With a query, put prefix matches first and alphabetize the rest.
  if (needle !== '') {
    matches.sort((a, b) => {
      const ai = a.toLowerCase().startsWith(needle) ? 0 : 1;
      const bi = b.toLowerCase().startsWith(needle) ? 0 : 1;
      return ai - bi || a.localeCompare(b);
    });
  }
  return matches.slice(0, limit);
}

/** Lexical normalization only: preserve symlink identity, as the file API does. */
export function normalizeCodePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
