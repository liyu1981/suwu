import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Shared dialog chrome for the SFTP tile's prompts and confirmations. */
function DialogShell({
  title,
  message,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={onCancel}
    >
      <div
        className="w-[min(90vw,380px)] rounded-2xl border border-white/[0.08] p-4 shadow-2xl menu-glass backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-base font-semibold tracking-tight text-white/90">{title}</h3>
        {message && <p className="mb-3 text-sm leading-relaxed text-white/55">{message}</p>}
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-white/[0.06] px-3.5 py-1.5 text-xs text-white/50 transition-all duration-150 hover:bg-white/[0.10] hover:text-white/80 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.97] ${
              danger
                ? 'bg-red-500/20 text-red-300/90 hover:bg-red-500/30 hover:text-red-200'
                : 'bg-sky-500/20 text-sky-300/90 hover:bg-sky-500/30 hover:text-sky-200'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Prompt for a single line of text (new folder / rename). */
export function PromptDialog({
  title,
  label,
  defaultValue,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  label: string;
  defaultValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <DialogShell
      title={title}
      confirmLabel={confirmLabel}
      onConfirm={() => {
        const trimmed = value.trim();
        if (trimmed) onConfirm(trimmed);
      }}
      onCancel={onCancel}
    >
      <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-prompt">
        {label}
      </label>
      <input
        id="sftp-prompt"
        ref={ref}
        type="text"
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onConfirm(value.trim());
        }}
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-2 text-sm text-white outline-none transition-all duration-150 focus:border-sky-400/40 focus:bg-white/[0.08] focus:ring-1 focus:ring-sky-400/20"
      />
    </DialogShell>
  );
}

/** Confirm a destructive action. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogShell
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      danger={danger}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** Small transient toast used for transfer/operation feedback. */
export function SftpToast({ message, tone }: { message: string; tone: 'info' | 'error' }) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
      <div
        className={`rounded-lg px-3 py-1.5 text-[11px] shadow-lg backdrop-blur-md ${
          tone === 'error'
            ? 'border border-red-400/20 bg-red-500/15 text-red-200'
            : 'border border-white/10 bg-black/60 text-white/80'
        }`}
      >
        {message}
      </div>
    </div>
  );
}
