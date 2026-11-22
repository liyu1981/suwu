/**
 * The bytes a phone's soft-input panel sends.
 *
 * A phone keyboard has no arrow keys, no PgUp/PgDn and no reliable Escape, so the
 * panel under the terminal supplies them. The sequences are the ones a terminal
 * expects, not the ones a keyboard would produce:
 *
 * - arrows depend on DECCKM (application cursor keys): a full-screen app such as
 *   vim or less switches it on and then expects `ESC O A`, while a shell prompt
 *   wants `ESC [ A`. Sending the wrong pair moves the cursor in some apps and
 *   prints `^[[A` in others, which is why the mode is read from xterm at click
 *   time instead of being assumed.
 * - PgUp/PgDn are the xterm sequences (`ESC [ 5 ~` / `ESC [ 6 ~`), which readline,
 *   less and tmux all understand.
 *
 * Keep the text exactly as typed, case and spaces included: the user's input is
 * data, and only the trailing carriage return is added (by buildPayload).
 */
export type SoftCursorDir = 'up' | 'down' | 'left' | 'right';

const CURSOR_FINAL: Record<SoftCursorDir, string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/** Arrow-key bytes for a normal or an application-cursor-keys terminal. */
export function cursorSequence(dir: SoftCursorDir, applicationCursorKeys: boolean): string {
  return `${applicationCursorKeys ? '\u001bO' : '\u001b['}${CURSOR_FINAL[dir]}`;
}

/**
 * Tab is a control character, not four spaces: a shell wants it for completion,
 * a TUI form for moving to the next field, and `less`/`vim` for indenting. A
 * phone keyboard has no Tab at all, which is why the panel carries one.
 */
export const TAB_SEQUENCE = '\t';

export const PAGE_UP_SEQUENCE = '\u001b[5~';
export const PAGE_DOWN_SEQUENCE = '\u001b[6~';

/**
 * What to send for the panel's text box: the text untouched, or null when there
 * is nothing to send. Whitespace-only input is still sent — `  ` followed by
 * Enter is a legitimate thing to type into a shell that is waiting for input.
 */
export function softInputText(raw: string): string | null {
  return raw.length > 0 ? raw : null;
}
