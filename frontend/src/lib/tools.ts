import { fetchJson, postJson } from './api';

/**
 * The System tools page's data. Everything here is server state: the browser
 * cannot write `~/.suwu/bin`, so installing is a POST the server performs and
 * the page re-reads the truth afterwards (docs/TOOLS_PLAN.md §9).
 */

export type ToolState = 'installed' | 'update' | 'missing' | 'unsupported' | 'unmanaged' | 'manual';

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
  /** True for a tool Suwu cannot install: it only points at the instruction. */
  manual?: boolean;
  /** The command a manual row asks the user to run. */
  instruction?: string;
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
  /** Set when this build's tag has no catalog yet and `master` answered. */
  fallbackFrom?: string;
  /** No request was needed: the cache was fresh. */
  cached: boolean;
}

/** The optional shell integration of fzf and asdf. */
export interface ToolSetupState {
  name: string;
  enabled: boolean;
  /** Always an array; the server normalizes a nil slice to `[]`. */
  files: string[];
  /** The line the setup writes, for the UI hint. */
  command: string;
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
  /** Keyed by tool name; only fzf and asdf currently have an entry. */
  setup: Record<string, ToolSetupState>;
  tools: ToolStatus[];
}

export interface InstallResult {
  name: string;
  version: string;
  files: string[];
  skipped: boolean;
  replaced: boolean;
}

export interface ToolSetupResult extends ToolSetupState {
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

/**
 * Add or remove a tool's optional shell setup. The tool directory itself is
 * always on PATH; this is the extra integration fzf and asdf need.
 */
export function setToolSetup(name: string, enabled: boolean): Promise<ToolSetupResult> {
  return postJson<ToolSetupResult>('/api/tools/setup', { name, enabled });
}
