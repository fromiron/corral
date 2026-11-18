// When the app's screen lies over a browser tab's page (features/browser-tab.md 앱 화면과 겹칠
// 때). The page is a native view above the app, so nothing the app draws can show over it: while
// an app element overlaps the page's place, or the place is moving, the view is swapped for a
// picture of itself and swapped back after.
//
// What counts, without the kit telling: a portaled popup (menus, the "+" list, popovers,
// tooltips, dialogs and their dim) whose box meets the place; a hold the host takes itself (the
// palette, a splitter or a tab being dragged); and the place moving or resizing (the splitter by
// keys, widening and the drawer's slide, the window, the dock's height), until it is still.

/** Holds the host takes while something of its own covers or moves the pages. */
const holds = new Set<symbol>();
const holdListeners = new Set<() => void>();

/** Covers every page until the returned release is called (or called again: nothing). */
export function holdPages(): () => void {
  const token = Symbol('hold');
  holds.add(token);
  for (const listener of [...holdListeners]) listener();
  return () => {
    if (!holds.delete(token)) return;
    for (const listener of [...holdListeners]) listener();
  };
}

/** For a host's on/off signal (a drag starting and ending): one hold while on. */
export function pageHoldSwitch(): (on: boolean) => void {
  let release: (() => void) | null = null;
  return (on) => {
    if (on && !release) release = holdPages();
    else if (!on && release) {
      release();
      release = null;
    }
  };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const meets = (a: Box, b: Box) =>
  a.width > 0 &&
  a.height > 0 &&
  b.width > 0 &&
  b.height > 0 &&
  a.left < b.right &&
  a.right > b.left &&
  a.top < b.bottom &&
  a.bottom > b.top;

/** A portaled popup, or the drawer's dim, lies over the place. */
function popupOver(place: Element): boolean {
  const box = place.getBoundingClientRect();
  for (const portal of document.querySelectorAll('[data-base-ui-portal]'))
    for (const element of portal.querySelectorAll('[role], [data-slot]'))
      if (meets(element.getBoundingClientRect(), box)) return true;
  const scrim = document.querySelector('[data-slot="side-panel-scrim"]');
  return Boolean(scrim && meets(scrim.getBoundingClientRect(), box));
}

const sameBox = (a: Box | null, b: Box) =>
  Boolean(
    a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height,
  );

/** How long the place must stay put before a move counts as over. */
const STILL_FOR_MS = 150;

const nextFrame = (run: () => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = window.setTimeout(run, 16);
  return () => window.clearTimeout(id);
};

/**
 * Watches one page's place while its tab is on screen with a live page, and says whether the
 * page is covered now. Returns the stop.
 */
export function watchCover(place: HTMLElement, onChange: (covered: boolean) => void): () => void {
  let covered = false;
  let popup = false;
  let moving = false;
  let lastBox: Box | null = place.getBoundingClientRect();
  let movedAt = 0;
  let stopFrame: (() => void) | null = null;
  const tell = () => {
    const next = popup || moving || holds.size > 0;
    if (next === covered) return;
    covered = next;
    onChange(covered);
  };
  const checkPopups = () => {
    popup = popupOver(place);
    tell();
  };
  // A move: covered at once, and released once the place has kept its box a while.
  const follow = () => {
    const box = place.getBoundingClientRect();
    if (!sameBox(lastBox, box)) {
      lastBox = box;
      movedAt = performance.now();
    }
    if (performance.now() - movedAt < STILL_FOR_MS) {
      stopFrame = nextFrame(follow);
      return;
    }
    stopFrame = null;
    moving = false;
    checkPopups();
  };
  const moved = () => {
    movedAt = performance.now();
    if (!moving) {
      moving = true;
      tell();
    }
    if (!stopFrame) stopFrame = nextFrame(follow);
  };
  // The size observer's first word is the size it starts with: not a move.
  let sized = false;
  const resized = () => {
    const box = place.getBoundingClientRect();
    if (!sized) {
      sized = true;
      lastBox = box;
      return;
    }
    if (!sameBox(lastBox, box)) moved();
  };
  const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resized);
  sizes?.observe(place);
  window.addEventListener('resize', moved);

  // Popups come and go as the body's portals; each portal's own changes move its popup.
  const portalWatch = new Map<Element, MutationObserver>();
  const syncPortals = () => {
    const now = new Set(document.querySelectorAll('[data-base-ui-portal]'));
    for (const [portal, observer] of portalWatch)
      if (!now.has(portal)) {
        observer.disconnect();
        portalWatch.delete(portal);
      }
    for (const portal of now) {
      if (portalWatch.has(portal)) continue;
      const observer = new MutationObserver(checkPopups);
      observer.observe(portal, { subtree: true, childList: true, attributes: true });
      portalWatch.set(portal, observer);
    }
    checkPopups();
  };
  const body = new MutationObserver(syncPortals);
  body.observe(document.body, { childList: true });

  // Widening and the drawer: the panel's presentation changes, then it moves.
  const frame = place.closest('[data-slot="side-panel-frame"]');
  const presentation = frame ? new MutationObserver(moved) : null;
  presentation?.observe(frame as Element, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-presentation'],
  });

  holdListeners.add(tell);
  syncPortals();
  tell();
  return () => {
    holdListeners.delete(tell);
    sizes?.disconnect();
    window.removeEventListener('resize', moved);
    body.disconnect();
    for (const observer of portalWatch.values()) observer.disconnect();
    portalWatch.clear();
    presentation?.disconnect();
    stopFrame?.();
  };
}
