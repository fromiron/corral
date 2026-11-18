// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnnotatePick,
  AnnotateTarget,
  StyleProperty,
} from '../../../desktop/src/annotate-bridge.ts';
import { AnnotateApp } from './AnnotateApp.tsx';
import { createFakeAnnotateBridge, createFrames } from './fakeAnnotateBridge.ts';
import type { AnnotateContext } from './protocol.ts';

// The overlay over the browser tab's page (features/browser-annotate.md): what it draws from main's
// reads and the app page's context, and what it asks main for. The bridge and the animation
// frames are the test's.

let reduced = false;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  reduced = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('data-theme');
});

const context = (change: Partial<AnnotateContext> = {}): AnnotateContext => ({
  locale: 'en',
  theme: { dark: false, tokens: null },
  density: 'default',
  sendKey: 'enter',
  collect: false,
  draft: { textAttachments: 0, images: 0 },
  imagesNow: true,
  markers: [],
  ...change,
});

const pay: AnnotateTarget = {
  label: 'button.pay 120×32',
  name: 'Pay',
  box: { x: 100, y: 200, width: 120, height: 32 },
};

async function mount() {
  const fake = createFakeAnnotateBridge();
  const frames = createFrames();
  let ids = 0;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <AnnotateApp bridge={fake.bridge} frames={frames.frames} newId={() => `note_${++ids}`} />,
    );
  });
  const emit = async (event: Parameters<typeof fake.emit>[0]) => {
    await act(async () => fake.emit(event));
  };
  const start = async (
    change: Partial<AnnotateContext> = {},
    kind: 'page' | 'preview' = 'page',
  ) => {
    await emit({ type: 'page', kind, generation: 1 });
    await emit({ type: 'context', context: context(change) });
  };
  const tick = async () => {
    await act(async () => frames.tick());
  };
  const answer = async (call: { answer(value: unknown): void } | undefined, value: unknown) => {
    if (!call) throw new Error('No call is waiting');
    await act(async () => call.answer(value));
  };
  const surface = () => container.querySelector<HTMLElement>('[data-annotate="surface"]');
  const pointer = async (type: string, x: number, y: number, init: MouseEventInit = {}) => {
    const target = surface();
    if (!target) throw new Error('No surface');
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...init }),
      );
    });
  };
  const key = async (target: Element | null, init: KeyboardEventInit) => {
    if (!target) throw new Error('No key target');
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    });
  };
  const outline = () => container.querySelector<HTMLElement>('[data-annotate="outline"]');
  const tag = () => container.querySelector<HTMLElement>('[data-annotate="tag"]');
  const said = () => container.querySelector('[data-annotate="announcer"]')?.textContent ?? '';
  const note = () => container.querySelector<HTMLElement>('[data-annotate="note"]');
  const textarea = () => note()?.querySelector('textarea') ?? null;
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (each) => (each.getAttribute('aria-label') ?? each.textContent?.trim()) === name,
    ) ?? null;
  const press = async (element: HTMLElement | null) => {
    if (!element) throw new Error('Nothing to press');
    await act(async () => element.click());
  };
  const type = async (text: string) => {
    const area = textarea();
    if (!area) throw new Error('No note');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        area,
        text,
      );
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const open = async (picked: AnnotatePick = notePick(), x = 150, y = 210) => {
    await pointer('click', x, y, { button: 0 });
    await answer(fake.waiting('pick'), { ok: true, pick: picked });
  };
  const told = () => fake.of('tell').map((call) => call.args[0]);
  const submitted = () => fake.of('submit').map((call) => call.args[0]);
  return {
    ...fake,
    frames,
    container,
    emit,
    start,
    tick,
    answer,
    surface,
    pointer,
    key,
    outline,
    tag,
    said,
    note,
    textarea,
    button,
    press,
    type,
    open,
    told,
    submitted,
  };
}

const styles = {} as Record<StyleProperty, string>;
function notePick(change: Partial<AnnotatePick> = {}): AnnotatePick {
  return {
    ...pay,
    pickId: 'pick_1',
    page: { kind: 'page', origin: 'https://shop.example', path: '/cart' },
    element: {
      tag: 'button',
      role: null,
      selector: 'body > main:nth-of-type(1) > button:nth-of-type(1)',
      text: 'Pay',
      bounds: pay.box,
      styles,
    },
    screenshotAllowed: true,
    ...change,
  };
}

