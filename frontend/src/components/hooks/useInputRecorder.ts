import { useCallback, useEffect, useRef } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import type { Terminal } from '@xterm/xterm';
import { EMPTY_LINE, consumeInput, type LineState } from '../../lib/termInput';
import { pushRecent } from '../../lib/termSnippets';
import {
  termRecentsAtom,
  termRecordInputsAtom,
  termShelfSettingsAtom,
} from '../../store/termSnippets';

/**
 * Tracks the shell's input line and records submitted commands into the
 * session's recent-input list.
 *
 * Two input paths feed it, and both must, or the model diverges from what the
 * shell actually holds:
 *
 *   - typed keys — a *second* `term.onData` listener (xterm supports several,
 *     so usePtySession's input path is untouched);
 *   - text the tile sends itself (`sendRaw`, used by the snippet menu) — that
 *     bypasses `onData`, so FullTerminal feeds the same bytes to `recordSent`.
 *     Without this, inserting a snippet and pressing Enter would remember only
 *     the typed prefix — a wrong command in the history, worse than a missing
 *     one.
 *
 * `getCurrentLine()` lets the menu offer "save what I'm typing" for text that
 * has not been submitted yet.
 */
export function useInputRecorder(
  term: Terminal | null,
  options: { paused?: boolean } = {},
): { getCurrentLine: () => string; recordSent: (payload: string) => void } {
  const [, setRecents] = useAtom(termRecentsAtom);
  const record = useAtomValue(termRecordInputsAtom);
  const { recentsKept } = useAtomValue(termShelfSettingsAtom);

  const stateRef = useRef<LineState>(EMPTY_LINE);
  // Read through refs inside the listener so toggling the preference (or
  // entering selection mode) never has to re-register the listener.
  const recordRef = useRef(record);
  recordRef.current = record;
  const pausedRef = useRef(Boolean(options.paused));
  pausedRef.current = Boolean(options.paused);

  const setRecentsRef = useRef(setRecents);
  setRecentsRef.current = setRecents;
  // The history cap is a setting, so read it through a ref too — changing it
  // must not re-register the listener.
  const recentsKeptRef = useRef(recentsKept);
  recentsKeptRef.current = recentsKept;

  /** Advance the line model (and remember anything that got submitted). */
  const feed = useCallback((payload: string) => {
    const { state, submitted } = consumeInput(stateRef.current, payload);
    stateRef.current = state;
    if (!recordRef.current || pausedRef.current || submitted.length === 0) return;
    setRecentsRef.current((list) =>
      submitted.reduce(
        (entries, line) => pushRecent(entries, line, Date.now(), recentsKeptRef.current),
        list,
      ),
    );
  }, []);

  useEffect(() => {
    if (!term) return;
    const subscription = term.onData(feed);
    return () => subscription.dispose();
  }, [term, feed]);

  // An untrustworthy line is not offered for saving either: the whole point of
  // the guard is to never surface a command the user did not type.
  const getCurrentLine = useCallback(() => {
    const { text, stale, overflow } = stateRef.current;
    return stale || overflow ? '' : text;
  }, []);

  return { getCurrentLine, recordSent: feed };
}
