// The annotation mode of one browser tab (docs/specs/features/browser-annotate.md): the overlay
// view over the page, the page reads with their time limit, the preview rules, and the way a
// note goes to the app page. The picks belong to the tab and its navigation generation, so a
// collected note's marker comes back when the mode is turned on again on the same page.
import { createHash } from 'node:crypto';
import type { Event, Input, NativeImage, Rectangle, WebContents, WebContentsView } from 'electron';
import {
  AGENT_MISSING,
  type AgentCalls,
  type AgentOp,
  agentCall,
  agentScript,
  RULE_SELECTOR,
  STYLE_PROPERTIES,
  styleValueAllowed,
} from './annotate-agent.ts';
import type {
  AnnotateElement,
  AnnotateEvent,
  AnnotatePage,
  AnnotatePick,
  AnnotatePoint,
  AnnotateRect,
  AnnotateSubmitResult,
  AnnotateTarget,
  AnnotationMaterial,
  StyleChange,
  StyleProperty,
} from './annotate-bridge.ts';
import { jsonWithin, OVERLAY_URL } from './annotate-overlay.ts';
import type { BrowserEvent } from './browser-bridge.ts';
import { observationUrl, safeObservationText } from './preview-observation.ts';
import { type DesktopPreviewTarget, validatePreviewTarget } from './preview-policy.ts';

/** Every page read's limit (계약: 읽기의 시간 한도). */
export const READ_LIMIT_MS = 1000;
/** How long the overlay may play its exit before the view goes anyway. */
export const ENDING_LIMIT_MS = 600;
/** The page agent's own isolated world (1001 is the preview element capture's). */
export const AGENT_WORLD = 1002;
const PIXELS_PER_LINE = 40;
/**
 * Three ID weights on a preview rule, matching every element, so it outranks the page's own
 * `#id … !important`. The rule is author origin: Electron's removeInsertedCSS can't take a
 * user-origin sheet off again (seen in Electron 44), so a page's inline `!important` still wins.
 */
const OUTRANK = ':not(#\\#c1):not(#\\#c2):not(#\\#c3)';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PICKS = 200;

/**
 * Whether a main-frame navigation starts a new generation: every new document does; a
 * same-document one only when the address changes outside its fragment (a route, not `#part`).
 */
export function movesGeneration(
  kind: 'document' | 'in-page',
  before: string | null,
  after: string,
): boolean {
  if (kind === 'document' || before === null) return true;
  const plain = (value: string) => {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  };
  return plain(before) !== plain(after);
}

type LeaseOf = { sessionId: string; leaseId: string; target: DesktopPreviewTarget } | null;

/** The page as a note carries it: origin and path, a preview's inside its lease; null if neither. */
function pageOf(page: WebContents, lease: LeaseOf): AnnotatePage | null {
  try {
    if (lease) {
      const address = observationUrl(page.getURL(), lease.target);
      const origin = lease.target.origin;
      return { kind: 'preview', origin, path: address.slice(origin.length) || '/' };
    }
    const url = new URL(page.getURL());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { kind: 'page', origin: url.origin, path: url.pathname.slice(0, 2048) };
  } catch {
    return null;
  }
}

/** The element's data as a note carries it: a preview's without its token or path prefix. */
function cleanElement(element: AnnotateElement, lease: LeaseOf): AnnotateElement {
  const clean = (value: string, max: number) =>
    (lease ? safeObservationText(value, lease.target) : value).slice(0, max);
  const styles = {} as AnnotateElement['styles'];
  for (const name of STYLE_PROPERTIES) styles[name] = clean(element.styles[name] ?? '', 200);
  return {
    tag: clean(element.tag, 80),
    role: element.role === null ? null : clean(element.role, 120),
    selector: clean(element.selector, 500),
    text: clean(element.text, 4000),
    bounds: element.bounds,
    styles,
  };
}

/** What the annotation needs from its tab; BrowserTabs builds it. */
export interface AnnotationHost {
  readonly tabId: string;
  readonly kind: 'page' | 'preview';
  /** The tab's page while it is live; null otherwise. */
  page(): WebContents | null;
  lease(): LeaseOf;
  resolveLease(): Promise<unknown>;
  /** The page area's rectangle in the window (DIP); null when the tab isn't shown. */
  rect(): Rectangle | null;
  /** Whether the page view shows now (false while the still picture stands in for it). */
  shown(): boolean;
  hostZoom(): number;
  createOverlay(): WebContentsView;
  addView(view: WebContentsView): void;
  removeView(view: WebContentsView): void;
  /** To the app page. */
  send(event: BrowserEvent): void;
  /** The tab's own key handling (Shift+Escape, the app's shortcuts, Mod+R, zoom). */
  key(event: Event, input: Input): void;
  focusChanged(focused: boolean): void;
  overlayOpened(contents: WebContents): void;
  overlayClosed(contents: WebContents): void;
  now(): number;
  id(): string;
  after(ms: number, run: () => void): () => void;
}