describe('그리기 시작', () => {
  it('첫 문맥이 오기 전에는 아무것도 그리지 않고, 먼저 온 page와 focus는 문맥이 오면 쓴다', async () => {
    const view = await mount();
    await view.emit({ type: 'page', kind: 'page', generation: 1 });
    await view.emit({ type: 'focus' });
    // Counterexample: the overlay has no app storage, so it has no language or theme to draw in.
    expect(view.container.innerHTML).toBe('');
    await view.emit({ type: 'context', context: context() });
    expect(view.container.querySelector('[data-annotate="frame"]')).not.toBeNull();
    expect(document.activeElement).toBe(view.surface());
    expect(view.surface()?.getAttribute('aria-label')).toBe('Page');
  });

  it('문맥의 언어로 그린다', async () => {
    const view = await mount();
    await view.start({ locale: 'ko' });
    expect(view.surface()?.getAttribute('aria-label')).toBe('페이지');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('문맥의 모양(어둠, 테마 토큰)을 뿌리에 입히고, 다음 문맥에 없는 토큰은 지운다', async () => {
    const view = await mount();
    await view.start({
      theme: { dark: true, tokens: { '--surface-1': 'rgb(1 2 3)', color: 'red' } },
    });
    const html = document.documentElement;
    expect(html.classList.contains('dark')).toBe(true);
    expect(html.classList.contains('light')).toBe(false);
    expect(html.style.colorScheme).toBe('dark');
    expect(html.style.getPropertyValue('--surface-1')).toBe('rgb(1 2 3)');
    // Counterexample: only custom properties; a token named like a property is not applied.
    expect(html.style.getPropertyValue('color')).toBe('');
    await view.emit({ type: 'context', context: context() });
    expect(html.classList.contains('light')).toBe(true);
    expect(html.style.colorScheme).toBe('light');
    expect(html.style.getPropertyValue('--surface-1')).toBe('');
  });
});

describe('가리키기', () => {
  it('가리킨 요소를 화면 프레임마다 많아야 한 번 읽고, 답이 오기 전에는 다시 읽지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.tick();
    // Nothing to ask: no pointer and nothing tracked.
    expect(view.of('frame')).toHaveLength(0);
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    expect(view.of('frame').map((call) => call.args[0])).toEqual([
      { pointer: { x: 150, y: 210 }, track: [] },
    ]);
    await view.tick();
    // Counterexample: a second read while one is in flight.
    expect(view.of('frame')).toHaveLength(1);
    await view.answer(view.waiting('frame'), { hover: pay, boxes: {} });
    expect(view.tag()?.textContent).toBe('button.pay 120×32');
    expect(view.outline()?.style.transform).toBe('translate(95px, 195px)');
    expect(view.outline()?.style.width).toBe('130px');
    await view.tick();
    expect(view.of('frame')).toHaveLength(2);
  });

  it('답하지 못한 읽기(null)는 테두리를 지우지 않고, 아무것도 가리키지 않는다는 답이 지운다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    await view.answer(view.waiting('frame'), { hover: pay, boxes: {} });
    await view.tick();
    // Counterexample: null is a skipped or timed-out read, not "nothing under the pointer".
    await view.answer(view.waiting('frame'), null);
    expect(view.outline()).not.toBeNull();
    await view.tick();
    await view.answer(view.waiting('frame'), { hover: null, boxes: {} });
    expect(view.outline()).toBeNull();
  });

  it('포인터가 페이지 자리를 떠나면 테두리가 없어지고, 떠나기 전의 늦은 답은 쓰지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    await view.pointer('pointerout', 150, 210, { relatedTarget: null });
    await view.answer(view.waiting('frame'), { hover: pay, boxes: {} });
    expect(view.outline()).toBeNull();
    await view.tick();
    expect(view.of('frame')).toHaveLength(1);
  });

  it('휠은 그 값 그대로 페이지에 넘긴다', async () => {
    const view = await mount();
    await view.start();
    await act(async () => {
      view.surface()?.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          clientX: 40,
          clientY: 60,
          deltaX: 0,
          deltaY: 120,
          deltaMode: 0,
        }),
      );
    });
    expect(view.of('wheel').map((call) => call.args[0])).toEqual([
      { x: 40, y: 60, deltaX: 0, deltaY: 120, deltaMode: 0 },
    ]);
  });

  it('이동하면 테두리가 없어진다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    await view.answer(view.waiting('frame'), { hover: pay, boxes: {} });
    await view.emit({ type: 'navigated', generation: 2 });
    expect(view.outline()).toBeNull();
  });
});

describe('키보드로 옮기기', () => {
  it('방향키는 테두리를 옮기고 이름표와 접근 이름을 알린다', async () => {
    const view = await mount();
    await view.start();
    await view.key(view.surface(), { key: 'ArrowDown' });
    expect(view.of('walk').map((call) => call.args[0])).toEqual(['down']);
    await view.answer(view.waiting('walk'), pay);
    expect(view.tag()?.textContent).toBe('button.pay 120×32');
    expect(view.said()).toBe('button.pay 120×32, Pay');
    await view.key(view.surface(), { key: 'ArrowUp' });
    await view.answer(view.waiting('walk'), null);
    // Nowhere to go: the outline stays where it was.
    expect(view.tag()?.textContent).toBe('button.pay 120×32');
    for (const [key, direction] of [
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
    ] as const) {
      await view.key(view.surface(), { key });
      expect(view.of('walk').at(-1)?.args[0]).toBe(direction);
      await view.answer(view.waiting('walk'), null);
    }
  });

  it('옮긴 뒤에는 포인터가 다시 움직일 때까지 포인터의 자리를 읽지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('pointermove', 150, 210);
    await view.key(view.surface(), { key: 'ArrowDown' });
    await view.answer(view.waiting('walk'), pay);
    await view.tick();
    // Counterexample: the resting pointer's element would replace the walked outline.
    expect(view.of('frame')).toHaveLength(0);
    await view.pointer('pointermove', 152, 210);
    await view.tick();
    expect(view.of('frame').map((call) => call.args[0])).toEqual([
      { pointer: { x: 152, y: 210 }, track: [] },
    ]);
  });

  it('아무것도 열려 있지 않을 때 Escape는 주석 모드를 끈다', async () => {
    const view = await mount();
    await view.start();
    await view.key(view.surface(), { key: 'Escape', isComposing: true });
    expect(view.of('end')).toHaveLength(0);
    await view.key(view.surface(), { key: 'Escape' });
    expect(view.of('end')).toHaveLength(1);
  });
});

