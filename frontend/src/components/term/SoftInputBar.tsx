import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  PAGE_DOWN_SEQUENCE,
  PAGE_UP_SEQUENCE,
  type SoftCursorDir,
  cursorSequence,
} from '../../lib/termSoftKeys';

/**
 * The phone's terminal keypad.
 *
 * A soft keyboard has letters but no arrows, no PgUp/PgDn and no reliable
 * Escape, which makes a shell prompt painful and a full-screen app (vim, less,
 * htop) barely usable. The status bar's keyboard button expands this panel above
 * it: a text box with Send for the command line, then the keys a phone lacks.
 *
 * It is part of the tile, not of the shell, for two reasons: the input takes
 * space from the terminal (so xterm refits and the PTY is told the new size,
 * exactly as when a desktop window resizes), and the bytes can go through the
 * same door as typed keys (`term.input`), which keeps the line recorder — and the
 * shell's history — honest.
 */
export interface SoftInputBarProps {
  /** The session is attached and accepting input. */
  enabled: boolean;
  /** DECCKM: read from xterm at click time by the caller. */
  applicationCursorKeys: boolean;
  onSendText: (text: string) => void;
  onSendKeys: (bytes: string) => void;
  onCollapse: () => void;
}

const keyBtn =
  'grid h-9 min-w-11 shrink-0 place-items-center rounded-[6px] border border-white/10 bg-white/5 px-2 text-xs font-medium text-slate-200 transition active:bg-white/20 disabled:opacity-30';

const CURSOR_LABEL: Record<SoftCursorDir, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

export function SoftInputBar({
  enabled,
  applicationCursorKeys,
  onSendText,
  onSendKeys,
  onCollapse,
}: SoftInputBarProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the panel is a tap, so focusing here still counts as a user gesture
  // for the keyboard. The user can always tap the box themselves.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    if (!enabled) return;
    const text = value;
    if (text.length === 0) {
      // An empty box with Send is a bare Enter: "run what is on the line".
      onSendKeys('\r');
    } else {
      onSendText(text);
    }
    setValue('');
    // Keep focus: a phone should stay ready for the next command, and blurring
    // would collapse the keyboard and the panel with it.
    inputRef.current?.focus();
  };

  return (
    <div
      className="shrink-0 border-t border-white/10 bg-black/50 px-2 pt-1.5 pb-1 backdrop-blur-md"
      data-soft-input=""
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t('softInput.placeholder')}
          aria-label={t('softInput.placeholder')}
          enterKeyHint="send"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-[6px] border border-white/10 bg-black/40 px-2 font-mono text-sm text-slate-100 placeholder:text-white/30 focus-visible:border-sky-400/50 focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={!enabled}
          className="h-9 shrink-0 rounded-[6px] bg-sky-600/80 px-3 text-xs font-semibold text-white transition active:bg-sky-500 disabled:opacity-40"
        >
          {t('softInput.send')}
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-1">
        {(['left', 'up', 'down', 'right'] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            disabled={!enabled}
            aria-label={t(`softInput.${dir}`)}
            onClick={() => onSendKeys(cursorSequence(dir, applicationCursorKeys))}
            className={keyBtn}
          >
            {CURSOR_LABEL[dir]}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!enabled}
          aria-label={t('softInput.pageUp')}
          onClick={() => onSendKeys(PAGE_UP_SEQUENCE)}
          className={keyBtn}
        >
          {t('softInput.pageUp')}
        </button>
        <button
          type="button"
          disabled={!enabled}
          aria-label={t('softInput.pageDown')}
          onClick={() => onSendKeys(PAGE_DOWN_SEQUENCE)}
          className={keyBtn}
        >
          {t('softInput.pageDown')}
        </button>
        <button
          type="button"
          aria-label={t('softInput.collapse')}
          onClick={onCollapse}
          className={cn(keyBtn, 'bg-transparent')}
        >
          ⌄
        </button>
      </div>
    </div>
  );
}

/** The status-bar button that expands the panel. */
export function SoftInputIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4 9.5h8" />
    </svg>
  );
}