interface Pick {
  pickId: string;
  generation: number;
  pickedAt: number;
  element: AnnotateElement;
}

interface Slot {
  version: number;
  key: string | null;
  selector: string | null;
  value: string | null;
}

interface Submit {
  noteId: string;
  submitId: string | null;
  settle: (result: AnnotateSubmitResult) => void;
  settled: boolean;
}

interface Mode {
  view: WebContentsView;
  contents: WebContents;
  ready: boolean;
  /** Set while the overlay plays its exit; stops the time limit. */
  ending: (() => void) | null;
  /** The app page was told the mode is off. */
  offSent: boolean;
  focused: boolean;
  /** The overlay loaded while the still stood in: it takes the focus once it shows. */
  focusOwed: boolean;
  zoom: number;
  styles: Map<string, Map<StyleProperty, Slot>>;
  submits: Set<Submit>;
  console: { level: string; message: string }[];
  /** A read that passed its limit; the first answer after it ends "페이지가 답하지 않습니다". */
  busy: object | null;
  chain: Promise<void>;
  pending: number;
}

type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'busy' | 'skipped' | 'failed' };

const point = (value: unknown): AnnotatePoint => {
  const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > 100_000 ||
    Math.abs(y) > 100_000
  )
    throw new Error('Invalid annotate request');
  return { x, y };
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid annotate request');
  return value;
};
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid annotate request');
  const entry = value as Record<string, unknown>;
  const own = Object.keys(entry);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key)))
    throw new Error('Invalid annotate request');
  return entry;
};
const property = (value: unknown): StyleProperty => {
  if (!STYLE_PROPERTIES.includes(value as StyleProperty))
    throw new Error('Invalid annotate request');
  return value as StyleProperty;
};

export class TabAnnotation {
  private readonly host: AnnotationHost;
  private generation = 0;
  private url: string | null = null;
  private readonly picks = new Map<string, Pick>();
  private mode: Mode | null = null;
  private context: unknown;
  private hasContext = false;

  constructor(host: AnnotationHost) {
    this.host = host;
  }

  get on(): boolean {
    return this.mode !== null && !this.mode.ending;
  }

  overlay(): WebContents | null {
    return this.mode?.contents ?? null;
  }

  // ---- from the tab ----

  /** The mode on over the live page; false when the tab shows none. */
  turnOn(): boolean {
    const current = this.mode;
    if (current && !current.ending) return true;
    if (current) this.finish(current);
    const page = this.host.page();
    const rect = this.host.rect();
    if (!page || !rect) return false;
    const view = this.host.createOverlay();
    const contents = view.webContents;
    view.setBackgroundColor('#00000000');
    const mode: Mode = {
      view,
      contents,
      ready: false,
      ending: null,
      offSent: false,
      focused: false,
      focusOwed: false,
      zoom: this.host.hostZoom(),
      styles: new Map(),
      submits: new Set(),
      console: [],
      busy: null,
      chain: Promise.resolve(),
      pending: 0,
    };
    this.mode = mode;
    this.wireOverlay(mode);
    this.host.overlayOpened(contents);
    this.host.addView(view);
    this.layout();
    void contents.loadURL(OVERLAY_URL).catch(() => {
      // A failed load arrives as did-fail-load.
    });
    this.host.send({ type: 'annotate', tabId: this.host.tabId, on: true });
    return true;
  }

  /** Off by the person (the button, the shortcut, Escape): the overlay plays its exit first. */
  turnOff() {
    const mode = this.mode;
    if (!mode || mode.ending) return;
    this.sayOff(mode);
    this.cancelSubmits(mode);
    if (!mode.ready) {
      this.finish(mode);
      return;
    }
    mode.ending = this.host.after(ENDING_LIMIT_MS, () => this.finish(mode));
    this.tell(mode, { type: 'ending' });
  }

  /** Off at once: the page stopped showing (hidden, failed, crashed, closed, unloaded, ended). */
  end() {
    const mode = this.mode;
    if (mode) this.finish(mode);
  }

  /** The tab's view moved, showed or hid. */
  layout() {
    const mode = this.mode;
    if (!mode) return;
    const rect = this.host.rect();
    if (!rect || !this.host.page()) {
      this.end();
      return;
    }
    mode.view.setBounds(rect);
    mode.view.setVisible(this.host.shown());
    if (mode.focusOwed && mode.ready && this.host.shown()) this.focus();
    const zoom = this.host.hostZoom();
    if (zoom !== mode.zoom) {
      mode.zoom = zoom;
      if (mode.ready) mode.contents.setZoomFactor(zoom);
    }
  }