describe('번호 표시', () => {
  it('입력창에 있는 주석 칩의 고른 요소를 따라가고, 읽히지 않으며, 없어진 요소에는 없다', async () => {
    const view = await mount();
    await view.start({ markers: [{ pickId: 'pick_1', n: 1 }] });
    await view.tick();
    expect(view.of('frame').map((call) => call.args[0])).toEqual([
      { pointer: null, track: ['pick_1'] },
    ]);
    await view.answer(view.waiting('frame'), {
      hover: null,
      boxes: { pick_1: { x: 100, y: 100, width: 100, height: 40 } },
    });
    const marker = view.container.querySelector<HTMLElement>('[data-annotate="marker"]');
    expect(marker?.textContent).toBe('1');
    expect(marker?.style.transform).toBe('translate(191px, 91px)');
    expect(marker?.closest('[aria-hidden="true"]')).not.toBeNull();
    await view.tick();
    await view.answer(view.waiting('frame'), { hover: null, boxes: { pick_1: null } });
    expect(view.container.querySelector('[data-annotate="marker"]')).toBeNull();
  });

  it('칩이 빠져 번호 표시가 없어지면 그 요소를 놓고, 처음부터 없던 것은 놓지 않는다', async () => {
    const view = await mount();
    await view.start({ markers: [] });
    // Counterexample: a pick whose chip hasn't arrived yet is not one that went.
    expect(view.of('release')).toHaveLength(0);
    await view.emit({
      type: 'context',
      context: context({ markers: [{ pickId: 'pick_1', n: 1 }] }),
    });
    await view.emit({
      type: 'context',
      context: context({
        markers: [
          { pickId: 'pick_1', n: 1 },
          { pickId: 'pick_2', n: 2 },
        ],
      }),
    });
    await view.emit({
      type: 'context',
      context: context({ markers: [{ pickId: 'pick_2', n: 2 }] }),
    });
    expect(view.of('release').map((call) => call.args[0])).toEqual(['pick_1']);
  });
});

describe('페이지가 막을 때', () => {
  it('페이지 자리의 위 끝에 한 줄을 보이고 알리며, 그동안 읽지 않고 가리킴 테두리를 그리지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    await view.answer(view.waiting('frame'), { hover: pay, boxes: {} });
    await view.emit({ type: 'page-busy', busy: true });
    expect(view.container.querySelector('[data-annotate="busy"]')?.textContent).toContain(
      "The page isn't responding",
    );
    expect(view.said()).toBe("The page isn't responding");
    expect(view.outline()).toBeNull();
    await view.tick();
    expect(view.of('frame')).toHaveLength(1);
    await view.emit({ type: 'page-busy', busy: false });
    expect(view.container.querySelector('[data-annotate="busy"]')).toBeNull();
    await view.tick();
    expect(view.of('frame')).toHaveLength(2);
  });
});

describe('페이지가 막을 때의 누름', () => {
  it('답하지 않는 페이지에서 누르거나 고르기가 page-busy로 거절되면 줄로 눈을 끈다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('click', 150, 210, { button: 0 });
    await view.emit({ type: 'page-busy', busy: true });
    const line = () => view.container.querySelector('[data-annotate="busy"] > *');
    expect(line()?.classList.contains('annotate-nudge')).toBe(false);
    await view.answer(view.waiting('pick'), { ok: false, reason: 'page-busy' });
    expect(line()?.classList.contains('annotate-nudge')).toBe(true);
    const first = line();
    await view.pointer('click', 150, 210, { button: 0 });
    // Counterexample: no pick is asked of a page that isn't answering.
    expect(view.of('pick')).toHaveLength(1);
    // A new emphasis each time (the line is drawn again).
    expect(line()).not.toBe(first);
    expect(view.note()).toBeNull();
  });
});

