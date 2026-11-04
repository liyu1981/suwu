import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import type { RecentInput, TermSnippet } from '../lib/termSnippets';

/**
 * Persisted "Frequent inputs" state.
 *
 * Every /term pane is its own document, so these atoms are the cross-pane
 * channel: `atomWithStorage` reads the same backing store in each iframe and
 * `storage` events keep the panes in sync — the pattern used by
 * store/appearance.ts for font family, theme and line height.
 *
 * Two different scopes, on purpose (docs/TERM_FREQUENT_INPUTS_PLAN.md §3):
 *
 *   suwu.term-snippets        localStorage    user-authored, survives reloads
 *   suwu.term-record-inputs   localStorage    a preference, survives reloads
 *   suwu.term-recents         sessionStorage  keystroke capture, tab-scoped only
 *
 * The history is deliberately *not* durable: the recorder sees what was typed,
 * not what was echoed, so a secret typed at an invisible prompt is
 * indistinguishable from a command. Session scope means it can survive F5 but
 * never reaches a backup or another device (it is in DENY in
 * lib/backup/registry.ts). The shell's own `history` remains the long-term
 * record.
 */

/** Saved inputs (localStorage). */
export const termSnippetsAtom = atomWithStorage<TermSnippet[]>(
  'suwu.term-snippets',
  [],
  undefined,
  { getOnInit: true },
);

/** Submitted lines for this browser session (sessionStorage). */
export const termRecentsAtom = atomWithStorage<RecentInput[]>(
  'suwu.term-recents',
  [],
  createJSONStorage<RecentInput[]>(() => sessionStorage),
  { getOnInit: true },
);

/** Whether typed input is recorded into the history at all. */
export const termRecordInputsAtom = atomWithStorage<boolean>(
  'suwu.term-record-inputs',
  true,
  undefined,
  { getOnInit: true },
);
