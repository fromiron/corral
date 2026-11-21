// Giving the keyboard focus back to a browser tab's page (features/browser-tab.md 포커스와
// 키보드): an app shortcut pressed in the page brings the focus out to the app; once what it did
// has settled, the focus goes back into the page unless the app took it somewhere, and when an
// app screen element it opened (the palette, a confirmation) closes. A page no longer on screen
// never takes it back.
import type { BrowserBridge } from '../../../../desktop/src/browser-bridge.ts';

/** The tab body marks itself while its live page lies over its place on screen. */
export const PAGE_ON_SCREEN = 'data-page-on-screen';
/** And while its view is swapped for a picture (overlap.ts): the view cannot take the focus. */
export const PAGE_STILL = 'data-page-still';

/**
 * Moves the focus into the page, once its view is live again if a picture stands in for it now
 * (a menu or the palette closing over it). Returns the cancel.
 */
export function focusPageWhenLive(bridge: BrowserBridge, tabId: string): () => void {
  const body = () => document.querySelector(`[data-browser-tab="${tabId}"]`);
  const go = () => {
    if (pageOnScreen(tabId)) void bridge.focus(tabId).catch(() => {});
  };
  const element = body();
  if (!element?.hasAttribute(PAGE_STILL)) {
    go();
    return () => {};
  }
  const observer = new MutationObserver(() => {
    const now = body();
    if (now?.hasAttribute(PAGE_STILL)) return;
    observer.disconnect();
    window.clearTimeout(giveUp);
    go();
  });
  observer.observe(element, { attributes: true, attributeFilter: [PAGE_STILL] });
  // A view that never comes back (the tab left the screen) takes nothing.
  const giveUp = window.setTimeout(() => observer.disconnect(), 3000);
  return () => {
    observer.disconnect();
    window.clearTimeout(giveUp);
  };
}

function pageOnScreen(tabId: string): boolean {
  return Boolean(document.querySelector(`[data-browser-tab="${tabId}"][${PAGE_ON_SCREEN}]`));
}

/** An app dialog over the screen, other than a drawer holding the tab itself. */
function appDialogOpen(): boolean {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
    (dialog) => !dialog.querySelector('[data-browser-tab]'),
  );
}

function insideAppLayer(element: Element): boolean {
  return Boolean(element.closest('[role="dialog"], [role="alertdialog"], [role="menu"]'));
}

/** After a frame and a turn: React has drawn what the shortcut did and moved any focus. */
function afterSettle(run: () => void) {
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => window.setTimeout(run, 0));
  else window.setTimeout(run, 16);
}

/**
 * The focus left the page for an app shortcut, with `before` the app's focused element then.
 * The page takes it back when the shortcut moved no focus; when it opened an app element that
 * took the focus, the page takes it back once the focus returns to `before` (the element closed).
 */
export function returnFocusToPage(
  bridge: BrowserBridge,
  tabId: string,
  before: Element | null,
): () => void {
  let stopped = false;
  let stopWatch = () => {};
  const unchanged = () => {
    const active = document.activeElement;
    return active === before || active === null || active === document.body;
  };
  const give = () => {
    if (!stopped && pageOnScreen(tabId)) focusPageWhenLive(bridge, tabId);
  };
  afterSettle(() => {
    if (stopped) return;
    if (unchanged() && !appDialogOpen()) {
      give();
      return;
    }
    // An app element took the focus: wait for it to give the focus back where it was.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (target === before) {
        stopWatch();
        afterSettle(() => {
          if (unchanged() && !appDialogOpen()) give();
        });
      } else if (target && !insideAppLayer(target)) stopWatch();
    };
    document.addEventListener('focusin', onFocusIn);
    stopWatch = () => document.removeEventListener('focusin', onFocusIn);
  });
  return () => {
    stopped = true;
    stopWatch();
  };
}
