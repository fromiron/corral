// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGENT_MISSING, agentCall, agentScript } from '../src/annotate-agent.ts';

type Rect = [number, number, number, number];
const rects = new Map<Element, Rect>();
let atPoint: (x: number, y: number) => Element | null = () => null;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => atPoint(x, y),
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [x, y, width, height] = rects.get(this) ?? [0, 0, 0, 0];
    return new DOMRect(x, y, width, height);
  });
  (globalThis as { CSS?: unknown }).CSS = {
    supports: (property: string, value: string) =>
      value.startsWith('var(') ||
      (property === 'color' || property.endsWith('-color')
        ? /^(#|rgb|red|blue)/.test(value)
        : /^-?\d+(\.\d+)?(px|rem|em|%)$|^(bold|center|none|block|flex|solid|relative)$/.test(
            value,
          )),
  };
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  rects.clear();
  atPoint = () => null;
  delete (window as { __corralAnnotate?: unknown }).__corralAnnotate;
  delete (window as { __corralAnnotateAgent?: unknown }).__corralAnnotateAgent;
  vi.restoreAllMocks();
});

function call(op: string, args: Record<string, unknown> = {}) {
  // biome-ignore lint/security/noGlobalEval: Execute only our fixed agent script against the test DOM.
  return window.eval(agentScript(op as never, args as never));
}

function page(html: string, layout: Record<string, Rect>) {
  document.body.innerHTML = html;
  for (const [selector, rect] of Object.entries(layout)) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(selector);
    rects.set(element, rect);
  }
}

it('hover names the element under the pointer and refuses the page itself and frames', () => {
  page(
    '<main id="m"><button class="pay primary" aria-label="Pay now">Pay</button><p id="p">Hello</p><iframe id="f"></iframe></main>',
    {
      button: [10, 20, 120, 32],
      '#p': [10, 60, 100.4, 19.6],
      '#f': [0, 100, 300, 150],
      '#m': [0, 0, 800, 600],
    },
  );
  const button = document.querySelector('button');
  atPoint = () => button;
  expect(call('hover', { x: 15, y: 25 })).toEqual({
    label: 'button.pay 120×32',
    name: 'Pay now',
    box: { x: 10, y: 20, width: 120, height: 32 },
  });
  atPoint = () => document.getElementById('p');
  expect(call('hover', { x: 15, y: 65 })).toMatchObject({ label: 'p 100×20', name: null });
  for (const element of [
    document.body,
    document.documentElement,
    document.getElementById('f'),
    null,
  ]) {
    atPoint = () => element;
    expect(call('hover', { x: 1, y: 1 })).toBeNull();
  }
  // Nothing of it in the page area.
  rects.set(button as Element, [-200, -100, 120, 32]);
  atPoint = () => button;
  expect(call('hover', { x: 1, y: 1 })).toBeNull();
});

