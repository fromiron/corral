// How the top bar gives way as it narrows (workbench.md, "전역 셸과 화면 틀"). The bar is fitted
// to its own width, not the window's: the sidebar beside it is resizable. Each tier asks for
// less room than the one before it; the open session's (or page's) name and Search are in
// every tier.

export const TOPBAR_TIERS = [
  /** Path, the page's tools and search. */
  'full',
  /** The current name may shorten to a comfortable length; nothing else changes. */
  'short-path',
  /** The project is its icon. */
  'project-icon',
  /** The page's actions take a second row. */
  'two-rows',
] as const;

export type TopbarTier = (typeof TOPBAR_TIERS)[number];

/** How much of the path a tier must hold to count as fitting. */
export type PathRoom = 'full' | 'comfortable' | 'minimum';

export interface TopbarLayout {
  tier: TopbarTier;
  project: 'name' | 'icon';
  rows: 1 | 2;
  /**
   * The project folds to its icon only once the name would fall below a comfortable length,
   * and the second row is taken only once it would fall below its readable minimum.
   */
  path: PathRoom;
}

const LAST = TOPBAR_TIERS.length - 1;

export function topbarLayout(index: number): TopbarLayout {
  const at = Math.min(Math.max(0, Math.trunc(index) || 0), LAST);
  return {
    tier: TOPBAR_TIERS[at] ?? 'full',
    project: at >= 2 ? 'icon' : 'name',
    rows: at >= 3 ? 2 : 1,
    path: at >= 2 ? 'minimum' : at === 1 ? 'comfortable' : 'full',
  };
}

export const FULL_TOPBAR = topbarLayout(0);

/**
 * One step of the fit. `needs[tier]` is the width that tier's content asks for, once it has
 * been laid out and measured; a tier never seen is unknown. The bar steps down while the tier
 * on screen asks for more than there is, and steps back up when the roomier tier is known to
 * fit, or is unknown and so worth trying.
 */
export function stepTopbarTier(
  index: number,
  available: number,
  needs: readonly (number | undefined)[],
): number {
  const need = needs[index];
  if (need !== undefined && need > available) return index < LAST ? index + 1 : index;
  if (index === 0) return index;
  const roomier = needs[index - 1];
  return roomier === undefined || roomier <= available ? index - 1 : index;
}

/** The tier a bar of this width rests at, given what every tier asks for. */
export function topbarTierFor(available: number, needs: readonly number[]): TopbarLayout {
  let index = 0;
  for (let step = 0; step <= LAST; step++) {
    const next = stepTopbarTier(index, available, needs);
    if (next <= index) break;
    index = next;
  }
  return topbarLayout(index);
}

/** The width of a path item when the name may shorten: `em` is its label's font size. */
const COMFORTABLE_EM = 12.5;
const MINIMUM_EM = 7.5;

function visible(element: Element) {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
}

/** The boxes a flex row lays out: `display: contents` wrappers give way to their children. */
function boxes(parent: Element): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (getComputedStyle(child).display === 'contents') result.push(...boxes(child));
    else if (visible(child)) result.push(child);
  }
  return result;
}

function crumbWidth(crumb: HTMLElement, room: PathRoom) {
  const label = crumb.matches('[data-crumb-label]')
    ? crumb
    : crumb.querySelector<HTMLElement>('[data-crumb-label]');
  if (!label) return crumb.offsetWidth;
  const chrome = crumb.offsetWidth - label.offsetWidth;
  const em = Number.parseFloat(getComputedStyle(label).fontSize) || 13;
  const kind = crumb.dataset.crumb;
  let text = label.scrollWidth;
  if (room !== 'full' && kind === 'current')
    text = Math.min(text, (room === 'comfortable' ? COMFORTABLE_EM : MINIMUM_EM) * em);
  const limit = Number.parseFloat(getComputedStyle(crumb).maxWidth);
  return limit > 0 ? Math.min(chrome + text, limit) : chrome + text;
}

function rowWidth(items: readonly number[], gap: number) {
  return items.reduce((total, width) => total + width, 0) + gap * Math.max(0, items.length - 1);
}

/**
 * The width the bar's content asks for in the layout on screen. Actions and buttons are
 * taken as laid out; the path is taken at what its items would be with the room this tier
 * promises, so a squeezed path still reports what it wants.
 */
export function measureTopbar(bar: HTMLElement, layout: TopbarLayout): number {
  const style = getComputedStyle(bar);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  if (layout.rows === 2) {
    const second = [...bar.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.matches('[data-topbar-part="actions"]') &&
        child.childElementCount > 0,
    );
    return (
      padding +
      rowWidth(
        second.map((part) => part.offsetWidth),
        gap,
      )
    );
  }
  const widths = boxes(bar).map((child) => {
    if (child.dataset.topbarPart !== 'path') return child.offsetWidth;
    const pathGap = Number.parseFloat(getComputedStyle(child).columnGap) || 0;
    return rowWidth(
      boxes(child).map((item) =>
        item.dataset.crumb ? crumbWidth(item, layout.path) : item.offsetWidth,
      ),
      pathGap,
    );
  });
  return padding + rowWidth(widths, gap);
}
