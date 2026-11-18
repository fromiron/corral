// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { AnnotateContext } from '../annotate/protocol.ts';
import {
  createFakeBrowserBridge,
  type FakeBrowserBridge,
} from '../workbench/browser/fakeBrowserBridge.ts';
import { panelMemoryKey, serializePanelMemory } from '../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../workbench/panel/tabs.ts';
import {
  createShellWorld,
  mountShell,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// The app page's side of browser annotation (features/browser-annotate.md 켜고 끄기, 계약): the
// head's 주석 button and its shortcut, and the overlay's context, over a fake of the desktop's
// bridge. The overlay itself is the desktop's view; what is checked is what the app page asks of
// the bridge and what it says.

vi.setConfig({ testTimeout: 20_000 });

const B = messages.Browser;
const COLLECT_KEY = 'corral:annotate-collect';
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
  // The desktop app's shortcuts: the annotation key has no binding in a browser.
  vi.stubGlobal('corralDesktop', {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function world(bridge: FakeBrowserBridge) {
  const made = await createShellWorld({ server: true, folder: true });
  made.services.browser = bridge;
  return made;
}
function remember(sessionId: string, tabs: PanelTab[], selected: TabKey | null) {
  window.localStorage.setItem(
    panelMemoryKey(sessionId),
    serializePanelMemory({ tabs, selected, open: true }),
  );
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}
async function livePage(bridge: FakeBrowserBridge, id = 'b_one') {
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: id, at: { origin: 'https://a.example', path: '/' } }],
    `browser:${id}`,
  );
  const shell = await mountShell(at, [`/sessions/${at.sessionId}`], { width: WIDE });
  cleanups.push(() => shell.unmount());
  await until(() => bridge.stateOf(id)?.loading === false);
  await settle();
  return { at, shell };
}
const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
const annotateButton = () =>
  [...(side()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.getAttribute('aria-label') === B.annotate,
  ) ?? null;
const addressField = () =>
  side()?.querySelector<HTMLInputElement>('input[data-browser-address]') ?? null;
const announced = () =>
  [...document.querySelectorAll<HTMLElement>('[data-browser-announcer]')]
    .map((region) => region.textContent ?? '')
    .join('');
async function press(target: Element | null, init: KeyboardEventInit) {
  await act(async () => {
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}
// jsdom is not a Mac: Mod is Ctrl.
const modShiftD = { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true };
const contexts = (bridge: FakeBrowserBridge) =>
  bridge.callsTo('annotateContext') as [string, AnnotateContext][];

it('주석 버튼은 주소 입력란과 ⋯ 사이에 있고, 페이지가 없는 탭에서는 쓸 수 없다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(at.sessionId, [{ kind: 'browser', browserId: 'b_new' }], 'browser:b_new');
  const shell = await mountShell(at, [`/sessions/${at.sessionId}`], { width: WIDE });
  cleanups.push(() => shell.unmount());
  await until(() => Boolean(annotateButton()));

  const head = annotateButton()?.closest('[data-browser-tab]');
  const order = [...(head?.querySelectorAll<HTMLElement>('input, button') ?? [])].map((item) =>
    item.getAttribute('aria-label'),
  );
  expect(order.slice(-3)).toEqual([B.address, B.annotate, B.more]);
  expect(annotateButton()?.disabled).toBe(true);
});

it('살아 있는 페이지에서 주석 버튼을 누른다 → 주석 모드가 켜져 버튼이 눌린 상태이고, 다시 누르면 꺼진다; 버튼으로는 알리지 않는다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  expect(annotateButton()?.disabled).toBe(false);
  expect(annotateButton()?.getAttribute('aria-pressed')).toBe('false');

  await act(async () => annotateButton()?.click());
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'true');
  expect(bridge.callsTo('annotate')).toEqual([['b_one', true]]);

  await act(async () => annotateButton()?.click());
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'false');
  expect(bridge.callsTo('annotate')).toEqual([
    ['b_one', true],
    ['b_one', false],
  ]);
  expect(announced()).toBe('');
});

