/**
 * Geometry for sidebar-anchored dropdowns (workspace switcher, user menu).
 * The popup is trigger-width + 10px, shifted 4px left, so item icons, labels
 * and the trailing check line up with the sidebar rows and trigger chevron.
 */
export const SIDEBAR_MENU_GRID =
  '[&_[role=menuitem]]:pl-2 [&_[role=menuitem]]:pr-1.5 [&_[role=menuitem]]:gap-2 [&_[role=menuitemradio]]:pl-2 [&_[role=menuitemradio]]:pr-1.5 [&_[role=menuitemradio]]:gap-2';

export const SIDEBAR_MENU_POPUP = `min-w-[240px] -ml-1 w-[calc(var(--anchor-width)_+_10px)] ${SIDEBAR_MENU_GRID}`;
