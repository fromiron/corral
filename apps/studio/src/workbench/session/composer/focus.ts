import type { RefObject } from 'react';

// Where the focus goes once a menu of the composer is used: a conversation's and a meeting's
// composer share it.

/** How many times a composer menu has opened; a focus return planned before the last gives way. */
let menusOpened = 0;

/** A composer menu's `onOpenChange`: opening is counted, closing calls `onClose`. */
export function menuOpenChange(onClose?: () => void) {
  return (open: boolean) => {
    if (open) menusOpened += 1;
    else onClose?.();
  };
}

/**
 * A menu or notice of the composer, once used, gives the focus back to the box: after the menu
 * has put it back on its trigger, or let it fall to the page. A click that moved it elsewhere
 * keeps it there, and a composer menu opened before that frame keeps it too.
 */
export function backToInput(input: RefObject<HTMLTextAreaElement | null>) {
  const planned = menusOpened;
  requestAnimationFrame(() => {
    // A menu opened since keeps the focus (it may be the same menu, its popup node reused).
    if (menusOpened !== planned) return;
    const focused = document.activeElement;
    if (
      !focused ||
      focused === document.body ||
      focused.closest('[role="menu"], [data-slot="composer-host"]')
    )
      input.current?.focus();
  });
}
