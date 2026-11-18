// The annotation overlay's bridge (docs/specs/features/browser-annotate.md 계약, decision 44).
//
// The overlay is the studio's own entry, built with the kit: `apps/studio/annotate.html`, which
// the studio's Vite build emits as `annotate.html` at the root of `apps/studio/dist`, its files
// under `assets/` with root-absolute URLs (`/assets/…`, base `/`). The desktop serves exactly
// those two (the page and `assets/**`) through `corral-overlay://overlay/` into the overlay view:
// its own in-memory partition, no app cookies, no network (CSP connect-src 'none' and a request
// filter), no `corralDesktop`. The overlay's preload exposes only `window.corralAnnotate`, below;
// main checks every argument again and knows which tab an overlay belongs to.
//
// Coordinates are the overlay's CSS pixels from the page area's top left. Main converts between
// them and the page's (its zoom) on both ways. Types only: the studio may import them.

/** The style view's properties, in their order (features/browser-annotate.md 스타일 바꿔 보기). */
export type StyleProperty =
  | 'font-size'
  | 'font-weight'
  | 'line-height'
  | 'letter-spacing'
  | 'text-align'
  | 'color'
  | 'background-color'
  | 'border-color'
  | 'border-width'
  | 'border-style'
  | 'border-radius'
  | 'opacity'
  | 'margin'
  | 'padding'
  | 'display'
  | 'width'
  | 'height'
  | 'position';

export interface AnnotatePoint {
  x: number;
  y: number;
}

export interface AnnotateRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element the overlay outlines: its border box and name tag. */
export interface AnnotateTarget {
  /** `tag.firstClass W×H` (`button.pay 120×32`), the drawn size in the page's CSS pixels. */
  label: string;
  /** Its accessible name, when it has one (announced when the keyboard moves the outline). */
  name: string | null;
  /** Its border box (the overlay draws the outline 3px outside it). */
  box: AnnotateRect;
}

/** What a send carries of the element (보내는 것의 요소). */
export interface AnnotateElement {
  tag: string;
  role: string | null;
  /** nth-of-type steps from body, at most 12. */
  selector: string;
  /** Its visible text without field values, at most 4,000 characters. */
  text: string;
  /** Its part visible in the page area, in the page's CSS pixels. */
  bounds: AnnotateRect;
  /** The computed value of each style view property. */
  styles: Record<StyleProperty, string>;
}

/** The page as a note carries it: origin and path only (a preview's path inside its lease). */
export interface AnnotatePage {
  kind: 'page' | 'preview';
  origin: string;
  path: string;
}

export interface AnnotatePick extends AnnotateTarget {
  /** Names this pick to main until it is released or the page moves. */
  pickId: string;
  /** What the note will carry of the page and the element, as it will carry them. */
  page: AnnotatePage;
  element: AnnotateElement;
  /**
   * False when the element holds an input field, text area, select or editable area, or one
   * overlaps its part on screen: the screenshot toggle is off and unavailable. Checked again at
   * the send.
   */
  screenshotAllowed: boolean;
}

/** The page's `:root` custom properties whose values are colours or lengths, by name. */
export interface AnnotateTokens {
  colors: { name: string; value: string }[];
  lengths: { name: string; value: string }[];
}

export interface StyleChange {
  property: StyleProperty;
  /** The computed value when the style view first opened. */
  before: string;
  /** As written, `var(--name)` included. */
  after: string;
}

export interface AnnotateSubmit {
  /** The overlay's own name for this note; a resend under the same command uses the same one. */
  noteId: string;
  pickId: string;
  /** "보내기" (straight to the conversation) or "담기" (into the composer's chips). */
  intent: 'send' | 'add';
  /** At most 4,000 characters. */
  text: string;
  styles: StyleChange[];
  /** Take the element's screenshot at this moment (refused with input fields or past the limit). */
  screenshot: boolean;
  /** Preview pages only: the last 20 console messages since the mode or the page began. */
  console: boolean;
  /**
   * Passed through to the app page as given (the send key's meaning, a resend): JSON, at most
   * 16 KiB. Main does not read it.
   */
  extra: unknown;
}

export type AnnotateSubmitResult =
  /** The app page's answer, passed through as it gave it (accepted, refused, unconfirmed, added). */
  | { kind: 'answered'; outcome: unknown }
  /** The view, the navigation or the lease changed since the pick: nothing was sent. */
  | { kind: 'page-changed' }
  /** None of the element is in the page area now. */
  | { kind: 'not-visible' }
  /** An input field is in or over the element's screen: no screenshot, nothing sent. */
  | { kind: 'input-fields' }
  /** The screenshot is over 2,048px or 1MiB: nothing sent. */
  | { kind: 'image-limit' }
  /** The page didn't answer its re-check or screenshot within 1,000 ms: nothing sent. */
  | { kind: 'page-busy' }
  /** Cancelled (Escape while adding, the note closing): a late answer is dropped. */
  | { kind: 'cancelled' };