describe('번호 표시와 페이지의 스크롤바', () => {
  it('번호 표시는 페이지의 스크롤 영역 안에, 그 스크롤바에서 비켜 선다', async () => {
    const view = await mount();
    await view.start({ markers: [{ pickId: 'pick_1', n: 1 }] });
    await view.tick();
    await view.answer(view.waiting('frame'), {
      hover: null,
      boxes: { pick_1: { x: 900, y: 100, width: 124, height: 40 } },
      view: { width: 1009, height: 768 },
    });
    // jsdom's page area is 1024 wide; the page's scrollbar takes 15 of it.
    expect(
      view.container.querySelector<HTMLElement>('[data-annotate="marker"]')?.style.transform,
    ).toBe('translate(988px, 91px)');
  });
});

describe('모드가 끝날 때', () => {
  it('테두리의 나가는 움직임이 끝나면 ended를 한 번 부른다', async () => {
    const view = await mount();
    await view.start();
    await view.emit({ type: 'ending' });
    expect(view.of('ended')).toHaveLength(0);
    const frame = view.container.querySelector('[data-annotate="frame"]');
    await act(async () => {
      frame?.dispatchEvent(new Event('animationend', { bubbles: true }));
      frame?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(view.of('ended')).toHaveLength(1);
    // Reading stops once the mode is ending.
    await view.pointer('pointermove', 150, 210);
    await view.tick();
    expect(view.of('frame')).toHaveLength(0);
  });

  it('움직임 줄이기 설정에서는 바로 ended를 부른다', async () => {
    reduced = true;
    const view = await mount();
    await view.start();
    await view.emit({ type: 'ending' });
    expect(view.of('ended')).toHaveLength(1);
  });

  it('문맥이 오기 전에 끝나도 ended를 부른다', async () => {
    const view = await mount();
    await view.emit({ type: 'ending' });
    expect(view.of('ended')).toHaveLength(1);
  });
});

describe('고르기와 주석 칸', () => {
  it('누르면 그 요소를 골라 칸이 그 옆에 열리고, 포커스는 이름 붙은 글 입력에 있다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('click', 150, 210, { button: 0 });
    expect(view.of('pick').map((call) => call.args[0])).toEqual([{ x: 150, y: 210 }]);
    expect(view.note()).toBeNull();
    await view.answer(view.waiting('pick'), { ok: true, pick: notePick() });
    // Right of the element, 12px away.
    expect(view.note()?.style.left).toBe('232px');
    expect(view.note()?.style.width).toBe('320px');
    expect(document.activeElement).toBe(view.textarea());
    expect(view.textarea()?.getAttribute('aria-label')).toBe('Note on button.pay 120×32');
    expect(view.textarea()?.getAttribute('placeholder')).toBe('Write a note');
    expect(view.textarea()?.maxLength).toBe(4000);
    expect(view.button('Include screenshot')?.getAttribute('aria-pressed')).toBe('true');
    // Counterexample: an ordinary page has no console toggle.
    expect(view.button('Include console')).toBeNull();
    expect(view.button('Send')?.disabled).toBe(true);
    await view.type('Make it bigger');
    expect(view.button('Send')?.disabled).toBe(false);
  });

  it('고르는 읽기가 거절되면 칸은 열리지 않고 다시 고를 수 있다', async () => {
    const view = await mount();
    await view.start();
    for (const reason of ['page-changed', 'nothing', 'page-busy']) {
      await view.pointer('click', 150, 210, { button: 0 });
      await view.answer(view.waiting('pick'), { ok: false, reason });
      expect(view.note()).toBeNull();
    }
    expect(view.of('pick')).toHaveLength(3);
  });

  it('고르는 읽기가 오는 동안의 누름은 또 고르지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.pointer('click', 150, 210, { button: 0 });
    await view.pointer('click', 300, 210, { button: 0 });
    expect(view.of('pick')).toHaveLength(1);
  });

  it('빈 칸이 열려 있으면 다른 요소를 누를 때 빈 칸이 닫히고 그 요소의 칸이 열린다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.pointer('click', 600, 400, { button: 0 });
    expect(view.of('release').map((call) => call.args[0])).toEqual(['pick_1']);
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
    await view.answer(view.waiting('pick'), {
      ok: true,
      pick: notePick({ pickId: 'pick_2', label: 'h1.title 300×40' }),
    });
    expect(view.textarea()?.getAttribute('aria-label')).toBe('Note on h1.title 300×40');
  });

  it('쓴 것이 있는 칸이 열려 있으면 다른 요소를 눌러도 아무 일도 없고, 가리킴 테두리도 없다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('버튼을 더 크게');
    await view.pointer('click', 600, 400, { button: 0 });
    expect(view.of('pick')).toHaveLength(1);
    expect(view.textarea()?.value).toBe('버튼을 더 크게');
    expect(document.activeElement).toBe(view.textarea());
    await view.pointer('pointermove', 600, 400);
    await view.tick();
    // The note's element is followed; the pointer is not read.
    expect(view.of('frame').at(-1)?.args[0]).toEqual({ pointer: null, track: ['pick_1'] });
  });

  it('칸은 고른 요소를 따라가고, 그 요소의 테두리가 남는다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.tick();
    expect(view.of('frame').at(-1)?.args[0]).toEqual({
      pointer: { x: 150, y: 210 },
      track: ['pick_1'],
    });
    await view.answer(view.waiting('frame'), {
      hover: null,
      boxes: { pick_1: { x: 100, y: 100, width: 120, height: 32 } },
    });
    expect(view.note()?.style.top).toBe('100px');
    expect(
      view.container.querySelector<HTMLElement>('[data-annotate="picked"]')?.style.transform,
    ).toBe('translate(95px, 95px)');
    await view.tick();
    // Gone from the page: the note keeps its last place.
    await view.answer(view.waiting('frame'), { hover: null, boxes: { pick_1: null } });
    expect(view.note()?.style.top).toBe('100px');
  });

  it('칸이 열려 있지 않을 때 Enter는 테두리의 요소를 고른다', async () => {
    const view = await mount();
    await view.start();
    await view.key(view.surface(), { key: 'ArrowDown' });
    await view.answer(view.waiting('walk'), pay);
    await view.key(view.surface(), { key: 'Enter' });
    expect(view.of('pick').map((call) => call.args[0])).toEqual(['outline']);
    await view.answer(view.waiting('pick'), { ok: true, pick: notePick() });
    expect(document.activeElement).toBe(view.textarea());
    // Counterexample: in the note, the arrows are the text's.
    await view.key(view.textarea(), { key: 'ArrowUp' });
    expect(view.of('walk')).toHaveLength(1);
  });

  it('칸 위의 휠은 페이지에 가지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await act(async () => {
      view.textarea()?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    });
    expect(view.of('wheel')).toHaveLength(0);
  });

  it('쓰는 대로 앱 페이지에 쓴 것이 있는지 알린다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('a');
    await view.type('ab');
    await view.type('');
    expect(
      view.told().filter((message) => (message as { type: string }).type === 'note-written'),
    ).toEqual([
      { type: 'note-written', noteId: 'note_1', written: true },
      { type: 'note-written', noteId: 'note_1', written: false },
    ]);
  });
});