it('머리(주소 입력란)에서 Mod+Shift+D → 주석 모드가 켜지고 "Annotate on"을 알리며, 다시 누르면 "Annotate off"', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => addressField()?.focus());
  await press(addressField(), modShiftD);
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'true');
  expect(announced()).toBe(B.annotateOn);

  await press(addressField(), modShiftD);
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'false');
  expect(announced()).toBe(B.annotateOff);
});

it('포커스가 브라우저 탭 밖(입력창)에 있으면 Mod+Shift+D는 주석 모드를 켜지 않는다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  const composer = document.querySelector<HTMLTextAreaElement>('textarea');
  await act(async () => composer?.focus());
  await press(composer, modShiftD);
  await settle();
  expect(bridge.callsTo('annotate')).toEqual([]);
});

it('페이지에서 Mod+Shift+D(데스크톱이 앱에 넘긴 단축키) → 그 탭의 주석 모드가 켜지고 알린다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'shortcut', tabId: 'b_one', id: 'browser.annotate' }));
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'true');
  expect(bridge.callsTo('annotate')).toEqual([['b_one', true]]);
  expect(announced()).toBe(B.annotateOn);
});

it('데스크톱이 주석 모드를 끝낸다(annotate off) → 버튼은 눌리지 않은 상태로 돌아온다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => annotateButton()?.click());
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'true');
  await act(async () => bridge.emit({ type: 'annotate', tabId: 'b_one', on: false }));
  await until(() => annotateButton()?.getAttribute('aria-pressed') === 'false');
  expect(annotateButton()?.getAttribute('aria-pressed')).toBe('false');
});

it('주석 모드가 켜지면 덧뷰에 맥락을 통째로 보낸다: 언어, 모양, 밀도, 보내기 키, 모아 두기, 초안의 한도, 지금 이미지가 실리는지, 번호 표시', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => annotateButton()?.click());
  await until(() => contexts(bridge).length > 0);

  const [tabId, context] = contexts(bridge).at(-1) ?? [];
  expect(tabId).toBe('b_one');
  expect(context).toEqual({
    locale: 'en',
    theme: { dark: false, tokens: null },
    density: 'default',
    sendKey: 'enter',
    collect: false,
    draft: { textAttachments: 0, images: 0 },
    imagesNow: true,
    markers: [],
  });
});

it('덧뷰가 모아 두기를 켠다 → 이 기기에 기억하고 새 맥락을 보낸다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => annotateButton()?.click());
  await until(() => contexts(bridge).length > 0);
  const before = contexts(bridge).length;

  await act(async () =>
    bridge.emit({
      type: 'annotate-message',
      tabId: 'b_one',
      message: { type: 'collect', on: true },
    }),
  );
  await until(() => contexts(bridge).length > before);
  expect(contexts(bridge).at(-1)?.[1].collect).toBe(true);
  expect(window.localStorage.getItem(COLLECT_KEY)).toBe('true');
});

it('이 기기에 모아 두기가 켜져 있다 → 주석 모드의 첫 맥락부터 모아 두기가 켜져 있다', async () => {
  window.localStorage.setItem(COLLECT_KEY, 'true');
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => annotateButton()?.click());
  await until(() => contexts(bridge).length > 0);
  expect(contexts(bridge)[0]?.[1].collect).toBe(true);
});

it('다른 대화의 탭의 주석 사건과 알 수 없는 덧뷰 메시지는 이 대화의 맥락을 바꾸지 않는다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => annotateButton()?.click());
  await until(() => contexts(bridge).length > 0);
  const before = contexts(bridge).length;

  await act(async () => {
    bridge.emit({
      type: 'annotate-message',
      tabId: 'b_elsewhere',
      message: { type: 'collect', on: true },
    });
    bridge.emit({ type: 'annotate-message', tabId: 'b_one', message: { type: 'collect' } });
    bridge.emit({ type: 'annotate-message', tabId: 'b_one', message: 'collect' });
  });
  await settle();
  expect(contexts(bridge).length).toBe(before);
});
