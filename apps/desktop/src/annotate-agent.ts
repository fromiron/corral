// The annotation mode's page agent (features/browser-annotate.md 계약: 페이지를 읽고 넣는 길).
//
// Main runs `agentScript(op, args)` in its own isolated world of the page: page scripts can't
// see or change it, and its state (the picks, the keyboard outline) lives in that world's
// global until the document goes. Neither the page nor the overlay supplies code: the agent is
// this fixed function, and its arguments are checked here and pass in as a JSON literal.
//
// Coordinates and sizes are the page's CSS pixels from its viewport's top left.
import type {
  AnnotateElement,
  AnnotatePick,
  AnnotateRect,
  AnnotateTarget,
  AnnotateTokens,
  StyleProperty,
} from './annotate-bridge.ts';

export const STYLE_PROPERTIES: readonly StyleProperty[] = [
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'color',
  'background-color',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'opacity',
  'margin',
  'padding',
  'display',
  'width',
  'height',
  'position',
];

export type AgentDirection = 'up' | 'down' | 'left' | 'right';

export interface AgentCalls {
  hover: { args: { x: number; y: number }; result: AnnotateTarget | null };
  frame: {
    args: { pointer: { x: number; y: number } | null; ids: string[] };
    result: { hover: AnnotateTarget | null; boxes: Record<string, AnnotateRect | null> };
  };
  pick: {
    args: { x: number; y: number; pickId: string } | { outline: true; pickId: string };
    result: AnnotatePick | null;
  };
  walk: { args: { direction: AgentDirection }; result: AnnotateTarget | null };
  tokens: { args: Record<string, never>; result: AnnotateTokens };
  /** The selector of a rule that matches the pick alone, or 'invalid' when the page refuses the value. */
  rule: {
    args: { pickId: string; property: StyleProperty; value: string };
    result: { selector: string } | 'invalid' | null;
  };
  /**
   * The pick's part in the page area now, whether a screenshot of it may be taken, and its rule
   * selector now (positional: it moves when the page inserts siblings before it).
   */
  shot: {
    args: { pickId: string };
    result: { bounds: AnnotateRect; safe: boolean; selector: string } | null;
  };
  release: { args: { pickId: string }; result: true };
  /** The mode ended: no outline. The picks stay for the markers of the same page. */
  reset: { args: Record<string, never>; result: true };
  /** The page moved without a new document (a route by pushState): forget every pick too. */
  clear: { args: Record<string, never>; result: true };
  /** Answers at once: tells main the page's renderer answers again. */
  probe: { args: Record<string, never>; result: true };
}

export type AgentOp = keyof AgentCalls;

/** A rule value Corral may put in a style sheet: one plain value, no way out of its declaration. */
export function styleValueAllowed(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control characters in a value.
    !/[;{}<>\\!"'`@\u0000-\u001f\u007f]|\/\*/.test(value)
  );
}

/** What a pick's rule selector must look like when it comes back from the page. */
export const RULE_SELECTOR = /^:root(?: > :nth-child\(\d{1,6}\)){1,256}$/;

