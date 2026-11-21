/**
 * Baikal (herdr-core) tile: the shapes the server sends and the pure helpers the
 * panel needs.
 *
 * A space is one herdr-core workspace: a stable id, a name derived from its
 * identity terminal's directory (`~/suwu-dev` -> "suwu-dev", inside a git repo
 * the repository's name), and the terminals that carry `space=<id>`. Terminals
 * with no label are "unassigned" and are grouped by their own directory here.
 */

export type BaikalAgentStatus = {
  state: string; // idle | working | done | blocked | error
  title?: string;
  msg?: string;
  app?: string;
  kind?: string;
  progress?: number | null;
};

export type BaikalTerminal = {
  address: string;
  name: string;
  title: string;
  agent: string;
  cwd: string;
  state: string;
  live: boolean;
  status?: BaikalAgentStatus | null;
  labels?: Record<string, string>;
  createdMs: number;
  spaceId?: string;
};

export type BaikalSpace = {
  id: string;
  name: string;
  customName?: string;
  identityCwd: string;
  identityTerminal?: string;
  colour: string;
  order?: number;
  /** When the space's first terminal was opened (spaces list in this order). */
  createdMs?: number;
  synthetic?: boolean;
  terminals: BaikalTerminal[];
};

export type BaikalSnapshot = {
  core: { version: string; name: string; session: string; features?: string[] };
  spaces: BaikalSpace[];
  unassigned: BaikalTerminal[];
};

export type BaikalTab = {
  /** Stable per tile; the terminal address is the identity. */
  id: string;
  terminal: string;
  title: string;
  observe: boolean;
};

/** The tone a status word paints: one of the palette keys below. */
export type StatusTone = 'working' | 'done' | 'blocked' | 'error' | 'idle' | 'none';

export function statusTone(status?: BaikalAgentStatus | null): StatusTone {
  switch (status?.state) {
    case 'working':
      return 'working';
    case 'done':
      return 'done';
    case 'blocked':
    case 'permission':
    case 'question':
    case 'auth':
      return 'blocked';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
    default:
      return 'none';
  }
}

/** The dot colour class for a tone (Tailwind classes used by the panel). */
export const TONE_DOT: Record<StatusTone, string> = {
  working: 'bg-amber-400',
  done: 'bg-green-500',
  blocked: 'bg-orange-400',
  error: 'bg-red-500',
  idle: 'bg-slate-500',
  none: 'bg-white/20',
};

/** Space accent classes, keyed by the palette name the server chose. */
export const SPACE_COLOURS: Record<string, { dot: string; text: string }> = {
  sky: { dot: 'bg-sky-400', text: 'text-sky-300' },
  emerald: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  amber: { dot: 'bg-amber-400', text: 'text-amber-300' },
  violet: { dot: 'bg-violet-400', text: 'text-violet-300' },
  rose: { dot: 'bg-rose-400', text: 'text-rose-300' },
  cyan: { dot: 'bg-cyan-400', text: 'text-cyan-300' },
  lime: { dot: 'bg-lime-400', text: 'text-lime-300' },
  orange: { dot: 'bg-orange-400', text: 'text-orange-300' },
};

export function spaceColour(colour: string): { dot: string; text: string } {
  return SPACE_COLOURS[colour] ?? SPACE_COLOURS.sky;
}

/**
 * What a terminal row shows as its title: the user's name, else the program's
 * own title, else the address. A shell in a directory is not interesting by
 * itself — the space already names the directory.
 */
export function terminalTitle(terminal: BaikalTerminal): string {
  if (terminal.name && terminal.name !== terminal.address) return terminal.name;
  const title = terminal.title?.trim();
  if (title) return title;
  return terminal.address;
}

/**
 * A terminal offered on its own, with nothing else to place it: the title and the
 * address — `suwu-dev (t12)`.
 *
 * A list of bare names is ambiguous: two shells started in the same directory
 * share the name the core derives from it, and a name says nothing about which
 * terminal an action will hit. The address is the identity — the thing the attach,
 * the kill and the assign all take — so it is shown in parentheses, once, and not
 * repeated when the name *is* the address.
 */
export function terminalLabel(terminal: BaikalTerminal): string {
  const title = terminalTitle(terminal);
  if (title === terminal.address) return terminal.address;
  return `${title} (${terminal.address})`;
}

