import { ScrollArea } from '@corral/react/design-kit';
import type { ReactNode } from 'react';

/**
 * A settings section's scrolling body. It scrolls down, never sideways: as in the kit's sidebar,
 * the content keeps the frame's width (not Base UI's fit-content), so a long row wraps and a tab
 * strip scrolls inside it instead of pushing the page past the dialog's edge.
 */
export function SettingsScroll({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ScrollArea
      className={className}
      radius="none"
      viewportClassName="[&>div]:!block [&>div]:!min-w-0"
    >
      {children}
    </ScrollArea>
  );
}
