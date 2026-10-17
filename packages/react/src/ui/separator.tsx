// Adapted from T3 Code, Copyright (c) 2026 T3 Tools Inc. (MIT). See THIRD-PARTY-NOTICES/T3-Code.md.
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';

import { cn } from './utils.ts';

function Separator({ className, orientation = 'horizontal', ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

export { Separator };