describe('Escape', () => {
  it('칸을 닫아 쓴 것을 버리고 포커스는 페이지 자리로 가며, 다음 Escape가 모드를 끈다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('제목을 굵게');
    await view.key(view.textarea(), { key: 'Escape', isComposing: true });
    // Counterexample: Escape mid-composition is the input method's.
    expect(view.note()).not.toBeNull();
    await view.key(view.textarea(), { key: 'Escape' });
    expect(view.note()).toBeNull();
    expect(view.of('release').map((call) => call.args[0])).toEqual(['pick_1']);
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
    expect(view.of('end')).toHaveLength(0);
    expect(document.activeElement).toBe(view.surface());
    await view.key(view.surface(), { key: 'Escape' });
    expect(view.of('end')).toHaveLength(1);
  });
});

describe('바로 보내기', () => {
  it('보내기 키는 주석을 한 번만 보내고, 받아들여지면 보냄 표시로 바뀌어 알린다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.key(view.textarea(), { key: 'Enter', isComposing: true });
    // Counterexample: Enter mid-composition only ends the composition.
    expect(view.submitted()).toHaveLength(0);
    await view.key(view.textarea(), { key: 'Enter' });
    await view.key(view.textarea(), { key: 'Enter' });
    await view.press(view.button('Send'));
    expect(view.submitted()).toEqual([
      {
        noteId: 'note_1',
        pickId: 'pick_1',
        intent: 'send',
        text: 'Make it bigger',
        styles: [],
        screenshot: true,
        console: false,
        extra: { via: 'send', again: false },
      },
    ]);
    expect(view.textarea()?.readOnly).toBe(true);
    // Escape while sending does nothing.
    await view.key(view.textarea(), { key: 'Escape' });
    expect(view.note()).not.toBeNull();
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'accepted' },
    });
    expect(view.note()).toBeNull();
    expect(view.container.querySelector('[data-annotate="sent"]')?.textContent).toContain('Sent');
    expect(view.said()).toBe('Note sent');
    expect(view.of('release').map((call) => call.args[0])).toEqual(['pick_1']);
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
    expect(document.activeElement).toBe(view.surface());
    await view.pointer('pointerdown', 10, 10, { button: 0 });
    expect(view.container.querySelector('[data-annotate="sent"]')).toBeNull();
  });

  it('보내기 키 설정을 따르고, 끼어들기로 보낼 때는 스크린샷을 찍지 않는다', async () => {
    const view = await mount();
    await view.start({ sendKey: 'mod-enter' });
    await view.open();
    await view.type('간격을 줄여 주세요');
    await view.key(view.textarea(), { key: 'Enter' });
    expect(view.submitted()).toHaveLength(0);
    await view.key(view.textarea(), { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(view.submitted()).toMatchObject([
      { screenshot: false, extra: { via: 'interrupt', again: false } },
    ]);
  });

  it('보내기는 글이 있어야 하고, 칸의 글이 요청의 글이다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('   ');
    await view.key(view.textarea(), { key: 'Enter' });
    expect(view.submitted()).toHaveLength(0);
    expect(view.button('Send')?.disabled).toBe(true);
  });

  it('거절되면 칸은 글을 둔 채 열려 있고 그 까닭을 보이며, 다시 보내면 새 명령이다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'refused', reason: 'This conversation can’t take a request now.' },
    });
    expect(view.textarea()?.value).toBe('Make it bigger');
    expect(view.textarea()?.readOnly).toBe(false);
    expect(view.note()?.textContent).toContain('This conversation can’t take a request now.');
    await view.press(view.button('Send'));
    expect(view.submitted().at(-1)).toMatchObject({
      noteId: 'note_1',
      extra: { via: 'button', again: false },
    });
  });

  it('응답을 잃으면 글을 고칠 수 없고, 다시 보내기는 같은 주석으로 다시 보낸다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'unconfirmed' },
    });
    expect(view.textarea()?.readOnly).toBe(true);
    expect(view.note()?.textContent).toContain(
      'The answer was lost on the way, so it is not known whether the request arrived.',
    );
    // Counterexample: never sent again by itself.
    expect(view.submitted()).toHaveLength(1);
    await view.press(view.button('Send again'));
    expect(view.submitted().at(-1)).toMatchObject({
      noteId: 'note_1',
      text: 'Make it bigger',
      extra: { via: 'button', again: true },
    });
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'accepted' },
    });
    expect(view.said()).toBe('Note sent');
  });

  it('응답을 잃은 칸의 Escape는 다시 보내지 않고 닫는다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'unconfirmed' },
    });
    await view.key(view.textarea(), { key: 'Escape' });
    expect(view.note()).toBeNull();
    expect(view.submitted()).toHaveLength(1);
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
  });

  it('페이지에서 보내지 못하면 글을 둔 채 칸 아래에 그 까닭을 보인다', async () => {
    const reasons = {
      'page-changed': 'The page changed',
      'not-visible': "The element isn't on screen",
      'input-fields': "Screens with input fields aren't captured",
      'image-limit': 'The screenshot is over 2,048px or 1 MiB',
      'page-busy': "The page isn't responding",
    };
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    for (const [kind, sentence] of Object.entries(reasons)) {
      await view.press(view.button('Send'));
      await view.answer(view.waiting('submit'), { kind });
      expect(view.note()?.querySelector('[data-annotate="failure"]')?.textContent).toBe(sentence);
      expect(view.textarea()?.value).toBe('Make it bigger');
    }
  });
});

