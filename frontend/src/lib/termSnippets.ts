/**
 * The "Frequent inputs" shelf — model and list operations.
 *
 * Pure data: types, limits, and the list transforms the tile needs (add/edit
 * a snippet, remember a submitted line, order by recency). Persistence lives in
 * store/termSnippets.ts, the UI in components/term/. Kept dependency-free so
 * `scripts/check-term-snippets.mjs` can import it under Node type stripping.
 *
 * Scope, deliberately: **snippets are durable, history is not**. Snippets are
 * user-authored and belong in localStorage (and therefore in a backup);
 * history is incidental keystroke capture that may contain anything typed at
 * any prompt, so it stays in sessionStorage and is denied to backups.
 */

import { LINE_MAX } from './termInput.ts';

/** A named, reusable input the user saved on purpose. */
export interface TermSnippet {
  id: string;
  /** What gets inserted. May be multi-line. */
  text: string;
  /** Optional display name; falls back to the first line of `text`. */
  label?: string;
  /**
   * Send an Enter after the text, so selecting the snippet runs it.
   *
   * Most snippets are things you want to tweak before running; the ones ticked
   * here are commands you run as-is, and one click should be enough.
   */
  autoReturn?: boolean;
  createdAt: number;
  lastUsedAt?: number;
  useCount?: number;
}

/** One submitted line from the current browser session. */
export interface RecentInput {
  text: string;
  at: number;
}

/** Upper bound on saved snippets — tiny lists stay scannable in a popover. */
export const SNIPPETS_MAX = 200;

/** Upper bound on remembered lines; the popover only ever shows a screenful. */
export const RECENTS_MAX = 50;

/** Stable id generator with the same fallback used by the PTY session key. */
export function newSnippetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a snippet from a text (and optional name) without an id collision. */
export function makeSnippet(
  text: string,
  options: { label?: string; autoReturn?: boolean } = {},
  now = Date.now(),
): TermSnippet {
  return {
    id: newSnippetId(),
    text: text.trim(),
    label: normalizeLabel(options.label),
    autoReturn: options.autoReturn || undefined,
    createdAt: now,
  };
}

function normalizeLabel(label?: string): string | undefined {
  const value = label?.trim();
  return value ? value : undefined;
}

/**
 * Add a snippet to the front, or replace one in place by id (an edit should not
 * reorder the list under the user's cursor).
 */
export function upsertSnippet(list: TermSnippet[], next: TermSnippet): TermSnippet[] {
  const index = list.findIndex((s) => s.id === next.id);
  if (index === -1) return [next, ...list].slice(0, SNIPPETS_MAX);
  const copy = [...list];
  copy[index] = next;
  return copy.slice(0, SNIPPETS_MAX);
}

export function removeSnippet(list: TermSnippet[], id: string): TermSnippet[] {
  return list.filter((s) => s.id !== id);
}

/** Bump usage so a frequently used snippet floats to the top of the menu. */
export function markSnippetUsed(list: TermSnippet[], id: string, now = Date.now()): TermSnippet[] {
  return list.map((s) =>
    s.id === id ? { ...s, lastUsedAt: now, useCount: (s.useCount ?? 0) + 1 } : s,
  );
}

/**
 * Remember one submitted line: dedupe by exact text (moving the repeat to the
 * front), drop empties and over-long lines, cap the list.
 */
export function pushRecent(list: RecentInput[], text: string, now = Date.now()): RecentInput[] {
  const value = text.trim();
  if (!value || value.length > LINE_MAX) return list;
  if (list.length > 0 && list[0].text === value) {
    // Re-running the same command should not churn the timestamp.
    return list;
  }
  return [{ text: value, at: now }, ...list.filter((entry) => entry.text !== value)].slice(
    0,
    RECENTS_MAX,
  );
}

/** Whether selecting this snippet should also press Enter. */
export function runsOnSelect(snippet: TermSnippet): boolean {
  return snippet.autoReturn === true;
}

/**
 * Display order for the saved section: most recently used first, and a
 * never-used snippet falls back to when it was written (so a brand new snippet
 * lands at the top instead of at the bottom).
 */
export function orderSnippets(list: TermSnippet[]): TermSnippet[] {
  const recency = (s: TermSnippet) => s.lastUsedAt ?? s.createdAt;
  return [...list].sort((a, b) => recency(b) - recency(a) || b.createdAt - a.createdAt);
}

/** First line of a possibly multi-line entry, for single-line row rendering. */
export function firstLine(text: string): string {
  const index = text.search(/[\r\n]/);
  return index === -1 ? text : text.slice(0, index);
}

export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/** Case-insensitive match over the text and the optional label. */
export function matchesQuery(item: { text: string; label?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return item.text.toLowerCase().includes(q) || (item.label ?? '').toLowerCase().includes(q);
}
