import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

/**
 * Content is pure markup; material + motion live in styles.css: .menu-panel
 * is the header's rendered color on a near-opaque base (readable over terminal
 * content), and the [data-slot='dropdown-menu-content'] rules do the
 * materialize/exit animations (opacity + scale-from-trigger + slide + blur).
 * The default sideOffset suits trigger-anchored menus; the burger menu
 * overrides it (see AppShell) to space the panel below the header's bottom.
 */
function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-[10rem] overflow-hidden rounded-[6px] bg-clip-padding p-1 text-popover-foreground',
          'menu-panel',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        'relative flex cursor-pointer select-none items-center outline-none',
        'px-3 py-1.5 text-sm font-medium text-muted-foreground',
        'transition-colors duration-100',
        'data-[highlighted]:bg-white/10 data-[highlighted]:text-popover-foreground',
        'active:bg-white/15 active:text-popover-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-white/10', className)}
      {...props}
    />
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator }
