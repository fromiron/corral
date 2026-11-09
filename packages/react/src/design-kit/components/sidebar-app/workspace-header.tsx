'use client';

import type { ReactNode } from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { SIDEBAR_MENU_POPUP } from '../../lib/sidebar-menu-grid.ts';
import { useSize } from '../../lib/size-context.tsx';
import { DropdownContent, DropdownMenu, DropdownTrigger } from '../ui/dropdown.tsx';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar.tsx';

// Workspace brand row for a sidebar header.
//
// While the sidebar is peeking, the overlay covers the usual pin trigger, so a
// SidebarTrigger cross-fades in over the tile's slot. It's a sibling over the
// row, never a button nested inside the row button.

export { WorkspaceTile } from './workspace-tile.tsx';

export interface SidebarWorkspaceHeaderLabels {
  /** Accessible name of the workspace menu list. */
  menu: string;
  /** Accessible name of the workspace switcher button. */
  switchWorkspace: string;
  /** Accessible name of the trigger shown while peeking; omitted, the trigger keeps its own. */
  toggleSidebar?: string;
}

const defaultLabels: SidebarWorkspaceHeaderLabels = {
  menu: 'Workspace',
  switchWorkspace: 'Switch workspace',
};

export interface SidebarWorkspaceHeaderProps {
  /** Workspace or product name shown in the row. */
  name: ReactNode;
  /** 20px leading mark (e.g. WorkspaceTile, a logo); the mark owns its look. */
  tile: ReactNode;
  /** Dropdown content (MenuItem rows). Omit for a non-interactive logo row. */
  menu?: ReactNode;
  /** Index of the checked menu row, forwarded to DropdownContent. */
  checkedIndex?: number;
  /** Localized accessible names; the source English is the default. */
  labels?: Partial<SidebarWorkspaceHeaderLabels>;
}

export function SidebarWorkspaceHeader({
  name,
  tile,
  menu,
  checkedIndex,
  labels: labelOverrides,
}: SidebarWorkspaceHeaderProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  // Passed only when set, so the trigger otherwise keeps its own accessible name.
  const toggleName = labels.toggleSidebar ? { 'aria-label': labels.toggleSidebar } : {};
  const iconSize = useSize().icon;
  const icons = useIcons();
  const ChevronDown = icons['chevron-down'];
  const { isPeeking } = useSidebar();

  // left-1.5 centres the 20px tile on the rows' leading icon axis.
  const tileSlot = (
    <span
      aria-hidden
      className={`pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 transition-opacity duration-80 ${
        isPeeking ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {tile}
    </span>
  );
  // Hide the Button's bg layer (first child): its box is off-axis from the
  // tile slot. [&_svg]:size-4 matches the topbar trigger's 16px glyph.
  const triggerFade = `[&>span:first-child]:hidden [&_svg]:size-4 transition-opacity duration-80 ${
    isPeeking ? 'opacity-100' : 'pointer-events-none opacity-0'
  }`;
  const nameSpan = (
    <span
      className="min-w-0 truncate text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)] text-foreground"
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {name}
    </span>
  );

  if (!menu) {
    // Not interactive, so it renders outside SidebarMenu — a menu row would
    // track the traveling hover background.
    return (
      <div className="relative flex h-8 items-center pl-8 pr-2">
        <SidebarTrigger
          size="icon-compact"
          {...toggleName}
          aria-hidden={!isPeeking || undefined}
          tabIndex={isPeeking ? undefined : -1}
          className={`absolute left-1 top-1/2 -translate-y-1/2 ${triggerFade}`}
        />
        {tileSlot}
        {nameSpan}
      </div>
    );
  }
  return (
    // @container: the chevron hides when the row gets too narrow for the name.
    <SidebarMenu aria-label={labels.menu} className="@container">
      <SidebarMenuItem>
        <SidebarTrigger
          size="icon-compact"
          {...toggleName}
          aria-hidden={!isPeeking || undefined}
          tabIndex={isPeeking ? undefined : -1}
          className={`absolute left-1 top-1/2 z-20 -translate-y-1/2 ${triggerFade}`}
        />
        <DropdownMenu>
          <DropdownTrigger
            render={
              <SidebarMenuButton aria-label={labels.switchWorkspace} className="pl-8">
                {tileSlot}
                {nameSpan}
                <span className="ml-auto inline-flex @max-[7rem]:hidden">
                  <ChevronDown
                    size={iconSize}
                    strokeWidth={1.5}
                    className="text-muted-foreground"
                  />
                </span>
              </SidebarMenuButton>
            }
          />
          <DropdownContent
            className={SIDEBAR_MENU_POPUP}
            align="start"
            sideOffset={4}
            checkedIndex={checkedIndex}
          >
            {menu}
          </DropdownContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
