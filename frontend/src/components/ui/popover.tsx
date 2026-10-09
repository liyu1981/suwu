import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  children,
  onWheel,
  onTouchMove,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // A modal Dialog locks scrolling with react-remove-scroll, whose
  // document-level wheel/touchmove catcher cancels any event whose target
  // sits outside its shards — and a portal renders on document.body, i.e.
  // outside the dialog. That cancellation is what stopped the WebGPU
  // background selector's option list from responding to the mouse wheel.
  // Ending the event here keeps the popover's own overflow scrolling alive;
  // nothing behind the portal loses anything, because the lock already
  // hides the body scrollbar.
  const passScroll = <E extends React.WheelEvent | React.TouchEvent>(
    event: E,
    handler?: (event: E) => void,
  ) => {
    handler?.(event);
    event.stopPropagation();
  };

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-72 rounded-[6px] border border-white/10 p-1 outline-none',
          'menu-glass text-popover-foreground',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
        onWheel={(event) => passScroll(event, onWheel)}
        onTouchMove={(event) => passScroll(event, onTouchMove)}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
