/**
 * Terminal input-line tracking for the "Frequent inputs" shelf.
 *
 * The tile cannot ask the shell what the user is typing, and it cannot read the
 * prompt, so it reconstructs the current input line from the keystrokes xterm
 * forwards (a second `term.onData` listener, see useInputRecorder). This module
 * is the pure half of that: no atoms, no DOM, no xterm — so
 * `scripts/check-term-snippets.mjs` can exercise it under Node type stripping.
 *
 * It is a heuristic by construction: it sees what was typed, not what got
 * echoed, so anything the user typed at an invisible prompt (a password, an
 * ssh passphrase) looks exactly like a command. That is why the recorded
 * history lives in `sessionStorage` and never in a backup (see
 * store/termSnippets.ts and docs/TERM_FREQUENT_INPUTS_PLAN.md §3).
 */

/** Longest input line worth remembering. Longer lines are dropped, not cut. */
export const LINE_MAX = 500;

/**
 * Where an escape sequence that started in this chunk has got to. Escape
 * sequences are *not* guaranteed to arrive whole (a lone `ESC` from pressing
 * Esc, a two-byte Alt+key, or a split write), so the parser has to be
 * resumable rather than assuming one chunk holds a complete sequence.
 */
export type EscapePending = '' | 'esc' | 'csi' | 'byte';

/** Characters typed since the last Enter / clear, plus parser state. */
export interface LineState {
  text: string;
  /**
   * Set once a line grew past LINE_MAX. The line is dropped on submit instead
   * of being remembered truncated — a truncated command is worse than none,
   * because it looks runnable.
   */
  overflow: boolean;
  /** Escape sequence continuation, see EscapePending. */
  pending: EscapePending;
  /**
   * Bytes of the escape sequence in progress (`[200~`, `A`, …), so it can be
   * classified once its final byte arrives — possibly in a later chunk.
   * Bounded to ESCAPE_MAX in case a stream never terminates one.
   */
  seq: string;
  /**
   * The line can no longer be trusted, so it must not be remembered.
   *
   * Any escape sequence other than a bracketed-paste marker means the shell may
   * have changed the line in a way keystrokes cannot reveal: `↑` recalls a
   * command, `Tab` completes a path, `←`/`Home` move the insert point (so later
   * characters land somewhere other than the end of our buffer). Recording a
   * guess there would put a *wrong* command in the menu, and menu entries can
   * be run with one click — dropping the line is the safe trade. The shell's own
   * `history` still has the command.
   */
  stale: boolean;
  /**
   * Inside a bracketed paste (`\x1b[200~` … `\x1b[201~`). Paste bytes are
   * literal: newlines are part of the text, not submissions, exactly as the
   * shell's line editor will hold them until Enter.
   */
  pasting: boolean;
}

export const EMPTY_LINE: LineState = {
  text: '',
  overflow: false,
  pending: '',
  seq: '',
  stale: false,
  pasting: false,
};

export interface ConsumedInput {
  state: LineState;
  /** Trimmed, non-empty lines finalized by this chunk, in order. */
  submitted: string[];
}

const ESC = 0x1b;
const DEL = 0x7f;
const BS = 0x08;
const CR = 0x0d;
const LF = 0x0a;
const CTRL_C = 0x03;
const CTRL_U = 0x15;
const CTRL_L = 0x0c;

/** Longest escape sequence worth buffering for classification. */
const ESCAPE_MAX = 16;

/** The only escape sequences that carry input the line model can trust. */
const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * Feed one xterm `onData` chunk into the line state.
 *
 * Handles the cases that actually appear in a PTY input stream:
 *   - `\r` / `\n` finalize the line (so a free-typed multi-line block yields
 *     one submission per line);
 *   - backspace edits, Ctrl-C / Ctrl-U / Ctrl-L clear;
 *   - escape sequences (arrows, function keys, Alt+key, bracketed-paste markers
 *     `\x1b[200~` / `\x1b[201~`) are consumed. Everything between the paste
 *     markers is literal text — newlines included — so a pasted block stays one
 *     entry, like the shell's line editor holds it. Every other sequence marks
 *     the line stale (see LineState.stale), because the shell may have changed
 *     it in ways keystrokes cannot reveal;
 *   - other C0 controls are ignored rather than rendered as noise.
 *
 * Chunk boundaries are transparent: an escape sequence may arrive whole or one
 * byte at a time and the result is the same.
 */