/** The one-word "what is it doing" line under a row. */
export function terminalSubtitle(terminal: BaikalTerminal): string {
  if (terminal.status?.msg) return terminal.status.msg;
  if (terminal.status?.title) return terminal.status.title;
  if (terminal.agent) return terminal.agent;
  return terminal.address;
}

/**
 * Spaces in creation order — the oldest first, new ones appended. Renaming a
 * space does not move it: the list is a history of what you opened, not an index.
 * Ties (same millisecond, or an old snapshot without the field) fall back to the
 * id so the order is still stable.
 */
export function sortSpaces(spaces: BaikalSpace[]): BaikalSpace[] {
  return [...spaces].sort((a, b) => {
    const created = (a.createdMs ?? 0) - (b.createdMs ?? 0);
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
}

/** The letter shown on a space's badge (first character, upper case). */
export function spaceInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '·';
  const first = [...trimmed][0];
  return first.toUpperCase();
}

/**
 * The agents list: every terminal that announced itself over OSC 7501, in the
 * order the terminals were opened.
 *
 * Deliberately *not* sorted by state. A row that jumps to the top when an agent
 * starts working and drops back when it finishes cannot be learned: you reach for
 * a position and what you wanted has moved. The status dot says what an agent is
 * doing; the position says which one it is.
 */
export function listAgents(terminals: BaikalTerminal[]): BaikalTerminal[] {
  return terminals
    .filter((terminal) => terminal.live && terminal.status)
    .sort((a, b) => a.createdMs - b.createdMs || a.address.localeCompare(b.address));
}

/**
 * Unassigned terminals grouped by directory, so a `herdr-core run` started from
 * a shell still appears somewhere sensible. Stable order: by path.
 */
export function groupUnassigned(
  terminals: BaikalTerminal[],
): { cwd: string; name: string; terminals: BaikalTerminal[] }[] {
  const groups = new Map<string, BaikalTerminal[]>();
  for (const terminal of terminals) {
    const key = terminal.cwd || '';
    const list = groups.get(key);
    if (list) list.push(terminal);
    else groups.set(key, [terminal]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cwd, list]) => ({
      cwd,
      name: cwd ? cwd.split('/').filter(Boolean).pop() || cwd : terminalTitle(list[0]),
      terminals: list,
    }));
}

/** A tab for a terminal, deduped by address. */
export function makeTab(terminal: BaikalTerminal, observe = false): BaikalTab {
  return {
    id: terminal.address,
    terminal: terminal.address,
    title: terminalTitle(terminal),
    observe,
  };
}

/**
 * Add or activate a tab. Opening a terminal that is already open activates it
 * instead of duplicating it — the same terminal cannot be viewed twice on one
 * page (it would fight over input and size).
 */
export function openTab(
  tabs: BaikalTab[],
  terminal: BaikalTerminal,
  observe = false,
): { tabs: BaikalTab[]; activeId: string } {
  const existing = tabs.find((t) => t.terminal === terminal.address);
  if (existing) return { tabs, activeId: existing.id };
  const tab = makeTab(terminal, observe);
  return { tabs: [...tabs, tab], activeId: tab.id };
}

/** Keep the tab titles following the terminals they show. */
export function syncTabTitles(tabs: BaikalTab[], terminals: BaikalTerminal[]): BaikalTab[] {
  const byAddress = new Map(terminals.map((t) => [t.address, t]));
  let changed = false;
  const next = tabs.map((tab) => {
    const terminal = byAddress.get(tab.terminal);
    if (!terminal) return tab;
    const title = terminalTitle(terminal);
    if (title === tab.title) return tab;
    changed = true;
    return { ...tab, title };
  });
  return changed ? next : tabs;
}

/**
 * Close a tab and pick what to show next: the one after it, else the one before,
 * else nothing.
 */
export function closeTab(
  tabs: BaikalTab[],
  activeId: string,
  id: string,
): { tabs: BaikalTab[]; activeId: string } {
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return { tabs, activeId };
  const next = tabs.filter((t) => t.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const fallback = next[index] ?? next[index - 1];
  return { tabs: next, activeId: fallback?.id ?? '' };
}

/** Terminals that are live but not yet open as tabs (for the "+" picker). */
export function closableTabs(tabs: BaikalTab[], live: BaikalTerminal[]): BaikalTab[] {
  const addresses = new Set(live.map((t) => t.address));
  return tabs.filter((tab) => addresses.has(tab.terminal));
}
