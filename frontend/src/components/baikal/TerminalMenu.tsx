import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { authFetch } from '../../lib/api';
import { cn } from '@/lib/utils';
import type { BaikalSpace, BaikalTerminal } from '../../lib/baikal';

/**
 * Per-terminal actions: open read-only, move between spaces, end the program,
 * remove a finished record, peek at the screen.
 *
 * "End program" and "Remove" are destructive and separate from closing a tab
 * (which detaches); the labels say which is which so the difference is visible
 * before the click.
 */
export interface TerminalMenuProps {
  terminal: BaikalTerminal;
  spaces: BaikalSpace[];
  onOpen: (terminal: BaikalTerminal, observe: boolean) => void;
  onAssign: (terminal: BaikalTerminal, spaceId: string) => void;
  onKill: (terminal: BaikalTerminal) => void;
  onRemove: (terminal: BaikalTerminal) => void;
  onPeek: (terminal: BaikalTerminal) => void;
}

const itemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-white/75 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-40';

export function TerminalMenu({
  terminal,
  spaces,
  onOpen,
  onAssign,
  onKill,
  onRemove,
  onPeek,
}: TerminalMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);

  useEffect(() => {
    if (!open) setConfirmKill(false);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('baikal.actions')}
          title={t('baikal.actions')}
          onClick={(event) => event.stopPropagation()}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/30 transition hover:bg-white/10 hover:text-white/80"
        >
          ⋯
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-56 p-1">
        <button
          type="button"
          className={itemClass}
          onClick={() => {
            setOpen(false);
            onOpen(terminal, false);
          }}
        >
          {t('baikal.open')}
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => {
            setOpen(false);
            onOpen(terminal, true);
          }}
        >
          {t('baikal.openReadOnly')}
        </button>
        <button
          type="button"
          className={itemClass}
          onClick={() => {
            setOpen(false);
            onPeek(terminal);
          }}
        >
          {t('baikal.peek')}
        </button>

        {spaces.length > 0 && <div className="my-1 border-t border-white/[0.06]" />}
        {spaces.map((space) => (
          <button
            key={space.id}
            type="button"
            disabled={space.id === terminal.spaceId}
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onAssign(terminal, space.id);
            }}
          >
            <span className="shrink-0 text-white/30">→</span>
            <span className="truncate">{space.name}</span>
          </button>
        ))}

        <div className="my-1 border-t border-white/[0.06]" />
        {terminal.live ? (
          <button
            type="button"
            className={cn(itemClass, 'text-red-300 hover:bg-red-500/15')}
            onClick={() => {
              if (!confirmKill) {
                setConfirmKill(true);
                return;
              }
              setOpen(false);
              onKill(terminal);
            }}
          >
            {confirmKill ? t('baikal.killConfirm') : t('baikal.endProgram')}
          </button>
        ) : (
          <button
            type="button"
            className={cn(itemClass, 'text-red-300 hover:bg-red-500/15')}
            onClick={() => {
              setOpen(false);
              onRemove(terminal);
            }}
          >
            {t('baikal.removeTerminal')}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A read-only look at a terminal's screen, for the case where opening a tab
 * would steal size/input from whoever is actually using it.
 */
export function PeekDialog({
  terminal,
  onClose,
}: {
  terminal: BaikalTerminal | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    setText('');
    setError(null);
    void (async () => {
      try {
        const response = await authFetch('/api/baikal/terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', terminal: terminal.address, lines: 200 }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          text?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!response.ok) setError(payload.error ?? `read failed (${response.status})`);
        else setText(payload.text ?? '');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'read failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [terminal]);

  return (
    <Dialog
      open={terminal !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80dvh] w-[min(92vw,46rem)] flex-col">
        <DialogTitle className="text-sm">
          {terminal ? `${t('baikal.peek')} — ${terminal.address}` : t('baikal.peek')}
        </DialogTitle>
        <div className="mt-2 min-h-0 flex-1 overflow-auto scrollbar-thin rounded bg-black/40 p-3">
          {error ? (
            <div className="text-[11px] text-red-300">{error}</div>
          ) : text ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-white/75">
              {text}
            </pre>
          ) : (
            <div className="text-[11px] text-white/35">{t('baikal.loading')}</div>
          )}
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] border border-white/10 bg-white/[0.05] px-3 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.10]"
          >
            {t('dialog.close')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