  /** The host gave keyboard focus back to the page area: it goes to the overlay. */
  focus(): boolean {
    const mode = this.mode;
    if (!mode || mode.ending) return false;
    mode.focusOwed = false;
    mode.contents.focus();
    if (mode.ready) this.tell(mode, { type: 'focus' });
    return true;
  }

  /** A main-frame commit: a new document, or a same-document move to `url`. */
  navigated(kind: 'document' | 'in-page', url: string) {
    const before = this.url;
    this.url = url;
    if (!movesGeneration(kind, before, url)) return;
    this.generation++;
    this.picks.clear();
    const mode = this.mode;
    if (!mode) return;
    mode.console = [];
    if (kind === 'in-page') {
      // The document stays: Corral's rules and the agent's picks are still in it.
      this.removeStyles(mode);
      void this.read(mode, 'clear', {});
    } else {
      mode.styles.clear();
    }
    if (mode.busy) {
      // A new document answered: the stalled read belonged to the old one.
      mode.busy = null;
      this.tell(mode, { type: 'page-busy', busy: false });
    }
    if (mode.ready && !mode.ending) {
      this.tell(mode, { type: 'navigated', generation: this.generation });
      this.tell(mode, { type: 'page', kind: this.host.kind, generation: this.generation });
    }
  }

  /** A preview page's console message, kept while the mode is on (the last 20). */
  consoleMessage(level: unknown, message: unknown) {
    const mode = this.mode;
    const lease = this.host.lease();
    if (!mode || !lease || this.host.kind !== 'preview' || typeof message !== 'string') return;
    mode.console.push({
      level: String(level).slice(0, 20),
      message: safeObservationText(message, lease.target).slice(0, 1000),
    });
    if (mode.console.length > 20) mode.console.shift();
  }

  /** The app page's context for the overlay; kept for the next overlay too. */
  setContext(context: unknown) {
    this.context = context;
    this.hasContext = true;
    const mode = this.mode;
    if (mode?.ready && !mode.ending) this.tell(mode, { type: 'context', context });
  }

  /** The app page's answer to a submit; a late or unknown one is dropped. */
  answer(submitId: string, outcome: unknown) {
    const submit = [...(this.mode?.submits ?? [])].find((entry) => entry.submitId === submitId);
    submit?.settle({ kind: 'answered', outcome });
  }

  /** The overlay's picture for the overlap still; null while it shows nothing yet. */
  async picture(): Promise<{ dataUrl: string; width: number; height: number } | null> {
    const mode = this.mode;
    if (!mode?.ready || mode.ending) return null;
    const image = await mode.contents.capturePage();
    if (this.mode !== mode) return null;
    const size = image.getSize();
    return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
  }

  // ---- from the overlay (already known to be this tab's) ----

  async call(name: string, args: unknown[]): Promise<unknown> {
    const mode = this.mode;
    if (!mode) throw new Error('The annotation mode is off');
    if (name === 'ended') {
      if (mode.ending) this.finish(mode);
      return;
    }
    if (mode.ending)
      return name === 'frame' || name === 'walk' || name === 'inspect' || name === 'console-for'
        ? null
        : undefined;
    switch (name) {
      case 'frame':
        return this.frame(mode, args[0]);
      case 'pick':
        return this.pick(mode, args[0]);
      case 'walk':
        return this.walk(mode, args[0]);
      case 'wheel':
        this.wheel(mode, args[0]);
        return;
      case 'inspect':
        return this.inspect(mode, args[0]);
      case 'console-for':
        return this.consoleFor(mode, id(args[0]));
      case 'preview':
        return this.preview(mode, args[0], args[1], args[2]);
      case 'release':
        this.release(mode, id(args[0]));
        return;
      case 'submit':
        return this.submit(mode, args[0]);
      case 'cancel-submit':
        this.cancelSubmit(mode, id(args[0]));
        return;
      case 'tell':
        this.host.send({
          type: 'annotate-message',
          tabId: this.host.tabId,
          message: jsonWithin(args[0], 16 * 1024),
        });
        return;
      case 'end':
        this.turnOff();
        return;
      default:
        throw new Error('Unknown annotate request');
    }
  }