it('a pick reads what a send carries, keeps the element by its id until released', () => {
  page(
    '<form id="f" class="checkout"><label>Card <input id="card" value="4111 1111"></label><textarea>note-secret</textarea><b>Total</b></form><p id="other">Other</p>',
    {
      '#f': [0, 0, 400, 200],
      '#card': [10, 45, 200, 30],
      b: [10, 50, 60, 20],
      '#other': [0, 300, 100, 20],
    },
  );
  atPoint = () => document.getElementById('f');
  const pick = call('pick', { x: 5, y: 5, pickId: 'g1-p1' });
  expect(pick).toMatchObject({
    pickId: 'g1-p1',
    label: 'form.checkout 400×200',
    element: {
      tag: 'form',
      role: null,
      selector: 'form:nth-of-type(1)',
      bounds: { x: 0, y: 0, width: 400, height: 200 },
    },
    screenshotAllowed: false,
  });
  expect(pick.element.text).toContain('Total');
  expect(pick.element.text).not.toMatch(/4111|note-secret/);
  expect(Object.keys(pick.element.styles)).toEqual([
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
  ]);
  expect(call('frame', { pointer: null, ids: ['g1-p1', 'g1-p9'] })).toEqual({
    hover: null,
    boxes: { 'g1-p1': { x: 0, y: 0, width: 400, height: 200 }, 'g1-p9': null },
  });
  // A field elsewhere on screen over the element's part also stops the screenshot.
  atPoint = () => document.querySelector('b');
  const bold = call('pick', { x: 12, y: 52, pickId: 'g1-p2' });
  expect(bold.screenshotAllowed).toBe(false);
  // Moved below it: no longer over it.
  rects.set(document.getElementById('card') as Element, [10, 100, 200, 30]);
  expect(call('shot', { pickId: 'g1-p2' })).toEqual({
    bounds: { x: 10, y: 50, width: 60, height: 20 },
    safe: true,
    selector: ':root > :nth-child(2) > :nth-child(1) > :nth-child(3)',
  });
  // Not drawn now (display: none): no box to mark.
  rects.set(document.getElementById('f') as Element, [0, 0, 0, 0]);
  expect(call('frame', { pointer: null, ids: ['g1-p1'] }).boxes['g1-p1']).toBeNull();
  rects.set(document.getElementById('f') as Element, [0, 0, 400, 200]);
  call('release', { pickId: 'g1-p1' });
  expect(call('frame', { pointer: null, ids: ['g1-p1'] }).boxes['g1-p1']).toBeNull();
  // Gone from the page: no box, no shot.
  document.querySelector('b')?.remove();
  expect(call('shot', { pickId: 'g1-p2' })).toBeNull();
  expect(call('pick', { x: 1, y: 1, pickId: 'g1-p3' })).toBeNull();
});

it("fields Corral can't look into stop the screenshot too: a frame's, an open shadow root's", () => {
  page(
    '<section id="pay"><iframe id="card"></iframe></section><section id="host-box"><x-field id="host"></x-field></section><section id="plain"><input type="hidden" value="csrf">Plain</section>',
    {
      '#pay': [0, 0, 300, 100],
      '#card': [0, 0, 300, 50],
      '#host-box': [0, 200, 300, 100],
      '#host': [0, 200, 300, 40],
      '#plain': [0, 400, 300, 100],
    },
  );
  const host = document.getElementById('host') as HTMLElement;
  const inner = document.createElement('input');
  host.attachShadow({ mode: 'open' }).append(inner);
  rects.set(inner, [0, 200, 300, 40]);
  const shot = (selector: string, pickId: string) => {
    atPoint = () => document.querySelector(selector);
    return call('pick', { x: 1, y: 1, pickId }).screenshotAllowed;
  };
  expect(shot('#pay', 'g1-p1')).toBe(false);
  expect(shot('#host-box', 'g1-p2')).toBe(false);
  // A hidden input shows nothing on screen.
  expect(shot('#plain', 'g1-p3')).toBe(true);
});

it('the keyboard walks parent, first child and siblings, skipping what cannot be picked', () => {
  page(
    '<section id="s"><div id="a"><span id="a1">a1</span></div><iframe id="frame"></iframe><div id="hidden"></div><div id="c">c</div></section>',
    {
      '#s': [0, 0, 800, 600],
      '#a': [0, 0, 200, 100],
      '#a1': [0, 0, 50, 20],
      '#frame': [0, 120, 200, 100],
      '#c': [0, 300, 200, 100],
    },
  );
  atPoint = (x, y) => (x === 400 && y === 300 ? document.getElementById('a') : null);
  const id = (target: { label: string } | null) => target?.label.split(' ')[0];
  // No outline yet: the first key puts it on the element at the page area's centre.
  expect(id(call('walk', { direction: 'down' }))).toBe('div');
  expect(id(call('walk', { direction: 'down' }))).toBe('span');
  expect(call('walk', { direction: 'down' })).toBeNull(); // no child: nothing happens
  expect(id(call('walk', { direction: 'up' }))).toBe('div');
  // → skips the frame and the element with nothing on screen.
  expect(call('walk', { direction: 'right' })).toMatchObject({ box: { y: 300 } });
  expect(call('walk', { direction: 'right' })).toBeNull();
  expect(call('walk', { direction: 'left' })).toMatchObject({ box: { y: 0, width: 200 } });
  expect(id(call('walk', { direction: 'up' }))).toBe('section');
  expect(call('walk', { direction: 'up' })).toBeNull(); // just under body
  // The outline scrolled out of the page area: the next key starts at the centre again.
  rects.set(document.getElementById('s') as Element, [0, -900, 800, 600]);
  expect(call('walk', { direction: 'left' })).toMatchObject({ box: { y: 0, width: 200 } });
  rects.set(document.getElementById('s') as Element, [0, 0, 800, 600]);
  expect(id(call('walk', { direction: 'up' }))).toBe('section');
  // Enter picks the outline.
  expect(call('pick', { outline: true, pickId: 'g1-p1' })).toMatchObject({
    label: 'section 800×600',
  });
});

