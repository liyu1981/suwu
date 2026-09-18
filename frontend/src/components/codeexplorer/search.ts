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
  extension: string;
}

export function extensionForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
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
