import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  INSERT_TOKENS,
  chordBytesLabel,
  displayTokens,
  encodePart,
  encodeSequence,
  parseSequence,
  pushChord,
  removeChord,
  sequenceLabel,
  splitSequence,
  type ChordError,
} from '../../lib/keyChords';
import { termKeyChordsAtom } from '../../store/termKeyChords';
import { TrashIcon } from '../icons';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/**
 * "Send a key" — the popover that sits immediately left of "Frequent inputs" in
 * the terminal status bar.
 *
 * The field is a **normal text input**. It does not capture keystrokes: arrows
 * move the caret, Ctrl+A selects, Backspace deletes, and nothing is swallowed
 * except Enter (send) and Escape (close). Keys are *written* — `ctrl+shift+a` —
 * or assembled from the chip row, which inserts `ctrl+` for a modifier and
 * `esc ` for a key. Whitespace separates keys of a sequence, so `esc space b`
 * sends Escape, then a space, then `b`.
 *
 * Readability comes from a **pill mirror**: the value is tokenised
 * (`displayTokens`) and drawn behind the input, with key names in pills and
 * characters literal. The input's own text is transparent and its caret is
 * visible, so the browser keeps doing all the editing while `ctrl` and `space`
 * read as keys instead of words. The mirror repeats the input's exact
 * characters and font metrics (no padding, no border — a box-shadow ring), which
 * is what keeps the caret aligned.
 *
 * See lib/keyChords.ts for the encoding rules and why they mirror xterm.js.
 */
interface KeyChordMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger button (rendered asChild by the popover). */
  trigger: ReactNode;
  /** DECCKM: arrow/Home/End encodings differ while the app owns the cursor. */
  applicationCursorKeys: boolean;
  /** Send the bytes to the PTY; false when it is not attached. */
  onSend: (bytes: string) => boolean;
  /** Called after the popover closes, so the caller can restore focus. */
  onClosed: () => void;
}

const ERROR_KEYS: Record<ChordError, string> = {
  empty: 'terminal.keys.errorEmpty',
  'missing-key': 'terminal.keys.errorMissingKey',
  'unknown-key': 'terminal.keys.errorUnknownKey',
  meta: 'terminal.keys.errorMeta',
  unsupported: 'terminal.keys.errorUnsupported',
};

/**
 * The pill view of a value. Shared by the editing mirror and the history rows,
 * so a stored sequence reads exactly like the one being typed.
 */
function ChordPills({ text, className }: { text: string; className?: string }) {
  const tokens = displayTokens(text);
  return (
    <span className={cn('whitespace-pre', className)}>
      {tokens.map((token, index) => {
        if (token.pill !== undefined) {
          return (
            <span
              key={index}
              // No horizontal padding and no border: the span must occupy the
              // same advance as the characters it covers, or the caret drifts.
              className="rounded-[3px] bg-white/10 text-sky-200/90 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]"
            >
              {token.pill}
            </span>
          );
        }
        if (token.space) {
          // The separator, made visible as a baseline rule. Same characters,
          // same advance — only a border underneath, which cannot move text.
          return (
            <span key={index} className="border-b border-dashed border-white/30">
              {token.text}
            </span>
          );
        }
        return <span key={index}>{token.text}</span>;
      })}
    </span>
  );
}

