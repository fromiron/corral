'use client';

import type { ComponentProps } from 'react';
import { useIcons } from '../../lib/icon-context.tsx';
import { useSize } from '../../lib/size-context.tsx';
import { SidebarInput } from '../ui/sidebar.tsx';

// The header's search field, aligned to the menu rows' icon and text axes.
// The shortcut chip appears on hover/focus only.

export interface SidebarSearchFieldProps
  extends Omit<ComponentProps<typeof SidebarInput>, 'className'> {
  /** Keystroke shown in the trailing chip. Pass null to drop the chip. */
  shortcut?: string | null;
}

export function SidebarSearchField({
  placeholder = 'Search…',
  shortcut = '⌘K',
  ...props
}: SidebarSearchFieldProps) {
  const iconSize = useSize().icon;
  const icons = useIcons();
  const SearchIcon = icons.search;
  return (
    <div className="group/search relative">
      <SearchIcon
        size={iconSize}
        strokeWidth={1.5}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <SidebarInput
        placeholder={placeholder}
        aria-label="Search"
        className="pl-8 pr-12"
        {...props}
      />
      {shortcut && (
        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)] text-muted-foreground opacity-0 transition-opacity duration-80 group-hover/search:opacity-100 group-focus-within/search:opacity-100">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}
