// Where the overlay draws (features/browser-annotate.md 가리키기, 주석 칸, 번호 표시): pure
// functions of the boxes main reports, in the overlay's CSS pixels from the page area's top left.
import type { AnnotateRect } from '../../../desktop/src/annotate-bridge.ts';

export interface Size {
  width: number;
  height: number;
}

/** The outline: a 2px line whose inner edge is 3px outside the element's border box. */
const OUTLINE_OUT = 3 + 2;
/** Between the outline and its name tag, and the tag's inset when it goes inside. */
const TAG_GAP = 4;
/** Between the element and its note. */
const NOTE_GAP = 12;
/** Between the note and the page area's edges. */
const EDGE = 8;
/** Narrower than this, the note docks to the page area's bottom. */
export const NARROW = 560;
const NOTE_WIDTH = 320;
export const MARKER = 18;
const MARKER_SHIFT = 22;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function outlineRect(box: AnnotateRect): AnnotateRect {
  return {
    x: box.x - OUTLINE_OUT,
    y: box.y - OUTLINE_OUT,
    width: box.width + OUTLINE_OUT * 2,
    height: box.height + OUTLINE_OUT * 2,
  };
}

/** The name tag: above the outline's left, else below it, else inside its top left. */
export function tagPlace(
  outline: AnnotateRect,
  tag: Size,
  area: Size,
): { x: number; y: number; at: 'above' | 'below' | 'inside' } {
  const x = (left: number) => clamp(left, 0, Math.max(0, area.width - tag.width));
  const above = outline.y - tag.height - TAG_GAP;
  if (above >= 0) return { x: x(outline.x), y: above, at: 'above' };
  const below = outline.y + outline.height + TAG_GAP;
  if (below + tag.height <= area.height) return { x: x(outline.x), y: below, at: 'below' };
  return {
    x: x(Math.max(outline.x, 0) + TAG_GAP),
    y: Math.max(outline.y, 0) + TAG_GAP,
    at: 'inside',
  };
}

export function noteWidth(areaWidth: number): number {
  return Math.min(NOTE_WIDTH, areaWidth - EDGE * 2);
}

/**
 * The note beside its element: right, else left, below, above, else over it at the right; 8px
 * from the page area's edges. A page area narrower than 560px docks it to the bottom.
 */
export function notePlace(
  box: AnnotateRect,
  card: Size,
  area: Size,
  /** A bottom sheet's height (the narrow style view): the docked note sits on it. */
  bottomInset = 0,
): {
  x: number;
  y: number;
  width: number;
  side: 'right' | 'left' | 'below' | 'above' | 'over' | 'docked';
} {
  if (area.width < NARROW)
    return {
      x: EDGE,
      y: area.height - bottomInset - EDGE - card.height,
      width: area.width - EDGE * 2,
      side: 'docked',
    };
  const { width, height } = card;
  const maxX = area.width - EDGE - width;
  const maxY = area.height - EDGE - height;
  const sideY = clamp(box.y, EDGE, maxY);
  const right = box.x + box.width + NOTE_GAP;
  if (right <= maxX) return { x: right, y: sideY, width, side: 'right' };
  const left = box.x - NOTE_GAP - width;
  if (left >= EDGE) return { x: left, y: sideY, width, side: 'left' };
  const stackX = clamp(box.x, EDGE, maxX);
  const below = box.y + box.height + NOTE_GAP;
  if (below <= maxY) return { x: stackX, y: below, width, side: 'below' };
  const above = box.y - NOTE_GAP - height;
  if (above >= EDGE) return { x: stackX, y: above, width, side: 'above' };
  return { x: maxX, y: sideY, width, side: 'over' };
}

/** Markers stay this far inside the scroll area: clear of the frame's line and its ring. */
const MARKER_INSET = 3;
/** Between the busy line and a marker it pushed down. */
const AVOID_GAP = 4;

const STYLE_WIDTH = 340;
const STYLE_HEIGHT = 480;
const STYLE_GAP = 8;
/** The narrow style view's share of the page area's height. */
const SHEET = 0.45;

/**
 * The style view beside the note, on the side with room (the roomier one, kept inside the page
 * area, when neither has); a page area narrower than 560px gets a bottom sheet instead.
 */
export function stylePlace(
  note: AnnotateRect,
  area: Size,
): { x: number; y: number; width: number; height: number; sheet: boolean } {
  if (area.width < NARROW) {
    const height = Math.round(area.height * SHEET);
    return { x: 0, y: area.height - height, width: area.width, height, sheet: true };
  }
  const width = STYLE_WIDTH;
  const height = Math.min(STYLE_HEIGHT, area.height - EDGE * 2);
  const y = clamp(note.y, EDGE, area.height - EDGE - height);
  const right = note.x + note.width + STYLE_GAP;
  const left = note.x - STYLE_GAP - width;
  const maxX = area.width - EDGE - width;
  if (right <= maxX) return { x: right, y, width, height, sheet: false };
  if (left >= EDGE) return { x: left, y, width, height, sheet: false };
  const roomRight = area.width - EDGE - right;
  const roomLeft = note.x - STYLE_GAP - EDGE;
  return {
    x: clamp(roomRight >= roomLeft ? right : left, EDGE, maxX),
    y,
    width,
    height,
    sheet: false,
  };
}

/**
 * Each marker centred on its element's top right corner, kept inside the page's scroll area
 * (`bounds`: the page area without the page's scrollbars) and clear of the frame; one that would
 * cover `avoid` (the busy line) goes just under it, and one that would overlap a marker already
 * placed (in number order) steps 22px left until it doesn't.
 */
export function markerPlaces(
  markers: { pickId: string; n: number; box: AnnotateRect }[],
  bounds: Size,
  avoid: AnnotateRect | null = null,
): { pickId: string; n: number; x: number; y: number }[] {
  const placed: { pickId: string; n: number; x: number; y: number }[] = [];
  const overlaps = (x: number, y: number) =>
    placed.some((other) => Math.abs(other.x - x) < MARKER && Math.abs(other.y - y) < MARKER);
  const covers = (x: number, y: number) =>
    !!avoid &&
    x < avoid.x + avoid.width &&
    x + MARKER > avoid.x &&
    y < avoid.y + avoid.height &&
    y + MARKER > avoid.y;
  const minX = MARKER_INSET;
  const maxX = bounds.width - MARKER - MARKER_INSET;
  for (const { pickId, n, box } of [...markers].sort((a, b) => a.n - b.n)) {
    let x = clamp(box.x + box.width - MARKER / 2, minX, maxX);
    let y = clamp(box.y - MARKER / 2, MARKER_INSET, bounds.height - MARKER - MARKER_INSET);
    if (avoid && covers(x, y)) y = avoid.y + avoid.height + AVOID_GAP;
    while (overlaps(x, y) && x - MARKER_SHIFT >= minX) x -= MARKER_SHIFT;
    placed.push({ pickId, n, x, y });
  }
  return placed;
}

/** The page area's frame, from the top right corner (nearest the annotate button) once around. */
export function framePath(area: Size): string {
  const right = area.width - 1;
  const bottom = area.height - 1;
  return `M ${right} 1 H 1 V ${bottom} H ${right} Z`;
}
