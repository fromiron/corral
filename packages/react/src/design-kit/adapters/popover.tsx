'use client';

import { Popover as Primitive } from '@base-ui/react/popover';
import { TOOLTIP_SURFACE } from '../components/ui/tooltip.tsx';
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
  collisionBoundary,
  collisionPadding,
  keepMounted = false,
  anchor,
  surface = 'card',
  ...props
}: Primitive.Popup.Props & {
  /** `tooltip`: the kit tooltip's surface, for a popup that reads as one (no card, no padding). */
  surface?: 'card' | 'tooltip';
  padding?: 'default' | 'compact' | 'none';
  width?: keyof typeof widths;
  side?: Primitive.Positioner.Props['side'];
  align?: Primitive.Positioner.Props['align'];
  sideOffset?: Primitive.Positioner.Props['sideOffset'];
  alignOffset?: Primitive.Positioner.Props['alignOffset'];
  collisionAvoidance?: Primitive.Positioner.Props['collisionAvoidance'];
  collisionBoundary?: Primitive.Positioner.Props['collisionBoundary'];
  collisionPadding?: Primitive.Positioner.Props['collisionPadding'];
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
        {...(collisionBoundary === undefined ? {} : { collisionBoundary })}
        {...(collisionPadding === undefined ? {} : { collisionPadding })}
        className="z-50 max-w-(--available-width)"
        data-slot="popover-positioner"
      >
        <Primitive.Popup
          {...(surface === 'tooltip' ? {} : { render: <Elevated offset={2} /> })}
          className={cn(
            'max-w-[calc(100vw-2rem)] overflow-hidden outline-none [-webkit-app-region:no-drag]',
            surface === 'tooltip'
              ? [TOOLTIP_SURFACE, shape.bg]
              : ['text-body text-foreground', shape.container],
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
              // A tooltip's few lines never scroll; a scroll box there would also keep the
              // surface's trim from reaching its words.
              surface === 'card' && 'max-h-(--available-height) overflow-y-auto',
              surface === 'card' && padding === 'default' && 'p-4',
              surface === 'card' && padding === 'compact' && 'p-2',
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