  private async frame(mode: Mode, raw: unknown) {
    const input = exact(raw, ['pointer', 'track']);
    const pointer = input.pointer === null ? null : point(input.pointer);
    if (!Array.isArray(input.track) || input.track.length > MAX_PICKS)
      throw new Error('Invalid annotate request');
    const track = input.track.map(id);
    const page = this.host.page();
    if (!page || !this.host.shown()) return null;
    const generation = this.generation;
    const ids = track.filter((pickId) => this.picks.has(pickId));
    const scale = this.scale(page);
    const result = await this.read(
      mode,
      'frame',
      { pointer: pointer && scale.toPage(pointer), ids },
      true,
    );
    if (result.kind !== 'ok' || !this.same(mode, page, generation)) return null;
    const boxes: Record<string, AnnotateRect | null> = {};
    for (const pickId of track) {
      const box = result.value.boxes[pickId];
      boxes[pickId] = box ? scale.toOverlay(box) : null;
    }
    const view = scale.toOverlay({ x: 0, y: 0, ...result.value.view });
    return {
      hover: this.target(result.value.hover, scale),
      boxes,
      view: { width: view.width, height: view.height },
    };
  }

  private async pick(
    mode: Mode,
    raw: unknown,
  ): Promise<
    | { ok: true; pick: AnnotatePick }
    | { ok: false; reason: 'nothing' | 'page-changed' | 'page-busy' }
  > {
    const at = raw === 'outline' ? 'outline' : point(raw);
    const page = this.host.page();
    if (!page) return { ok: false, reason: 'page-changed' };
    const generation = this.generation;
    const lease = this.host.lease();
    const pickId = this.host.id();
    if (!ID.test(pickId)) throw new Error('Invalid pick id');
    const scale = this.scale(page);
    const result = await this.read(
      mode,
      'pick',
      at === 'outline' ? { outline: true, pickId } : { ...scale.toPage(at), pickId },
    );
    if (result.kind === 'busy') return { ok: false, reason: 'page-busy' };
    if (!this.same(mode, page, generation) || this.host.lease() !== lease)
      return { ok: false, reason: 'page-changed' };
    if (result.kind !== 'ok' || !result.value) return { ok: false, reason: 'nothing' };
    const found = result.value;
    const where = pageOf(page, lease);
    if (!where) return { ok: false, reason: 'nothing' };
    // The overlay shows the element as the note will carry it (a preview's without its token).
    const element = cleanElement(found.element, lease);
    if (this.picks.size >= MAX_PICKS) {
      const oldest = this.picks.keys().next().value;
      if (oldest) this.picks.delete(oldest);
    }
    this.picks.set(pickId, { pickId, generation, pickedAt: this.host.now(), element });
    return {
      ok: true,
      pick: {
        pickId,
        label: found.label,
        name: found.name,
        box: scale.toOverlay(found.box),
        page: where,
        element,
        screenshotAllowed: found.screenshotAllowed,
      },
    };
  }

  private async walk(mode: Mode, raw: unknown): Promise<AnnotateTarget | null> {
    if (raw !== 'up' && raw !== 'down' && raw !== 'left' && raw !== 'right')
      throw new Error('Invalid annotate request');
    const page = this.host.page();
    if (!page) return null;
    const generation = this.generation;
    const scale = this.scale(page);
    const result = await this.read(mode, 'walk', { direction: raw });
    if (result.kind !== 'ok' || !this.same(mode, page, generation)) return null;
    return this.target(result.value, scale);
  }