export function consumeInput(state: LineState, chunk: string): ConsumedInput {
  let text = state.text;
  let overflow = state.overflow;
  let pending = state.pending;
  let seq = state.seq;
  let stale = state.stale;
  let pasting = state.pasting;
  const submitted: string[] = [];

  const submit = () => {
    if (!overflow && !stale) {
      const value = text.trim();
      if (value) submitted.push(value);
    }
    text = '';
    overflow = false;
    stale = false;
    pending = '';
    seq = '';
  };

  /** A sequence just ended: keep the trust we have, or lose it. */
  const endEscape = () => {
    if (seq === PASTE_START) pasting = true;
    else if (seq === PASTE_END) pasting = false;
    else stale = true;
    pending = '';
    seq = '';
  };

  /** Append one byte to the line, honoring the length cap. */
  const append = (byte: string) => {
    if (overflow) return;
    if (text.length >= LINE_MAX) {
      overflow = true;
      return;
    }
    text += byte;
  };

  for (let i = 0; i < chunk.length; i += 1) {
    const code = chunk.charCodeAt(i);

    // Mid-escape: collect, never touch the line.
    if (pending === 'esc') {
      if (code === 0x5b /* [ */) {
        pending = 'csi';
        seq += '[';
      } else if (code === 0x4f /* O */) {
        pending = 'byte';
        seq += 'O';
      } else {
        // Alt+<key>: the next byte belongs to the sequence.
        seq += chunk[i];
        endEscape();
      }
      continue;
    }
    if (pending === 'byte') {
      seq += chunk[i];
      endEscape();
      continue;
    }
    if (pending === 'csi') {
      seq = seq.length < ESCAPE_MAX ? seq + chunk[i] : seq;
      // Parameters/intermediates sit below 0x40; the final byte ends the CSI.
      if (code >= 0x40 && code <= 0x7e) endEscape();
      continue;
    }

    if (code === ESC) {
      pending = 'esc';
      seq = '';
      continue;
    }
    // Inside a bracketed paste every byte is content, including newlines and
    // control characters; the shell has not executed anything yet.
    if (pasting) {
      append(chunk[i]);
      continue;
    }
    if (code === CR || code === LF) {
      submit();
      continue;
    }
    if (code === DEL || code === BS) {
      if (!overflow) text = text.slice(0, -1);
      continue;
    }
    if (code === CTRL_C || code === CTRL_U || code === CTRL_L) {
      // The line is gone (and so is any doubt about what was on it).
      text = '';
      overflow = false;
      stale = false;
      pending = '';
      seq = '';
      continue;
    }
    if (code < 0x20) continue;

    append(chunk[i]);
  }

  return { state: { text, overflow, pending, seq, stale, pasting }, submitted };
}

/**
 * What to send to the PTY for one entry.
 *
 * A single line goes out verbatim. A multi-line entry is wrapped in bracketed
 * paste when the shell asked for it (`term.modes.bracketedPasteMode`), so bash
 * and zsh accept it as one paste instead of executing every line as it
 * arrives. Without bracketed paste the raw newlines are the only option and the
 * user gets whatever their shell does with a multi-line paste. `run` appends a
 * single Enter, which is what "insert and run" means for both shapes.
 */
export function buildPayload(text: string, run: boolean, bracketedPaste: boolean): string {
  const body = text.replace(/[\r\n]+$/, '');
  // Nothing but spaces is not worth inserting; "run" still means one Enter.
  if (!body.trim()) return run ? '\r' : '';
  const multiline = /[\r\n]/.test(body);
  const normalized = multiline ? body.replace(/\r\n?/g, '\n') : body;
  const payload = multiline && bracketedPaste ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  return run ? `${payload}\r` : payload;
}
