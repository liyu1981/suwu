import { fetchJson, postJson } from './api';

/**
 * The System tools page's data. Everything here is server state: the browser
 * cannot write `~/.suwu/bin`, so installing is a POST the server performs and
 * the page re-reads the truth afterwards (docs/TOOLS_PLAN.md §9).
 */

export type ToolState = 'installed' | 'update' | 'missing' | 'unsupported' | 'unmanaged';

export interface ToolFileStamp {
  file: string;
  mode: string;
  sha256?: string;
}

/** One install, as the server recorded it. */
export interface ToolStamp {
  schema: number;
  name: string;
  version: string;
  goos: string;
  goarch: string;
  /** "tools" for an install from this page or the CLI, "suwu-max" for the bundle. */
  origin: string;
  installedAt: string;
  source?: string;
  files: ToolFileStamp[];
}

/** One catalog entry resolved against this machine. */
export interface ToolStatus {
  name: string;
  label: string;
  version: string;
  summary: string;
  homepage: string;
  license: string;
  requires?: string[];
  notes?: string;
  bundled?: string;
  state: ToolState;
  available: boolean;
  archive?: string;
  url?: string;
  installed?: ToolStamp;
  path: string;
  platforms: string[];
}

export interface ToolsSource {
  repo: string;
  ref: string;
  path: string;
  fetchedAt?: string;
  /** The refresh failed and this is the cached (or embedded) copy. */
  stale: boolean;
  /** Why the refresh failed, verbatim from the server. */
  error?: string;
  /** No request was needed: the cache was fresh. */
  cached: boolean;
}

export interface ToolsResponse {
  os: string;
  arch: string;
  binDir: string;
  source: ToolsSource;
  path: {
    enabled: boolean;
    /** Always an array; the server normalizes a nil slice to `[]`. */
    files: string[];
  };
  tools: ToolStatus[];
}

export interface InstallResult {
  name: string;
  version: string;
  files: string[];
  skipped: boolean;
  replaced: boolean;
}

export interface PathResult {
  enabled: boolean;
  files: string[];
  changed?: string[];
}

export function fetchTools(refresh = false): Promise<ToolsResponse> {
  return fetchJson<ToolsResponse>(`/api/tools${refresh ? '?refresh=1' : ''}`);
}

export function installTool(name: string, force = false): Promise<InstallResult> {
  return postJson<InstallResult>('/api/tools/install', { name, force });
}

export function uninstallTool(name: string): Promise<{ name: string; removed: string[] }> {
  return postJson<{ name: string; removed: string[] }>('/api/tools/uninstall', { name });
}

export function setToolsPath(enabled: boolean): Promise<PathResult> {
  return postJson<PathResult>('/api/tools/path', { enabled });
}

/**
 * The block `suwu tools path --enable` writes, shown to the user before the
 * click. It is prose here, not the source of truth: the server writes it.
 */
export function pathBlockPreview(binDir: string): string {
  return [
    '# >>> suwu-bin >>>',
    `case ":$PATH:" in *":${binDir}:"*) ;; *) PATH="${binDir}:$PATH" ;; esac`,
    'export PATH',
    '# <<< suwu-bin <<<',
  ].join('\n');
}