  private wheel(mode: Mode, raw: unknown) {
    const input = exact(raw, ['x', 'y', 'deltaX', 'deltaY', 'deltaMode']);
    const at = point(input);
    const delta = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000)
        throw new Error('Invalid annotate request');
      return value;
    };
    const deltaX = delta(input.deltaX);
    const deltaY = delta(input.deltaY);
    if (input.deltaMode !== 0 && input.deltaMode !== 1 && input.deltaMode !== 2)
      throw new Error('Invalid annotate request');
    const page = this.host.page();
    const rect = this.host.rect();
    // A page that doesn't answer gets no queue of wheels to jump through later.
    if (!page || !rect || mode.busy || !this.host.shown()) return;
    const host = this.host.hostZoom() || 1;
    const unit =
      input.deltaMode === 1 ? PIXELS_PER_LINE : input.deltaMode === 2 ? rect.height / host : 1;
    // Electron's wheel delta has the opposite sign of the DOM's; both in DIP here.
    page.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(at.x * host),
      y: Math.round(at.y * host),
      deltaX: -deltaX * unit * host,
      deltaY: -deltaY * unit * host,
      canScroll: true,
    });
  }

  private async inspect(mode: Mode, raw: unknown) {
    const pickId = id(raw);
    const page = this.host.page();
    if (!page || !this.picks.has(pickId)) return null;
    const generation = this.generation;
    const result = await this.read(mode, 'inspect', { pickId });
    if (result.kind !== 'ok' || !this.same(mode, page, generation)) return null;
    return result.value;
  }

  private async preview(
    mode: Mode,
    rawPick: unknown,
    rawProperty: unknown,
    rawValue: unknown,
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'page-changed' | 'page-busy' }> {
    const pickId = id(rawPick);
    const name = property(rawProperty);
    if (rawValue !== null && typeof rawValue !== 'string')
      throw new Error('Invalid annotate request');
    const page = this.host.page();
    const generation = this.generation;
    if (!page || !this.picks.has(pickId)) return { ok: false, reason: 'page-changed' };
    const slots = mode.styles.get(pickId) ?? new Map<StyleProperty, Slot>();
    mode.styles.set(pickId, slots);
    const slot = slots.get(name) ?? { version: 0, key: null, selector: null, value: null };
    slots.set(name, slot);
    const version = ++slot.version;
    if (rawValue === null) {
      this.unset(page, slot);
      slots.delete(name);
      return { ok: true };
    }
    if (!styleValueAllowed(rawValue)) return { ok: false, reason: 'invalid' };
    const rule = await this.read(mode, 'rule', { pickId, property: name, value: rawValue });
    if (rule.kind === 'busy') return { ok: false, reason: 'page-busy' };
    if (!this.same(mode, page, generation)) return { ok: false, reason: 'page-changed' };
    // A newer value for this property came meanwhile (a dragged swatch): it is the one shown.
    if (slot.version !== version) return { ok: true };
    if (rule.kind !== 'ok' || !rule.value) return { ok: false, reason: 'page-changed' };
    if (rule.value === 'invalid') return { ok: false, reason: 'invalid' };
    const selector = rule.value.selector;
    if (!RULE_SELECTOR.test(selector)) return { ok: false, reason: 'page-changed' };
    const placed = await this.place(
      mode,
      page,
      generation,
      slot,
      version,
      selector,
      name,
      rawValue,
    );
    return placed === 'ok' || placed === 'superseded'
      ? { ok: true }
      : { ok: false, reason: placed };
  }

  /** Puts one preview rule in; the slot's earlier rule comes out once the new one is in. */
  private async place(
    mode: Mode,
    page: WebContents,
    generation: number,
    slot: Slot,
    version: number,
    selector: string,
    name: StyleProperty,
    value: string,
  ): Promise<'ok' | 'superseded' | 'page-changed' | 'page-busy'> {
    let abandoned = false;
    const css = `${selector}${OUTRANK} { ${name}: ${value} !important; }`;
    const result = await this.limited(mode, () => {
      const work = page.insertCSS(css, { cssOrigin: 'author' });
      // However late it lands, a rule nobody wants any more comes out again.
      void work.then(
        (key) => {
          const wanted =
            !abandoned &&
            this.same(mode, page, generation) &&
            slot.version === version &&
            [...mode.styles.values()].some((slots) => [...slots.values()].includes(slot));
          if (!wanted) {
            void page.removeInsertedCSS(key).catch(() => {});
            return;
          }
          if (slot.key) void page.removeInsertedCSS(slot.key).catch(() => {});
          slot.key = key;
          slot.selector = selector;
          slot.value = value;
        },
        () => {},
      );
      return work;
    });
    if (result.kind === 'busy') {
      abandoned = true;
      return 'page-busy';
    }
    if (result.kind !== 'ok' || !this.same(mode, page, generation)) {
      abandoned = true;
      return 'page-changed';
    }
    return slot.version === version ? 'ok' : 'superseded';
  }

  private release(mode: Mode, pickId: string) {
    const page = this.host.page();
    const slots = mode.styles.get(pickId);
    if (slots && page) for (const slot of slots.values()) this.unset(page, slot);
    mode.styles.delete(pickId);
    if (!this.picks.delete(pickId) || !page || mode.busy) return;
    void this.read(mode, 'release', { pickId });
  }

  private async submit(mode: Mode, raw: unknown): Promise<AnnotateSubmitResult> {
    const input = exact(raw, [
      'noteId',
      'pickId',
      'intent',
      'text',
      'styles',
      'screenshot',
      'console',
      'extra',
    ]);
    const noteId = id(input.noteId);
    const pickId = id(input.pickId);
    if (input.intent !== 'send' && input.intent !== 'add')
      throw new Error('Invalid annotate request');
    const intent = input.intent;
    if (typeof input.text !== 'string' || input.text.length > 4000)
      throw new Error('Invalid annotate request');
    const text = input.text;
    if (typeof input.screenshot !== 'boolean' || typeof input.console !== 'boolean')
      throw new Error('Invalid annotate request');
    const wantShot = input.screenshot;
    const wantConsole = input.console;
    const styles = this.styleChanges(input.styles);
    const extra = jsonWithin(input.extra ?? null, 16 * 1024);
    if ([...mode.submits].some((entry) => entry.noteId === noteId)) return { kind: 'cancelled' };
    let settle!: (result: AnnotateSubmitResult) => void;
    const answer = new Promise<AnnotateSubmitResult>((resolve) => {
      settle = resolve;
    });
    const submit: Submit = {
      noteId,
      submitId: null,
      settled: false,
      settle: (result) => {
        if (submit.settled) return;
        submit.settled = true;
        mode.submits.delete(submit);
        settle(result);
      },
    };
    mode.submits.add(submit);
    void this.prepare(mode, submit, { pickId, intent, text, styles, wantShot, wantConsole, extra })
      .then((result) => {
        if (result) submit.settle(result);
      })
      .catch(() => submit.settle({ kind: 'page-changed' }));
    return answer;
  }

  /** The re-check, the screenshot and the material; null once it went to the app page. */
  private async prepare(
    mode: Mode,
    submit: Submit,
    note: {
      pickId: string;
      intent: 'send' | 'add';
      text: string;
      styles: StyleChange[];
      wantShot: boolean;
      wantConsole: boolean;
      extra: unknown;
    },
  ): Promise<AnnotateSubmitResult | null> {
    const pick = this.picks.get(note.pickId);
    const page = this.host.page();
    const lease = this.host.lease();
    const generation = this.generation;
    if (!pick || !page || pick.generation !== generation) return { kind: 'page-changed' };
    const still = () =>
      submit.settled
        ? 'cancelled'
        : this.same(mode, page, generation) && this.host.lease() === lease
          ? null
          : 'page-changed';
    if (lease) {
      let target: DesktopPreviewTarget;
      try {
        target = validatePreviewTarget(await this.host.resolveLease());
      } catch {
        return { kind: 'page-changed' };
      }
      const changed = still();
      if (changed) return { kind: changed };
      if (JSON.stringify(target) !== JSON.stringify(lease.target)) return { kind: 'page-changed' };
    }
    const shot = await this.read(mode, 'shot', { pickId: note.pickId });
    if (shot.kind === 'busy') return { kind: 'page-busy' };
    const changed = still();
    if (changed) return { kind: changed };
    if (shot.kind !== 'ok' || !shot.value) return { kind: 'not-visible' };
    const { bounds, safe, selector } = shot.value;
    // A preview rule follows its element by position: put it back on the element before the shot.
    const slots = mode.styles.get(note.pickId);
    if (slots && RULE_SELECTOR.test(selector))
      for (const [name, slot] of slots)
        if (slot.selector && slot.selector !== selector && slot.value) {
          const version = ++slot.version;
          const placed = await this.place(
            mode,
            page,
            generation,
            slot,
            version,
            selector,
            name,
            slot.value,
          );
          if (placed === 'page-changed' || placed === 'page-busy') return { kind: placed };
        }
    let screenshot: AnnotationMaterial['screenshot'] = null;
    if (note.wantShot) {
      if (!safe) return { kind: 'input-fields' };
      const zoom = page.getZoomFactor() || 1;
      const rect = {
        x: Math.ceil(bounds.x * zoom),
        y: Math.ceil(bounds.y * zoom),
        width: Math.floor(bounds.width * zoom),
        height: Math.floor(bounds.height * zoom),
      };
      if (rect.width < 1 || rect.height < 1) return { kind: 'not-visible' };
      if (rect.width > 2048 || rect.height > 2048) return { kind: 'image-limit' };
      const taken = await this.limited<NativeImage>(mode, () => page.capturePage(rect));
      if (taken.kind === 'busy') return { kind: 'page-busy' };
      const after = still();
      if (after) return { kind: after };
      if (taken.kind !== 'ok') return { kind: 'page-changed' };
      const size = taken.value.getSize(1);
      const bytes = taken.value.toPNG({ scaleFactor: 1 });
      if (
        !size.width ||
        !size.height ||
        size.width > 2048 ||
        size.height > 2048 ||
        bytes.length > 1024 * 1024
      )
        return { kind: 'image-limit' };
      screenshot = {
        mime: 'image/png',
        data: bytes.toString('base64'),
        width: size.width,
        height: size.height,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    const material = this.material(page, lease, pick, note, bounds, screenshot, mode);
    if (!material) return { kind: 'page-changed' };
    const last = still();
    if (last) return { kind: last };
    submit.submitId = this.host.id();
    this.host.send({
      type: 'annotate-submit',
      tabId: this.host.tabId,
      submitId: submit.submitId,
      noteId: submit.noteId,
      intent: note.intent,
      material,
      extra: note.extra,
    });
    return null;
  }

  private material(
    page: WebContents,
    lease: ReturnType<AnnotationHost['lease']>,
    pick: Pick,
    note: { text: string; styles: StyleChange[]; wantConsole: boolean },
    bounds: AnnotateRect,
    screenshot: AnnotationMaterial['screenshot'],
    mode: Mode,
  ): AnnotationMaterial | null {
    const where = pageOf(page, lease);
    if (!where) return null;
    const clean = (value: string, max: number) =>
      (lease ? safeObservationText(value, lease.target) : value).slice(0, max);
    return {
      page:
        where.kind === 'preview' && lease
          ? { ...where, kind: 'preview', sessionId: lease.sessionId, leaseId: lease.leaseId }
          : { kind: 'page', origin: where.origin, path: where.path },
      pickedAt: new Date(pick.pickedAt).toISOString(),
      generation: pick.generation,
      pickId: pick.pickId,
      note: note.text,
      element: { ...pick.element, bounds },
      styles: note.styles.map((change) => ({
        property: change.property,
        before: clean(change.before, 200),
        after: change.after,
      })),
      console: note.wantConsole ? this.consoleCarried(mode) : null,
      screenshot,
    };
  }

  /** The console a send carries now: a preview page's buffer, as kept; none for other pages. */
  private consoleCarried(mode: Mode): { level: string; message: string }[] | null {
    return this.host.lease() ? mode.console.map((entry) => ({ ...entry })) : null;
  }

  /**
   * What the console toggle would add to a send of this pick now, for the overlay to show before
   * it goes (the same as `consoleCarried`); null for a pick of another page or none.
   */
  private consoleFor(mode: Mode, pickId: string) {
    const pick = this.picks.get(pickId);
    if (!pick || pick.generation !== this.generation) return null;
    return this.consoleCarried(mode);
  }

  private styleChanges(raw: unknown): StyleChange[] {
    if (!Array.isArray(raw) || raw.length > STYLE_PROPERTIES.length)
      throw new Error('Invalid annotate request');
    const seen = new Set<StyleProperty>();
    return raw.map((entry) => {
      const change = exact(entry, ['property', 'before', 'after']);
      const name = property(change.property);
      if (seen.has(name)) throw new Error('Invalid annotate request');
      seen.add(name);
      if (typeof change.before !== 'string' || change.before.length > 200)
        throw new Error('Invalid annotate request');
      if (!styleValueAllowed(change.after)) throw new Error('Invalid annotate request');
      return { property: name, before: change.before, after: change.after };
    });
  }

  private cancelSubmit(mode: Mode, noteId: string) {
    for (const submit of [...mode.submits])
      if (submit.noteId === noteId) {
        if (submit.submitId)
          this.host.send({
            type: 'annotate-cancel',
            tabId: this.host.tabId,
            submitId: submit.submitId,
          });
        submit.settle({ kind: 'cancelled' });
      }
  }

  // ---- internals ----

  private wireOverlay(mode: Mode) {
    const { contents } = mode;
    const current = () => this.mode === mode;
    contents.on('did-finish-load', () => {
      if (!current()) return;
      mode.ready = true;
      contents.setZoomFactor(mode.zoom);
      this.tell(mode, { type: 'page', kind: this.host.kind, generation: this.generation });
      if (this.hasContext) this.tell(mode, { type: 'context', context: this.context });
      if (this.host.shown()) this.focus();
      else mode.focusOwed = true;
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (current() && isMainFrame && code !== -3) this.end();
    });
    contents.on('render-process-gone', () => {
      if (current()) this.end();
    });
    contents.once('destroyed', () => {
      if (current()) this.end();
    });
    contents.on('before-input-event', (event, input) => {
      if (current()) this.host.key(event, input);
    });
    contents.on('focus', () => {
      if (!current()) return;
      mode.focused = true;
      this.host.focusChanged(true);
    });
    contents.on('blur', () => {
      if (!current()) return;
      mode.focused = false;
      this.host.focusChanged(false);
    });
    // The overlay is one page that never moves or opens anything.
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  private finish(mode: Mode) {
    if (this.mode !== mode) return;
    this.mode = null;
    mode.ending?.();
    mode.ending = null;
    this.cancelSubmits(mode);
    const page = this.host.page();
    if (page) {
      this.removeStyles(mode);
      if (!mode.busy)
        void page
          .executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: agentCall('reset', {}) }])
          .catch(() => {});
    }
    this.host.removeView(mode.view);
    this.host.overlayClosed(mode.contents);
    if (!mode.contents.isDestroyed()) mode.contents.close();
    this.sayOff(mode);
    if (!mode.focused) return;
    // The keyboard was in the overlay: back to the page, or nowhere in this tab.
    this.host.focusChanged(false);
    if (page && this.host.shown()) page.focus();
  }

  private sayOff(mode: Mode) {
    if (mode.offSent) return;
    mode.offSent = true;
    this.host.send({ type: 'annotate', tabId: this.host.tabId, on: false });
  }

  private cancelSubmits(mode: Mode) {
    for (const submit of [...mode.submits]) {
      if (submit.submitId)
        this.host.send({
          type: 'annotate-cancel',
          tabId: this.host.tabId,
          submitId: submit.submitId,
        });
      submit.settle({ kind: 'cancelled' });
    }
  }

  private removeStyles(mode: Mode) {
    const page = this.host.page();
    for (const slots of mode.styles.values())
      for (const slot of slots.values()) if (page) this.unset(page, slot);
    mode.styles.clear();
  }

  private unset(page: WebContents, slot: Slot) {
    slot.version++;
    if (slot.key) void page.removeInsertedCSS(slot.key).catch(() => {});
    slot.key = null;
    slot.selector = null;
    slot.value = null;
  }

  private tell(mode: Mode, event: AnnotateEvent) {
    if (!mode.contents.isDestroyed()) mode.contents.send('annotate:event', event);
  }

  private same(mode: Mode, page: WebContents, generation: number) {
    return (
      this.mode === mode &&
      !mode.ending &&
      this.host.page() === page &&
      this.generation === generation &&
      !page.isDestroyed()
    );
  }

  private scale(page: WebContents) {
    const host = this.host.hostZoom() || 1;
    const zoom = page.getZoomFactor() || 1;
    const toPage = (at: AnnotatePoint) => ({ x: (at.x * host) / zoom, y: (at.y * host) / zoom });
    const toOverlay = (box: AnnotateRect): AnnotateRect => ({
      x: (box.x * zoom) / host,
      y: (box.y * zoom) / host,
      width: (box.width * zoom) / host,
      height: (box.height * zoom) / host,
    });
    return { toPage, toOverlay };
  }

  private target(value: AnnotateTarget | null, scale: ReturnType<TabAnnotation['scale']>) {
    return value ? { label: value.label, name: value.name, box: scale.toOverlay(value.box) } : null;
  }

  /** One agent call as a limited read: the short call, the whole agent on a new document. */
  private read<Op extends AgentOp>(
    mode: Mode,
    op: Op,
    args: AgentCalls[Op]['args'],
    skippable = false,
  ): Promise<Outcome<AgentCalls[Op]['result']>> {
    const page = this.host.page();
    if (!page) return Promise.resolve({ kind: 'failed' });
    return this.limited(
      mode,
      () =>
        page
          .executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: agentCall(op, args) }])
          .then((value) =>
            value === AGENT_MISSING
              ? page.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [
                  { code: agentScript(op, args) },
                ])
              : value,
          ),
      skippable,
    );
  }

  /**
   * One page read at a time per tab, each with its limit. Past it the read is dropped (its late
   * answer unused), the overlay hears the page doesn't answer, and until the page answers again
   * every read answers 'busy' at once. A skippable read (a frame's) isn't queued behind another.
   */
  private limited<T>(mode: Mode, start: () => Promise<T>, skippable = false): Promise<Outcome<T>> {
    if (mode.busy) return Promise.resolve({ kind: 'busy' });
    if (skippable && mode.pending > 0) return Promise.resolve({ kind: 'skipped' });
    mode.pending++;
    const run = () =>
      new Promise<Outcome<T>>((resolve) => {
        if (this.mode !== mode) return resolve({ kind: 'failed' });
        if (mode.busy) return resolve({ kind: 'busy' });
        let work: Promise<T>;
        try {
          work = start();
        } catch {
          return resolve({ kind: 'failed' });
        }
        let settled = false;
        const stop = this.host.after(READ_LIMIT_MS, () => {
          if (settled) return;
          settled = true;
          this.stall(mode, work);
          resolve({ kind: 'busy' });
        });
        work.then(
          (value) => {
            if (settled) return;
            settled = true;
            stop();
            resolve({ kind: 'ok', value });
          },
          () => {
            if (settled) return;
            settled = true;
            stop();
            resolve({ kind: 'failed' });
          },
        );
      });
    const result = mode.chain.then(run);
    mode.chain = result.then(() => undefined);
    return result.finally(() => {
      mode.pending--;
    });
  }

  /** "페이지가 답하지 않습니다": the first answer from the page (the late read or a probe) ends it. */
  private stall(mode: Mode, work: Promise<unknown>) {
    if (mode.busy || this.mode !== mode) return;
    const token = {};
    mode.busy = token;
    this.tell(mode, { type: 'page-busy', busy: true });
    const recover = () => {
      if (this.mode !== mode || mode.busy !== token) return;
      mode.busy = null;
      this.tell(mode, { type: 'page-busy', busy: false });
    };
    work.then(recover, recover);
    const page = this.host.page();
    if (page)
      void page
        .executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: agentCall('probe', {}) }])
        .then(recover, recover);
  }
}