// Runs in the isolated world. Self-contained: no imports, no closures over this module.
function agent(op: string, args: Record<string, unknown>): unknown {
  type State = {
    picks: Map<string, Element>;
    outline: Element | null;
    hovered: Element | null;
  };
  const host = window as unknown as { __corralAnnotate?: State };
  // Answers this call from now on, so later calls send only their arguments (agentCall).
  (window as unknown as { __corralAnnotateAgent?: typeof agent }).__corralAnnotateAgent = agent;
  host.__corralAnnotate ??= { picks: new Map(), outline: null, hovered: null };
  const state = host.__corralAnnotate;
  const FRAMES = new Set([
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'portal',
    'fencedframe',
  ]);
  const FIELDS =
    'input:not([type="hidden" i]), textarea, select, [contenteditable]:not([contenteditable="false" i])';
  const PROTECTED = `${FIELDS}, input, script, style, noscript, template`;
  const PROPERTIES = [
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-align',
    'color',
    'background-color',
    'border-color',
    'border-width',
    'border-style',
    'border-radius',
    'opacity',
    'margin',
    'padding',
    'display',
    'width',
    'height',
    'position',
  ];

  const rectOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  const visiblePart = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    return right > left && bottom > top
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : null;
  };
  const pickable = (element: Element | null | undefined): element is Element =>
    (element instanceof HTMLElement || element instanceof SVGElement) &&
    element.isConnected &&
    element !== document.body &&
    element !== document.documentElement &&
    !FRAMES.has(element.localName.toLowerCase()) &&
    visiblePart(element) !== null &&
    getComputedStyle(element).visibility !== 'hidden';

  const visibleText = (root: Element, limit: number, nodes: number) => {
    if (root.closest(PROTECTED)) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node instanceof Element) {
          const style = getComputedStyle(node);
          return node.matches(PROTECTED) ||
            style.display === 'none' ||
            style.visibility === 'hidden'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    let count = 0;
    for (let node = walker.nextNode(); node && text.length < limit && count++ < nodes; ) {
      text += (node.textContent ?? '').slice(0, limit - text.length);
      node = walker.nextNode();
    }
    return text;
  };
  const tidy = (value: string | null | undefined) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const NAMED_BY_CONTENT =
    'button, a[href], summary, h1, h2, h3, h4, h5, h6, option, legend, caption, ' +
    [
      'button',
      'link',
      'tab',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'heading',
      'checkbox',
      'radio',
      'switch',
      'option',
      'treeitem',
      'cell',
      'gridcell',
      'columnheader',
      'rowheader',
      'tooltip',
    ]
      .map((role) => `[role="${role}" i]`)
      .join(', ');
  const nameOf = (element: Element): string | null => {
    const label = tidy(element.getAttribute('aria-label'));
    if (label) return label;
    const by = element.getAttribute('aria-labelledby');
    if (by) {
      const text = tidy(
        by
          .split(/\s+/)
          .slice(0, 10)
          .map((id) => {
            const target = id ? document.getElementById(id) : null;
            return target ? visibleText(target, 200, 200) : '';
          })
          .join(' '),
      );
      if (text) return text;
    }
    if (element.matches('img, area, input[type="image" i]')) {
      const alt = tidy(element.getAttribute('alt'));
      if (alt) return alt;
    }
    const labels = (element as HTMLInputElement).labels;
    if (labels?.length) {
      const text = tidy([...labels].map((one) => visibleText(one, 200, 200)).join(' '));
      if (text) return text;
    }
    if (element.matches(NAMED_BY_CONTENT)) {
      const text = tidy(visibleText(element, 200, 200));
      if (text) return text;
    }
    return tidy(element.getAttribute('title'));
  };
  const target = (element: Element) => {
    const box = rectOf(element);
    const tag = element.localName.slice(0, 80);
    const first = element.classList[0]?.slice(0, 80);
    return {
      label: `${first ? `${tag}.${first}` : tag} ${Math.round(box.width)}×${Math.round(box.height)}`,
      name: nameOf(element),
      box,
    };
  };

  // Fields in the document and in open shadow roots; frames count, since Corral can't see in.
  // Null past the budget: too much to check, so no screenshot.
  const fieldsIn = (root: ParentNode, into: Element[] = [], budget = { left: 100000 }) => {
    for (const element of root.querySelectorAll('*')) {
      if (--budget.left < 0 || into.length > 5000) return null;
      if (element.matches(FIELDS) || FRAMES.has(element.localName.toLowerCase()))
        into.push(element);
      if (element.shadowRoot && !fieldsIn(element.shadowRoot, into, budget)) return null;
    }
    return into;
  };
  const shotSafe = (element: Element, part: AnnotateRect) => {
    if (element.closest(FIELDS)) return false;
    const fields = fieldsIn(document);
    if (!fields) return false;
    const inside = (node: Node) => element === node || element.contains(node);
    return !fields.some((field) => {
      // A field in a shadow root counts where its host is.
      let anchor: Node = field;
      while (anchor.getRootNode() instanceof ShadowRoot)
        anchor = (anchor.getRootNode() as ShadowRoot).host;
      if (inside(anchor)) return true;
      const box = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        box.width > 0 &&
        box.height > 0 &&
        box.left < part.x + part.width &&
        box.right > part.x &&
        box.top < part.y + part.height &&
        box.bottom > part.y
      );
    });
  };

  const pathOf = (element: Element) => {
    const parts: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.body;
      node = node.parentElement
    ) {
      if (parts.length === 12) break;
      const current = node;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (other) => other.localName === current.localName,
          )
        : [current];
      parts.unshift(
        `${current.localName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
      );
    }
    return parts.join(' > ').slice(0, 500);
  };
  const ruleSelector = (element: Element) => {
    const parts: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      const parent: Element | null = node.parentElement;
      if (!parent) return null;
      parts.unshift(`:nth-child(${[...parent.children].indexOf(node) + 1})`);
    }
    return [':root', ...parts].join(' > ');
  };
  const read = (element: Element, pickId: string) => {
    const part = visiblePart(element);
    if (!part) return null;
    const computed = getComputedStyle(element);
    const styles: Record<string, string> = {};
    for (const name of PROPERTIES) styles[name] = computed.getPropertyValue(name).slice(0, 200);
    const data: AnnotateElement = {
      tag: element.localName.toLowerCase().slice(0, 80),
      role: element.getAttribute('role')?.slice(0, 120) ?? null,
      selector: pathOf(element),
      text: visibleText(element, 4000, 2000).trim(),
      bounds: part,
      styles: styles as AnnotateElement['styles'],
    };
    return {
      pickId,
      ...target(element),
      element: data,
      screenshotAllowed: shotSafe(element, part),
    };
  };
  const live = (pickId: string) => {
    const element = state.picks.get(pickId);
    return element?.isConnected ? element : null;
  };
  const pointed = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    return pickable(element) ? element : null;
  };
  const hover = (x: number, y: number) => {
    const element = pointed(x, y);
    if (element !== state.hovered) {
      state.hovered = element;
      state.outline = element;
    }
    return element ? target(element) : null;
  };
  const step = (from: Element, direction: string) => {
    const next = (node: Element) =>
      direction === 'up'
        ? node.parentElement
        : direction === 'left'
          ? node.previousElementSibling
          : node.nextElementSibling;
    if (direction === 'down') {
      for (const child of from.children) if (pickable(child)) return child;
      return null;
    }
    for (let node = next(from); node; node = next(node)) {
      if (pickable(node)) return node;
    }
    return null;
  };

  switch (op) {
    case 'hover':
      return hover(args.x as number, args.y as number);
    case 'frame': {
      const pointer = args.pointer as { x: number; y: number } | null;
      const boxes: Record<string, AnnotateRect | null> = {};
      for (const id of args.ids as string[]) {
        const element = live(id);
        const box = element ? rectOf(element) : null;
        boxes[id] = box && (box.width > 0 || box.height > 0) ? box : null;
      }
      return { hover: pointer ? hover(pointer.x, pointer.y) : null, boxes };
    }
    case 'pick': {
      const element = args.outline
        ? pickable(state.outline)
          ? state.outline
          : null
        : pointed(args.x as number, args.y as number);
      if (!element) return null;
      const result = read(element, args.pickId as string);
      if (!result) return null;
      state.picks.set(args.pickId as string, element);
      state.outline = element;
      return result;
    }
    case 'walk': {
      if (!pickable(state.outline)) {
        state.outline = pointed(innerWidth / 2, innerHeight / 2);
        return state.outline ? target(state.outline) : null;
      }
      const next = step(state.outline, args.direction as string);
      if (!next) return null;
      state.outline = next;
      return target(next);
    }
    case 'tokens': {
      const names = new Set<string>();
      let budget = 20000;
      const visit = (rules: CSSRuleList | undefined) => {
        if (!rules) return;
        for (const rule of rules) {
          if (budget-- <= 0) return;
          const style = (rule as CSSStyleRule).style;
          const selector = (rule as CSSStyleRule).selectorText;
          if (
            style &&
            typeof selector === 'string' &&
            selector.split(',').some((one) => one.trim() === ':root')
          )
            for (let i = 0; i < style.length; i++) {
              const name = style.item(i);
              if (name.startsWith('--') && name.length <= 100) names.add(name);
            }
          visit((rule as CSSGroupingRule).cssRules);
        }
      };
      const sheets = [
        ...document.styleSheets,
        ...((document as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []),
      ];
      for (const sheet of sheets) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // Another origin's sheet: it can't be read, and is skipped.
        }
        visit(rules);
      }
      const root = getComputedStyle(document.documentElement);
      const colors: { name: string; value: string }[] = [];
      const lengths: { name: string; value: string }[] = [];
      for (const name of [...names].sort()) {
        const value = root.getPropertyValue(name).trim().slice(0, 200);
        if (!value) continue;
        if (CSS.supports('color', value)) colors.push({ name, value });
        else if (!/^[a-z-]+$/i.test(value) && CSS.supports('width', value))
          lengths.push({ name, value });
        if (colors.length + lengths.length >= 1000) break;
      }
      return { colors, lengths };
    }
    case 'rule': {
      const element = live(args.pickId as string);
      if (!element) return null;
      if (!CSS.supports(args.property as string, args.value as string)) return 'invalid';
      const selector = ruleSelector(element);
      return selector ? { selector } : null;
    }
    case 'shot': {
      const element = live(args.pickId as string);
      const part = element && visiblePart(element);
      const selector = element && part ? ruleSelector(element) : null;
      return element && part && selector
        ? { bounds: part, safe: shotSafe(element, part), selector }
        : null;
    }
    case 'release':
      state.picks.delete(args.pickId as string);
      return true;
    case 'reset':
      state.outline = null;
      state.hovered = null;
      return true;
    case 'clear':
      state.picks.clear();
      state.outline = null;
      state.hovered = null;
      return true;
    case 'probe':
      return true;
    default:
      return null;
  }
}

const PICK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const point = (value: unknown) => {
  const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
    throw new Error('Invalid annotate point');
  return { x, y };
};
const pickId = (value: unknown) => {
  if (typeof value !== 'string' || !PICK_ID.test(value)) throw new Error('Invalid pick id');
  return value;
};

/** What `agentCall` answers when this document's world has no agent yet: send `agentScript`. */
export const AGENT_MISSING = '__corral_annotate_agent_missing__';

/**
 * The short script for one call to an agent already in this document's world; it answers
 * AGENT_MISSING when there is none (a new document). Same checks as agentScript.
 */
export function agentCall<Op extends AgentOp>(op: Op, args: AgentCalls[Op]['args']): string {
  const call = JSON.stringify([op, cleanArgs(op, args)]).slice(1, -1);
  return `typeof __corralAnnotateAgent==='function'?__corralAnnotateAgent(${call}):${JSON.stringify(AGENT_MISSING)}`;
}

/** The fixed script for one agent call; throws on an operation or argument it doesn't take. */
export function agentScript<Op extends AgentOp>(op: Op, args: AgentCalls[Op]['args']): string {
  return `(${agent.toString()})(${JSON.stringify(op)},${JSON.stringify(cleanArgs(op, args))})`;
}

function cleanArgs<Op extends AgentOp>(op: Op, args: AgentCalls[Op]['args']) {
  const input = args as Record<string, unknown>;
  let clean: Record<string, unknown>;
  switch (op as AgentOp) {
    case 'hover':
      clean = point(input);
      break;
    case 'frame': {
      const ids = input.ids;
      if (!Array.isArray(ids) || ids.length > 200) throw new Error('Invalid tracked picks');
      clean = {
        pointer: input.pointer === null ? null : point(input.pointer),
        ids: ids.map(pickId),
      };
      break;
    }
    case 'pick':
      clean =
        input.outline === true
          ? { outline: true, pickId: pickId(input.pickId) }
          : { ...point(input), pickId: pickId(input.pickId) };
      break;
    case 'walk':
      if (!['up', 'down', 'left', 'right'].includes(input.direction as string))
        throw new Error('Invalid walk direction');
      clean = { direction: input.direction };
      break;
    case 'rule':
      if (!STYLE_PROPERTIES.includes(input.property as StyleProperty))
        throw new Error('Invalid style property');
      if (!styleValueAllowed(input.value)) throw new Error('Invalid style value');
      clean = { pickId: pickId(input.pickId), property: input.property, value: input.value };
      break;
    case 'shot':
    case 'release':
      clean = { pickId: pickId(input.pickId) };
      break;
    case 'tokens':
    case 'reset':
    case 'clear':
    case 'probe':
      clean = {};
      break;
    default:
      throw new Error('Unknown annotate operation');
  }
  return clean;
}