it('the keys move on from what the pointer last moved onto, and a still pointer keeps the walked outline', () => {
  page('<ul><li id="one">one</li><li id="two">two</li><li id="three">three</li></ul>', {
    ul: [0, 0, 800, 600],
    '#one': [0, 0, 100, 20],
    '#two': [0, 20, 100, 20],
    '#three': [0, 40, 100, 20],
  });
  atPoint = (_x, y) =>
    y < 20 ? document.getElementById('one') : y < 40 ? document.getElementById('two') : null;
  const at = (target: { box: { y: number } } | null) => target?.box.y;
  call('frame', { pointer: { x: 5, y: 25 }, ids: [] });
  expect(at(call('walk', { direction: 'right' }))).toBe(40);
  // The pointer hasn't left #two: the outline stays where the key put it.
  call('frame', { pointer: { x: 5, y: 26 }, ids: [] });
  expect(at(call('walk', { direction: 'left' }))).toBe(20);
  expect(at(call('walk', { direction: 'left' }))).toBe(0);
  expect(at(call('walk', { direction: 'right' }))).toBe(20);
  // The pointer moves onto another element: the keys go on from there.
  call('frame', { pointer: { x: 5, y: 5 }, ids: [] });
  expect(at(call('walk', { direction: 'right' }))).toBe(20);
  // Onto nothing: no outline anywhere, so the next key starts at the centre (nothing there).
  call('frame', { pointer: { x: 5, y: 500 }, ids: [] });
  expect(call('walk', { direction: 'left' })).toBeNull();
});

it("the style view opens with the pick's values now and :root's colours and lengths from readable sheets, by name", () => {
  page('<p id="p">p</p>', { '#p': [0, 0, 100, 20] });
  atPoint = () => document.getElementById('p');
  call('pick', { x: 1, y: 1, pickId: 'g1-p1' });
  const style = document.createElement('style');
  style.textContent =
    ':root { --space-2: 8px; --brand: #0055ff; --font: Inter } @media (min-width: 1px) { :root { --accent: red } } .x { --not-root: 1px }';
  document.head.append(style);
  const computed = {
    '--space-2': ' 8px',
    '--brand': ' #0055ff',
    '--accent': 'red',
    '--font': ' Inter',
    '--not-root': '1px',
  };
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => computed[name as keyof typeof computed] ?? '',
      }) as CSSStyleDeclaration,
  );
  // A sheet from another origin cannot be read; it is skipped without an error.
  const foreign = {
    get cssRules(): CSSRuleList {
      throw new DOMException('denied', 'SecurityError');
    },
  };
  Object.defineProperty(document, 'styleSheets', {
    configurable: true,
    value: [foreign, style.sheet],
  });
  const inspected = call('inspect', { pickId: 'g1-p1' });
  expect(inspected.tokens).toEqual({
    colors: [
      { name: '--accent', value: 'red' },
      { name: '--brand', value: '#0055ff' },
    ],
    lengths: [{ name: '--space-2', value: '8px' }],
  });
  expect(Object.keys(inspected.styles)).toHaveLength(18);
  expect(call('inspect', { pickId: 'g1-p9' })).toBeNull();
});

