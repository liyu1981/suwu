import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * A small glass context menu for the SFTP panes. Items are grouped in arrays;
 * a group boundary renders a divider.
 */
export function ContextMenu({
  items,
  position,
  onClose,
}: {
  items: (ContextMenuItem | null)[][];
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const rows = items.flat().filter(Boolean).length;
  const x = Math.min(position.x, window.innerWidth - 200);
  const y = Math.min(position.y, window.innerHeight - rows * 30 - 16);

  return (
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[168px] overflow-hidden rounded-xl border border-white/[0.08] py-1 shadow-2xl menu-glass backdrop-blur-2xl"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="my-1 border-t border-white/[0.06]" />}
          {group.map((item, ii) => {
            if (!item) return null;
            return (
              <button
                key={ii}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  item.onClick();
                  onClose();
                }}
                className={`group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
                  item.danger
                    ? 'text-red-400/80 hover:bg-red-500/[0.12] hover:text-red-300'
                    : 'text-white/70 hover:bg-white/[0.08] hover:text-white/90'
                } ${item.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                {item.icon && <span className="w-4 shrink-0 text-white/35">{item.icon}</span>}
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
