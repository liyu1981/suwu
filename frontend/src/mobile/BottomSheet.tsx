import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * A phone-sized bottom sheet: the repo's dialog material, anchored to the bottom
 * edge instead of the middle.
 *
 * The dialog primitive centres itself with `left-1/2 top-1/2 -translate-*`; this
 * overrides those four utilities (tailwind-merge resolves the conflicts) so the
 * panel spans the width and grows upward, which is where a thumb can reach and
 * what keeps the header and the tile visible behind it.
 */
export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Optional action row rendered at the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
  /** Footer that stays put while the body scrolls (e.g. "Add app"). */
  footer?: ReactNode;
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  actions,
  children,
  footer,
}: BottomSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          'left-0 right-0 top-auto bottom-0 w-full max-w-none translate-x-0 translate-y-0',
          'flex max-h-[80dvh] flex-col gap-0 rounded-b-none rounded-t-[10px] p-3',
        )}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex shrink-0 items-center gap-2 pb-2">
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
          {actions}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
        {footer && <div className="shrink-0 border-t border-white/10 pt-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