it("a preview rule's selector matches the picked element alone; a value the page refuses is invalid", () => {
  page('<ul><li>one</li><li class="two">two</li><li>three</li></ul><ul><li>other</li></ul>', {
    '.two': [0, 20, 100, 20],
  });
  atPoint = () => document.querySelector('.two');
  call('pick', { x: 1, y: 21, pickId: 'g1-p1' });
  const rule = call('rule', { pickId: 'g1-p1', property: 'color', value: 'var(--brand)' });
  const matched = document.querySelectorAll(rule.selector);
  expect(matched).toHaveLength(1);
  expect(matched[0]).toBe(document.querySelector('.two'));
  expect(call('rule', { pickId: 'g1-p1', property: 'color', value: 'not a colour' })).toBe(
    'invalid',
  );
  expect(call('rule', { pickId: 'g1-p9', property: 'color', value: 'red' })).toBeNull();
});

it('only fixed operations run, with plain arguments', () => {
  expect(() => agentScript('eval' as never, {} as never)).toThrow();
  expect(() => agentScript('hover', { x: Number.NaN, y: 1 } as never)).toThrow();
  expect(() => agentScript('hover', { x: '1); alert(1' } as never)).toThrow();
  expect(() => agentScript('pick', { pickId: "x'); alert(1); ('", x: 1, y: 1 } as never)).toThrow();
  expect(() => agentScript('walk', { direction: 'sideways' } as never)).toThrow();
  expect(() =>
    agentScript('rule', { pickId: 'g1-p1', property: 'content', value: 'x' } as never),
  ).toThrow();
  for (const value of [
    'red; } body { display: none',
    'red !important',
    'url("x")',
    '',
    'a'.repeat(201),
  ])
    expect(() => agentScript('rule', { pickId: 'g1-p1', property: 'color', value })).toThrow();
  // Arguments go in as a JSON literal, and only the known ones.
  expect(
    agentScript('frame', { pointer: { x: 1, y: 2 }, ids: ['g1-p1'], code: 'alert(1)' } as never),
  ).toMatch(/\)\("frame",\{"pointer":\{"x":1,"y":2\},"ids":\["g1-p1"\]\}\)$/);
});

it('after the first call a document answers short calls; a new document asks for the agent again', () => {
  const short = (op: string, args: Record<string, unknown> = {}) =>
    // biome-ignore lint/security/noGlobalEval: Execute only our fixed agent script against the test DOM.
    window.eval(agentCall(op as never, args as never));
  expect(short('probe')).toBe(AGENT_MISSING);
  expect(call('probe')).toBe(true);
  expect(short('probe')).toBe(true);
  expect(agentCall('probe', {} as never).length).toBeLessThan(120);
  expect(() => agentCall('pick', { pickId: 'x y', x: 1, y: 1 } as never)).toThrow();
  delete (window as { __corralAnnotateAgent?: unknown }).__corralAnnotateAgent;
  expect(short('probe')).toBe(AGENT_MISSING);
});

it('mode end forgets the outline and keeps the picks; a same-document move forgets both', () => {
  page('<p id="a">a</p>', { '#a': [0, 0, 100, 20] });
  atPoint = () => document.getElementById('a');
  call('pick', { x: 1, y: 1, pickId: 'g1-p1' });
  call('reset');
  expect(call('frame', { pointer: null, ids: ['g1-p1'] }).boxes['g1-p1']).not.toBeNull();
  atPoint = () => null;
  expect(call('walk', { direction: 'up' })).toBeNull(); // the outline went: the centre, nothing there
  call('clear');
  expect(call('frame', { pointer: null, ids: ['g1-p1'] }).boxes['g1-p1']).toBeNull();
});

it('too much to check for fields means no screenshot', () => {
  page('<section id="s">x</section>', { '#s': [0, 0, 100, 100] });
  const many = document.createElement('div');
  many.innerHTML = '<input>'.repeat(5002);
  document.body.append(many);
  atPoint = () => document.getElementById('s');
  expect(call('pick', { x: 1, y: 1, pickId: 'g1-p1' }).screenshotAllowed).toBe(false);
});
