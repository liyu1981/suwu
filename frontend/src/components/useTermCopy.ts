import { useEffect } from "react";
import type { Terminal } from "@xterm/xterm";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard writes need a secure context; ignore failures (e.g. plain HTTP).
  }
}

async function pasteText(term: Terminal) {
  try {
    const text = await navigator.clipboard.readText();
    // paste() normalizes line endings and applies bracketed-paste mode when
    // the running program enabled it, so paste into editors stays safe.
    if (text) term.paste(text);
  } catch {
    // Clipboard reads need a secure context plus user-granted permission;
    // when denied there is no programmatic fallback available.
  }
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

/**
 * Selection & clipboard behavior for the terminal:
 * - Selecting text auto-copies to the clipboard when the selection settles.
 * - Ctrl+Shift+C / Cmd+C always copies; Ctrl+C copies only when a selection
 *   exists, otherwise ^C reaches the shell.
 * - Ctrl+V (on Linux/Windows) and Cmd+V / Ctrl+Shift+V (on macOS) paste from
 *   the system clipboard into the PTY.
 *
 * Paste needs an explicit handler on Linux/Windows: xterm maps the Ctrl+V
 * keydown to a literal ^V (0x16, readline quoted-insert) and cancels the
 * event, so the browser's native paste action — and the `paste` DOM event
 * xterm would normally translate into terminal input — never fires. With the
 * key intercepted here, we read the clipboard via the async API and feed it
 * through term.paste() instead. On macOS Cmd+V still relies on the native
 * `paste` event (no permission prompt), so only bare Ctrl+V is claimed there.
 */
export function useTermCopy(term: Terminal | null) {
  useEffect(() => {
    if (!term) return;

    let last = "";
    let timer: number | undefined;
    const onSelectionChange = term.onSelectionChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = term.getSelection();
        if (sel && sel !== last) {
          last = sel;
          void copyText(sel);
        }
      }, 250);
    });

    term.attachCustomKeyEventHandler((e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta || e.altKey) return true;
      const key = e.key.toLowerCase();

      if (key === "c") {
        const sel = term.getSelection();
        if (!sel) return true;
        e.preventDefault();
        void copyText(sel);
        return false;
      }

      // Bare Ctrl+V: paste instead of sending ^V to the shell (non-mac).
      // Ctrl+Shift+V falls through to the native paste-as-plain-text path,
      // which xterm handles via the `paste` DOM event.
      if (key === "v" && !isMac && e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        void pasteText(term);
        return false;
      }

      return true;
    });

    return () => {
      onSelectionChange.dispose();
      window.clearTimeout(timer);
    };
  }, [term]);
}