export type AnnotateEvent =
  /** The mode is on over a page (again after a move: a new generation). */
  | { type: 'page'; kind: 'page' | 'preview'; generation: number }
  /** The page moved or reloaded: its picks are gone; close the note as the spec says. */
  | { type: 'navigated'; generation: number }
  /**
   * Page reads stopped answering within 1,000 ms (`busy: true`), or answer again (`false`): the
   * one line of "페이지가 막을 때".
   */
  | { type: 'page-busy'; busy: boolean }
  /** The app page's context for the overlay (locale, theme, send key, collect, limits, markers). */
  | { type: 'context'; context: unknown }
  /** Keyboard focus moved into the page area (the mode began, or the host gave it back). */
  | { type: 'focus' }
  /** The mode is ending: play the frame's exit and call `ended()`; the view goes after that. */
  | { type: 'ending' };

export interface AnnotateBridge {
  /**
   * One read per animation frame at most: what is under the pointer (null pointer: no hover
   * outline, as while a written note is open), and the boxes of the tracked picks (null when
   * gone or on another page). Null when the page didn't answer within 1,000 ms; a read already
   * in flight answers null at once.
   */
  frame(input: { pointer: AnnotatePoint | null; track: string[] }): Promise<{
    hover: AnnotateTarget | null;
    boxes: Record<string, AnnotateRect | null>;
    /**
     * The page's scroll area without its scrollbars, from the page area's top left: markers
     * stay inside it, clear of the page's scrollbar.
     */
    view: { width: number; height: number };
  } | null>;
  /** Picks the element at a point, or the keyboard outline's ('outline'). */
  pick(
    at: AnnotatePoint | 'outline',
  ): Promise<
    | { ok: true; pick: AnnotatePick }
    | { ok: false; reason: 'nothing' | 'page-changed' | 'page-busy' }
  >;
  /** Moves the keyboard outline: ↑ parent, ↓ first child, ← · → siblings; none yet: the centre. */
  walk(direction: 'up' | 'down' | 'left' | 'right'): Promise<AnnotateTarget | null>;
  /**
   * A wheel outside the note field and the style view: the page scrolls. The DOM event's own
   * values (Chromium has already made Shift+wheel horizontal); dropped while the page is busy.
   */
  wheel(event: {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    /** DOM WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
    deltaMode: 0 | 1 | 2;
  }): void;
  /**
   * The style view opening: the pick's computed values now (each property's "before") and the
   * page's tokens. Null when the pick is gone or the page didn't answer.
   */
  inspect(
    pickId: string,
  ): Promise<{ styles: Record<StyleProperty, string>; tokens: AnnotateTokens } | null>;
  /**
   * The console messages a send of this pick would carry if its console toggle is on, exactly as
   * the send would (a preview page's last 20, its token taken out), so the person sees them before
   * they go. Null on an ordinary page, or for a pick of another page.
   */
  consoleFor(pickId: string): Promise<{ level: string; message: string }[] | null>;
  /** Shows a value on the element at once (null takes it back); refused when not valid. */
  preview(
    pickId: string,
    property: StyleProperty,
    value: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'page-changed' | 'page-busy' }>;
  /** The note closed or its chip went: its previews come off and main forgets the element. */
  release(pickId: string): Promise<void>;
  submit(note: AnnotateSubmit): Promise<AnnotateSubmitResult>;
  /** Escape while adding, or the note closing: the app page is told; a late answer is dropped. */
  cancelSubmit(noteId: string): Promise<void>;
  /** A message for the app page (the collect switch changed, …): JSON, at most 16 KiB. */
  tell(message: unknown): Promise<void>;
  /** Escape at the outermost level: the mode goes off. */
  end(): Promise<void>;
  /** After `ending`: the frame's exit has played. */
  ended(): Promise<void>;
  onEvent(callback: (event: AnnotateEvent) => void): () => void;
}

/** What main builds for a send or an add: the page's part of a `PageAnnotation`. */
export interface AnnotationMaterial {
  page:
    | { kind: 'page'; origin: string; path: string }
    | { kind: 'preview'; sessionId: string; leaseId: string; origin: string; path: string };
  /** When the element was picked (ISO 8601). */
  pickedAt: string;
  /** The page's navigation generation the pick and the send both belong to. */
  generation: number;
  pickId: string;
  note: string;
  element: AnnotateElement;
  styles: StyleChange[];
  /** Preview pages with the console toggle on; otherwise null. */
  console: { level: string; message: string }[] | null;
  screenshot: {
    mime: 'image/png';
    /** Base64. */
    data: string;
    width: number;
    height: number;
    /** Hex SHA-256 of the PNG bytes, for the attachment's provenance. */
    sha256: string;
  } | null;
}