describe('스크린샷과 콘솔', () => {
  it('입력 칸이 든 요소는 스크린샷 토글이 꺼진 채 쓸 수 없고 그 옆에 까닭이 있다', async () => {
    const view = await mount();
    await view.start();
    await view.open(notePick({ screenshotAllowed: false }));
    const toggle = view.button('Include screenshot');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle?.disabled).toBe(true);
    const reason = document.getElementById(toggle?.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe("Screens with input fields aren't captured");
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    expect(view.submitted()[0]).toMatchObject({ screenshot: false });
  });

  it('지금 보내면 합류나 끼어들기가 되면 스크린샷은 새 요청에만 적용된다', async () => {
    const view = await mount();
    await view.start({ imagesNow: false });
    await view.open();
    const toggle = view.button('Include screenshot');
    expect(toggle?.disabled).toBe(true);
    expect(
      document.getElementById(toggle?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Applies to a new request only');
  });

  it('토글을 끄면 스크린샷 없이 보낸다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.press(view.button('Include screenshot'));
    expect(view.button('Include screenshot')?.getAttribute('aria-pressed')).toBe('false');
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    expect(view.submitted()[0]).toMatchObject({ screenshot: false });
  });

  it('미리보기 페이지에서만 콘솔 토글이 있고, 열릴 때 꺼져 있다', async () => {
    const view = await mount();
    await view.start({}, 'preview');
    await view.open(
      notePick({ page: { kind: 'preview', origin: 'http://127.0.0.1:5173', path: '/' } }),
    );
    const toggle = view.button('Include console');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    await view.press(toggle);
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    expect(view.submitted()[0]).toMatchObject({ console: true, screenshot: true });
  });
});

describe('보내는 것 팝오버', () => {
  // The kit's popups go to the end of the page, outside the overlay's container.
  const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
  const row = (term: string) =>
    [...(popup()?.querySelectorAll('dt') ?? [])].find((dt) => dt.textContent === term)
      ?.nextElementSibling?.textContent ?? null;
  const labelButton = (view: Awaited<ReturnType<typeof mount>>) =>
    [...(view.note()?.querySelectorAll('button') ?? [])].find(
      (each) => each.textContent?.trim() === 'button.pay 120×32',
    ) ?? null;

  it('이름표 버튼이 이 주석이 보낼 것을 보이고, 스크린샷 자리에는 토글의 상태가 있다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    const label = labelButton(view);
    expect(label).not.toBeNull();
    await view.press(label);
    expect(popup()?.getAttribute('aria-label')).toBe('What goes with this note');
    expect(row('Page')).toBe('https://shop.example/cart');
    expect(row('Element')).toBe('button.pay 120×32');
    expect(row('Selector')).toBe('body > main:nth-of-type(1) > button:nth-of-type(1)');
    expect(row('Text')).toBe('Pay');
    expect(popup()?.textContent).toContain('Screenshot included');
    // Counterexample: an ordinary page carries no console, so none is read for it.
    expect(row('Console')).toBeNull();
    expect(view.of('consoleFor')).toHaveLength(0);
  });

  it('스크린샷 토글이 꺼져 있거나 쓸 수 없으면 스크린샷 없음이다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.press(view.button('Include screenshot'));
    await view.press(labelButton(view));
    expect(popup()?.textContent).toContain('No screenshot');
  });

  it('입력 칸이 든 요소는 스크린샷 없음이다', async () => {
    const view = await mount();
    await view.start();
    await view.open(notePick({ screenshotAllowed: false }));
    await view.press(labelButton(view));
    expect(popup()?.textContent).toContain('No screenshot');
  });

  it('콘솔은 콘솔 토글이 켜져 있을 때만, 보낼 때와 같은 것을 읽어 보인다', async () => {
    const view = await mount();
    await view.start({}, 'preview');
    await view.open(
      notePick({ page: { kind: 'preview', origin: 'http://127.0.0.1:5173', path: '/' } }),
    );
    await view.press(labelButton(view));
    // The toggle starts off: nothing is read, nothing is shown.
    expect(view.of('consoleFor')).toHaveLength(0);
    expect(row('Console')).toBeNull();
    await view.key(popup(), { key: 'Escape' });
    await view.press(view.button('Include console'));
    await view.press(labelButton(view));
    expect(view.of('consoleFor').map((call) => call.args[0])).toEqual(['pick_1']);
    await view.answer(view.waiting('consoleFor'), [
      { level: 'error', message: 'Uncaught TypeError: x is undefined' },
    ]);
    expect(row('Console')).toContain('Uncaught TypeError: x is undefined');
  });

  it('팝오버 안의 Escape는 팝오버만 닫고 칸은 그대로다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.press(labelButton(view));
    expect(popup()).not.toBeNull();
    await view.key(popup(), { key: 'Escape' });
    expect(view.note()).not.toBeNull();
    expect(view.textarea()?.value).toBe('Make it bigger');
    expect(view.of('release')).toHaveLength(0);
    expect(labelButton(view)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('팝오버가 열려 있을 때 페이지 자리를 누르면 팝오버만 닫힌다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.press(labelButton(view));
    expect(popup()).not.toBeNull();
    await view.pointer('pointerdown', 600, 400, { button: 0 });
    await view.pointer('mousedown', 600, 400, { button: 0 });
    await view.pointer('pointerup', 600, 400, { button: 0 });
    await view.pointer('mouseup', 600, 400, { button: 0 });
    await view.pointer('click', 600, 400, { button: 0 });
    expect(labelButton(view)?.getAttribute('aria-expanded')).toBe('false');
    // Counterexample: the empty note stays and nothing else is picked.
    expect(view.of('pick')).toHaveLength(1);
    expect(view.note()).not.toBeNull();
    expect(view.of('release')).toHaveLength(0);
    // The next press is the page area's again.
    await view.pointer('pointerdown', 600, 400, { button: 0 });
    await view.pointer('click', 600, 400, { button: 0 });
    expect(view.of('pick')).toHaveLength(2);
  });

  it('팝오버에 포커스가 있을 때 이동으로 칸이 닫히면 포커스는 페이지 자리로 간다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.press(labelButton(view));
    popup()?.focus();
    expect(popup()?.contains(document.activeElement)).toBe(true);
    await view.emit({ type: 'navigated', generation: 2 });
    expect(view.note()).toBeNull();
    expect(document.activeElement).toBe(view.surface());
  });

  it('칸 안의 Tab 순서는 이름표 버튼, 글, 스크린샷 토글, 모아 두기, 보내기다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    const order = [
      ...(view.note()?.querySelectorAll<HTMLElement>('button, textarea, [role="switch"]') ?? []),
    ]
      .filter((each) => each.tabIndex >= 0)
      .map(
        (each) =>
          each.getAttribute('aria-label') ??
          document.getElementById(each.getAttribute('aria-labelledby') ?? '')?.textContent ??
          each.textContent?.trim(),
      );
    expect(order).toEqual([
      'button.pay 120×32',
      'Note on button.pay 120×32',
      'Include screenshot',
      'Collect',
      'Send',
    ]);
  });
});

