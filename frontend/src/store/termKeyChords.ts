import { atomWithStorage } from 'jotai/utils';
import type { ChordEntry } from '../lib/keyChords';

/**
 * Remembered key combinations for the terminal tile's "send a key" menu.
 *
 * Unlike the recorded input history in store/termSnippets.ts, this lives in
 * localStorage: a combination is not secret text, it is a shortcut the user
 * wrote on purpose (`ctrl+shift+a`), so it is worth keeping across reloads and
 * worth carrying to another device in a backup (see lib/backup/registry.ts).
 */
export const termKeyChordsAtom = atomWithStorage<ChordEntry[]>(
  'suwu.term-key-chords',
  [],
  undefined,
  { getOnInit: true },
);