export function KeyChordMenu({
  open,
  onOpenChange,
  trigger,
  applicationCursorKeys,
  onSend,
  onClosed,
}: KeyChordMenuProps) {
  const { t } = useTranslation();
  const [chords, setChords] = useAtom(termKeyChordsAtom);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => (text ? parseSequence(text) : null), [text]);
  const bytes = useMemo(
    () => (text ? encodeSequence(text, { applicationCursorKeys }) : null),
    [text, applicationCursorKeys],
  );

  const error = parsed && !parsed.ok ? ERROR_KEYS[parsed.error] : null;
  // Parsed but unencodable (Ctrl+1, a plus with Ctrl…): say why rather than
  // leaving the send button mysteriously disabled.
  const notEncodable = Boolean(parsed?.ok) && !bytes;

  // Keep the mirror scrolled with the input: same text, so the same offset.
  const syncScroll = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.scrollLeft = input.scrollLeft;
  }, []);
  useEffect(syncScroll, [text, syncScroll]);

  const send = useCallback(() => {
    if (!bytes) return;
    const result = parseSequence(text);
    if (!result.ok) return;
    if (!onSend(bytes)) return;
    setChords((list) => pushChord(list, result.sequence.spec, Date.now()));
    setText('');
    // Sending ends the interaction; the close handler restores terminal focus so
    // whatever is typed next reaches the shell.
    onOpenChange(false);
  }, [bytes, onOpenChange, onSend, setChords, text]);

  const sendSpec = useCallback(
    (spec: string) => {
      const encoded = encodeSequence(spec, { applicationCursorKeys });
      if (!encoded) return;
      if (!onSend(encoded)) return;
      setChords((list) => pushChord(list, spec, Date.now()));
      onOpenChange(false);
    },
    [applicationCursorKeys, onOpenChange, onSend, setChords],
  );

  /**
   * Insert a chip's fragment at the caret. Modifiers are not doubled: clicking
   * Ctrl twice in the same combination is a slip, not an intention.
   */
  const insertToken = useCallback(
    (fragment: string, modifier?: boolean) => {
      const input = inputRef.current;
      if (modifier) {
        const tokens = text.trimEnd().split(/[\s+]/);
        if (tokens[tokens.length - 1]?.toLowerCase() === fragment.replace('+', '')) return;
      }
      const start = input?.selectionStart ?? text.length;
      const end = input?.selectionEnd ?? start;
      // Keep the new key from fusing with what precedes it: inserting `space `
      // straight after `ctrl+b` used to produce the word `bspace`, which is how
      // a pill silently turned into unparseable text. A separator is only added
      // when the caret does not already sit after whitespace or a `+`.
      const previous = start > 0 ? text[start - 1] : '';
      const lead = previous && !/[\s+]/.test(previous) ? ' ' : '';
      const insert = lead + fragment;
      const next = text.slice(0, start) + insert + text.slice(end);
      setText(next);
      const caret = start + insert.length;
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(caret, caret);
        syncScroll();
      });
    },
    [syncScroll, text],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // The only two keys this field claims; everything else is native editing.
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      // Let Radix close the popover, which restores terminal focus.
    }
  };

  const parts = useMemo(() => (text ? splitSequence(text) : []), [text]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className="flex max-h-[min(26rem,64vh)] w-[min(23rem,calc(100vw-1rem))] flex-col p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // Close back into the terminal, not into the status-bar button.
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
          {/* The pill mirror sits under the input; both use identical metrics. */}
          <div className="relative min-w-0 flex-1">
            <div
              ref={mirrorRef}
              aria-hidden
              className="pointer-events-none overflow-hidden whitespace-pre text-sm leading-5 text-white/90"
            >
              {text ? (
                <ChordPills text={text} className="font-mono" />
              ) : (
                <span className="font-sans text-white/35">{t('terminal.keys.placeholder')}</span>
              )}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={text}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              onScroll={syncScroll}
              aria-label={t('terminal.keys.placeholder')}
              className="absolute inset-0 w-full bg-transparent font-mono text-sm leading-5 text-transparent caret-white outline-none selection:bg-sky-500/30"
            />
          </div>
          <button
            type="button"
            onClick={send}
            disabled={!bytes}
            className="shrink-0 rounded bg-sky-600 px-2 py-0.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('terminal.keys.send')}
          </button>
        </div>

        {/* The bytes, part by part. This is the honesty half of the
            Ctrl+Shift+letter collapse, and why a sequence is not a guess. */}
        <div className="flex min-h-6 shrink-0 items-center gap-1 px-2 py-1">
          {parts.length > 0 ? (
            <>
              <span className="truncate text-[11px] text-white/40">
                {error
                  ? t(error, { key: parsed && !parsed.ok ? (parsed.token ?? '') : '' })
                  : notEncodable
                    ? t('terminal.keys.errorUnsupported')
                    : t('terminal.keys.byteHint')}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px]">
                {parts.map((part, index) => {
                  const partBytes = encodePart(part, { applicationCursorKeys });
                  return (
                    <kbd
                      key={`${part}-${index}`}
                      className="rounded border border-white/10 bg-black/30 px-1 text-white/55"
                    >
                      {partBytes === null ? '?' : chordBytesLabel(partBytes) || '∅'}
                    </kbd>
                  );
                })}
              </span>
            </>
          ) : (
            <span className="truncate text-[11px] text-white/40">{t('terminal.keys.hint')}</span>
          )}
        </div>

        {/* Assemble the value: modifiers carry `+`, keys carry a space. */}
        <div className="flex max-h-24 shrink-0 flex-wrap gap-1 overflow-auto scrollbar-thin border-b border-white/10 px-2 pb-1.5 pt-1">
          {INSERT_TOKENS.map((token) => (
            <button
              key={token.fragment}
              type="button"
              onClick={() => insertToken(token.fragment, token.modifier)}
              title={t(
                token.modifier ? 'terminal.keys.insertModifier' : 'terminal.keys.insertKey',
                { key: token.label },
              )}
              aria-label={token.label}
              className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-white/70 transition hover:border-white/25 hover:bg-white/10 hover:text-white"
            >
              {token.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-0.5">
          <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-white/35">
            {t('terminal.keys.recent')}
          </div>
          {chords.length === 0 ? (
            <div className="px-2 pb-1.5 text-[11px] text-white/35">{t('terminal.keys.empty')}</div>
          ) : (
            chords.map((entry) => {
              const encoded = encodeSequence(entry.spec, { applicationCursorKeys });
              return (
                <div
                  key={entry.spec}
                  className="group flex w-full items-center gap-1 rounded-sm px-2 py-1 transition hover:bg-white/10"
                >
                  <button
                    type="button"
                    onClick={() => sendSpec(entry.spec)}
                    title={`${sequenceLabel(entry.spec)} — ${t('terminal.keys.send')}`}
                    aria-label={sequenceLabel(entry.spec)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 text-left',
                      encoded ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <ChordPills
                      text={entry.spec}
                      className="min-w-0 truncate font-mono text-xs text-white/85"
                    />
                    {encoded && (
                      <kbd className="ml-auto shrink-0 rounded border border-white/10 bg-black/30 px-1 font-mono text-[10px] text-white/40">
                        {chordBytesLabel(encoded)}
                      </kbd>
                    )}
                  </button>
                  <button
                    type="button"
                    title={t('terminal.keys.delete')}
                    aria-label={t('terminal.keys.delete')}
                    onClick={() => setChords((list) => removeChord(list, entry.spec))}
                    className="shrink-0 rounded p-0.5 text-white/45 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-white group-focus-within:opacity-100"
                  >
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="shrink-0 border-t border-white/10 px-2 py-1 text-[11px] leading-snug text-white/35">
          {t('terminal.keys.captureHint')}
        </div>
      </PopoverContent>
    </Popover>
  );
}
