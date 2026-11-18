// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotateTarget } from '../../../desktop/src/annotate-bridge.ts';
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
  const start = async (change: Partial<AnnotateContext> = {}) => {
    await emit({ type: 'page', kind: 'page', generation: 1 });
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
