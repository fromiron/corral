'use client';

import { Popover as Primitive } from '@base-ui/react/popover';
import { Elevated } from '../lib/elevated.tsx';
import { useShape } from '../lib/shape-context.tsx';
import { cn } from '../lib/utils.ts';

const widths = { auto: '', sm: 'w-64', md: 'w-80', lg: 'w-96' } as const;
export const Popover = Primitive.Root;
export const PopoverCreateHandle = Primitive.createHandle;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;

function PopoverPopup({
  children,
  className,
  padding = 'default',
  width = 'auto',
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  alignOffset,
  collisionAvoidance,
  keepMounted = false,
  anchor,
  ...props
}: Primitive.Popup.Props & {
  padding?: 'default' | 'compact' | 'none';
  width?: keyof typeof widths;
  side?: Primitive.Positioner.Props['side'];
  align?: Primitive.Positioner.Props['align'];
  sideOffset?: Primitive.Positioner.Props['sideOffset'];
  alignOffset?: Primitive.Positioner.Props['alignOffset'];
  collisionAvoidance?: Primitive.Positioner.Props['collisionAvoidance'];
  anchor?: Primitive.Positioner.Props['anchor'];
  keepMounted?: boolean;
}) {
  const shape = useShape();
  return (
    <Primitive.Portal keepMounted={keepMounted}>
      <Primitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="z-50 max-w-(--available-width)"
        data-slot="popover-positioner"
      >
        <Primitive.Popup
          render={<Elevated offset={2} />}
          className={cn(
            'max-w-[calc(100vw-2rem)] overflow-hidden text-body text-foreground outline-none [-webkit-app-region:no-drag]',
            shape.container,
            widths[width],
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          {/* A stable container retains the request-options draft while its portal stays mounted. */}
          <div
            data-slot="popover-viewport"
            className={cn(
              'max-h-(--available-height) overflow-y-auto',
              padding === 'default' && 'p-4',
              padding === 'compact' && 'p-2',
            )}
          >
            {children}
          </div>
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

export { PopoverPopup, PopoverPopup as PopoverContent };
export function PopoverTitle({ className, ...props }: Primitive.Title.Props) {
  return (
    <Primitive.Title
      data-slot="popover-title"
      className={cn('text-subtitle font-semibold', className)}
      {...props}
    />
  );
}