describe('모아 두기', () => {
  it('켜져 있으면 담기가 주석을 담고, 칸이 닫혀 알리며, 그 요소는 놓지 않는다', async () => {
    const view = await mount();
    await view.start({ collect: true });
    await view.open();
    expect(view.button('Add')?.disabled).toBe(true);
    await view.type('Make it bigger');
    await view.key(view.textarea(), { key: 'Enter' });
    expect(view.submitted()).toMatchObject([{ intent: 'add', extra: { via: 'send' } }]);
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'added', n: 2 },
    });
    expect(view.note()).toBeNull();
    expect(view.said()).toBe('Added note 2');
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
    // Its marker and kept previews need it.
    expect(view.of('release')).toHaveLength(0);
    expect(document.activeElement).toBe(view.surface());
  });

  it('모아 두기를 바꾸면 버튼이 바로 바뀌고 앱 페이지에 알린다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    expect(view.button('Send')).not.toBeNull();
    const toggle = view.container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await view.press(toggle);
    expect(view.told()).toContainEqual({ type: 'collect', on: true });
    expect(view.button('Add')).not.toBeNull();
  });

  it('담는 중의 Escape는 담기를 취소하고, 칸은 글을 둔 채 열려 있으며 늦은 결과는 쓰지 않는다', async () => {
    const view = await mount();
    await view.start({ collect: true });
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Add'));
    const pending = view.waiting('submit');
    await view.key(view.textarea(), { key: 'Escape' });
    expect(view.of('cancelSubmit').map((call) => call.args[0])).toEqual(['note_1']);
    expect(view.note()?.querySelector('[data-annotate="failure"]')?.textContent).toBe(
      "Couldn't add the note",
    );
    expect(view.textarea()?.value).toBe('Make it bigger');
    await view.answer(pending, { kind: 'answered', outcome: { kind: 'added', n: 1 } });
    expect(view.note()).not.toBeNull();
    expect(view.said()).not.toBe('Added note 1');
  });

  it('담지 못하면 칸은 열린 채 그 까닭을 보인다', async () => {
    const view = await mount();
    await view.start({ collect: true });
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Add'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'not-added', reason: null },
    });
    expect(view.note()?.querySelector('[data-annotate="failure"]')?.textContent).toBe(
      "Couldn't add the note",
    );
    await view.press(view.button('Add'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'not-added', reason: 'The screenshot couldn’t be uploaded.' },
    });
    expect(view.note()?.querySelector('[data-annotate="failure"]')?.textContent).toBe(
      'The screenshot couldn’t be uploaded.',
    );
  });

  it('입력창의 한도를 넘지 않는다', async () => {
    const view = await mount();
    await view.start({ collect: true, draft: { textAttachments: 5, images: 3 } });
    await view.open();
    await view.type('Make it bigger');
    expect(view.button('Add')?.disabled).toBe(true);
    expect(view.note()?.textContent).toContain('A request holds up to 5 attachments');
    const toggle = view.button('Include screenshot');
    expect(toggle?.disabled).toBe(true);
    expect(
      document.getElementById(toggle?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('A request holds up to 3 images');
  });
});

