// Shared chrome for the dropdown, select, and combobox popups.

/**
 * Enter/exit origin and 4px slide offset, keyed off the RESOLVED `data-side`
 * (after collision flipping), so a popup flipped above its anchor grows upward.
 */
export const popupMotionClass =
  'origin-top [--popup-enter-y:-4px] ' +
  'data-[side=top]:origin-bottom data-[side=top]:[--popup-enter-y:4px] ' +
  '[[data-side=top]_&]:origin-bottom [[data-side=top]_&]:[--popup-enter-y:4px] ' +
  'data-[side=left]:origin-right data-[side=left]:[--popup-enter-y:0px] ' +
  '[[data-side=left]_&]:origin-right [[data-side=left]_&]:[--popup-enter-y:0px] ' +
  'data-[side=right]:origin-left data-[side=right]:[--popup-enter-y:0px] ' +
  '[[data-side=right]_&]:origin-left [[data-side=right]_&]:[--popup-enter-y:0px]';

/**
 * ScrollArea sizing for popup lists. The popup is only max-height constrained,
 * so the viewport inherits max-height instead of a percentage height. The
 * inline-styled sizer is forced to a plain block so rows can truncate; the
 * `[style]` qualifier skips touch devices, where ScrollArea renders no sizer.
 */
export const popupScrollAreaClass = 'min-h-0 flex-1 max-h-[inherit]';
export const popupViewportClass =
  '!h-auto max-h-[inherit] [&>div[style]]:!block [&>div[style]]:!min-w-0 [--scroll-fade-size:32px]';

/** Keys that count as keyboard navigation inside a popup (earn the ring). */
export const POPUP_NAV_KEYS = [
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab',
];

/**
 * Rows the fluid hover must skip: a disabled row is neither a target
 * nor a hover stop, whichever attribute the primitive marks it with.
 */
export function isDisabledRow(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
}