describe('이동하면 칸이 닫힌다', () => {
  it('쓴 것이 있던 칸은 버렸다고 알리고, 빈 칸은 알리지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('제목을 굵게');
    await view.emit({ type: 'navigated', generation: 2 });
    expect(view.note()).toBeNull();
    expect(view.said()).toBe('Discarded the note you were writing');
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
    expect(view.submitted()).toHaveLength(0);
    await view.open(notePick({ pickId: 'pick_2' }));
    await view.emit({ type: 'navigated', generation: 3 });
    expect(view.note()).toBeNull();
    expect(view.said()).toBe('Discarded the note you were writing');
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_2' });
  });

  it('보내는 중에 닫힌 칸은 그 결과를 알린다', async () => {
    const view = await mount();
    await view.start();
    for (const [outcome, sentence] of [
      [{ kind: 'accepted' }, 'Note sent'],
      [{ kind: 'refused', reason: 'Nope.' }, "Couldn't send the note. Nope."],
      [{ kind: 'unconfirmed' }, "Couldn't confirm the note arrived. Check the conversation."],
    ] as const) {
      await view.open();
      await view.type('Make it bigger');
      await view.press(view.button('Send'));
      const pending = view.waiting('submit');
      await view.emit({ type: 'navigated', generation: 2 });
      expect(view.note()).toBeNull();
      await view.answer(pending, { kind: 'answered', outcome });
      expect(view.said()).toBe(sentence);
    }
  });

  it('응답을 잃은 칸이 닫히면 확인하지 못했다고 알리고 다시 보내지 않는다', async () => {
    const view = await mount();
    await view.start();
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Send'));
    await view.answer(view.waiting('submit'), {
      kind: 'answered',
      outcome: { kind: 'unconfirmed' },
    });
    await view.emit({ type: 'navigated', generation: 2 });
    expect(view.said()).toBe("Couldn't confirm the note arrived. Check the conversation.");
    expect(view.submitted()).toHaveLength(1);
    expect(view.told()).toContainEqual({ type: 'note-closed', noteId: 'note_1' });
  });

  it('담는 중에 닫힌 칸은 담기를 취소한다', async () => {
    const view = await mount();
    await view.start({ collect: true });
    await view.open();
    await view.type('Make it bigger');
    await view.press(view.button('Add'));
    await view.emit({ type: 'navigated', generation: 2 });
    expect(view.of('cancelSubmit').map((call) => call.args[0])).toEqual(['note_1']);
    expect(view.said()).toBe('Discarded the note you were writing');
  });
});
