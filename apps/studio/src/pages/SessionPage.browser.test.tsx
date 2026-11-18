// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { effectiveShortcuts } from '../shortcuts.ts';
import {
  createFakeBrowserBridge,
  type FakeBrowserBridge,
} from '../workbench/browser/fakeBrowserBridge.ts';
import { holdPages } from '../workbench/browser/overlap.ts';
import {
  panelMemoryKey,
  parsePanelMemory,
  serializePanelMemory,
} from '../workbench/panel/memory.ts';
import type { PanelTab, TabKey } from '../workbench/panel/tabs.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  NARROW,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// The session panel's browser tab on the whole app (features/browser-tab.md 여는 곳, 머리,
// 닫기와 떠나기, 새 창과 팝업, 계약), over a fake of the desktop's bridge: the page itself is the
// desktop's, so what is checked here is what the studio asks of the bridge and what it draws.

vi.setConfig({ testTimeout: 20_000 });

const W = {
  add: messages.SessionPanel.add,
  browser: messages.Docking.browser,
  address: messages.Browser.address,
  onlyWeb: messages.Browser.onlyWeb,
  tabs: messages.SessionPanel.tabs,
  close: (name: string) => messages.SessionPanel.close.replace('{name}', name),
};

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  cleanups.push(stubBrowser());
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function world(bridge: FakeBrowserBridge | null = createFakeBrowserBridge()) {
  const made = await createShellWorld({ server: true, folder: true });
  made.services.browser = bridge;
  return made;
}
async function open(at: ShellWorld, address: string) {
  const shell = await mountShell(at, [address], { width: WIDE });
  cleanups.push(() => shell.unmount());
  return shell;
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
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;

const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
function tabs(): HTMLElement[] {
  const strip = side()?.querySelector(`[role="tablist"][aria-label="${W.tabs}"]`);
  return [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
}
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const tabNames = () => tabs().map(tabName);
const selectedName = () => {
  const tab = tabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const addressField = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[data-browser-address]')].find(
    (input) => !input.closest('[hidden]'),
  ) ?? null;
const browserId = (shell: MountedShell) => String(search(shell).browser ?? '');

async function plusBrowser() {
  const plus = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === W.add,
  );
  await act(async () => plus?.click());
  await settle();
  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    // The kit draws a row's label twice, once hidden to reserve its width.
    (item) => item.textContent?.trim() === W.browser.repeat(2),
  );
  expect(row).toBeTruthy();
  await act(async () => row?.click());
  await settle();
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form?.requestSubmit();
  });
  await settle();
}

it('"+"에서 브라우저를 고른다 → 오른쪽 끝에 "브라우저" 탭이 열려 선택되고, 포커스는 주소 입력란에 있고, 주소는 panel=browser&browser=…이다', async () => {
  const at = await world();
  remember(at.sessionId, [{ kind: 'files' }], 'files');
  const shell = await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 1);
  await plusBrowser();
  await until(() => document.activeElement === addressField());

  expect(tabNames()).toEqual([messages.Docking.files, W.browser]);
  expect(selectedName()).toBe(W.browser);
  expect(document.activeElement).toBe(addressField());
  expect(search(shell).panel).toBe('browser');
  expect(browserId(shell)).toMatch(/^[A-Za-z0-9_-]+$/);
});

it('새 브라우저 탭에 "example.com/docs?token=abc"를 넣고 Enter를 누른다 → 그 주소가 프로젝트 저장소에 열리고 탭 이름은 페이지 제목이며, 앱 주소와 패널 기억에는 페이지 주소의 쿼리가 없다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  const shell = await open(at, `/sessions/${at.sessionId}?panel=browser`);
  await until(() => Boolean(addressField()) && Boolean(browserId(shell)));
  const id = browserId(shell);

  const field = addressField();
  if (!field) throw new Error('no address field');
  await type(field, 'example.com/docs?token=abc');
  await until(() => selectedName() === 'example.com');

  expect(bridge.callsTo('navigate')).toEqual([[id, at.projectId, 'example.com/docs?token=abc']]);
  expect(selectedName()).toBe('example.com');
  expect(JSON.stringify(search(shell))).not.toContain('token');
  const raw = window.localStorage.getItem(panelMemoryKey(at.sessionId)) ?? '';
  expect(raw).not.toContain('token');
  expect(parsePanelMemory(raw)?.tabs).toEqual([
    { kind: 'browser', browserId: id, at: { origin: 'https://example.com', path: '/docs' } },
  ]);
});

it('새 브라우저 탭에 "file:///etc/hosts"를 넣고 Enter를 누른다 → 아무것도 열리지 않고 입력란 아래에 "http나 https 주소만 열 수 있습니다"가 보인다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  await open(at, `/sessions/${at.sessionId}?panel=browser`);
  await until(() => Boolean(addressField()));
  const field = addressField();
  if (!field) throw new Error('no address field');
  await type(field, 'file:///etc/hosts');
  const alert = () => side()?.querySelector('[role="alert"]')?.textContent ?? null;
  await until(() => Boolean(alert()));

  expect(alert()).toBe(W.onlyWeb);
  expect(selectedName()).toBe(W.browser);
});

it('대화의 기억에 https://example.com/docs의 일반 페이지 탭과 파일 탭이 있고 파일 탭이 선택돼 있다 → 대화를 연다 → 페이지를 불러오지 않는다 → 그 탭을 고른다 → https://example.com/docs를 불러온다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  const page: PanelTab = {
    kind: 'browser',
    browserId: 'b_one',
    at: { origin: 'https://example.com', path: '/docs' },
  };
  remember(at.sessionId, [{ kind: 'files' }, page], 'files');
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length === 2);
  await settle();

  expect(tabNames()).toEqual([messages.Docking.files, 'example.com']);
  expect(bridge.callsTo('navigate')).toEqual([]);
  const tab = tabs()[1];
  await act(async () => tab?.click());
  await until(() => bridge.callsTo('navigate').length > 0);
  expect(bridge.callsTo('navigate')).toEqual([['b_one', at.projectId, 'https://example.com/docs']]);
});

it('일반 페이지 탭을 닫는다 → 그 페이지를 닫는다; 대화를 떠나면 페이지를 내리기만 한다 (반례: 떠나기는 닫기가 아니다)', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  const pages: PanelTab[] = [
    { kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } },
    { kind: 'browser', browserId: 'b_two', at: { origin: 'https://b.example', path: '/' } },
  ];
  remember(at.sessionId, pages, 'browser:b_one');
  const shell = await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.callsTo('navigate').length === 1);
  await act(async () => tabs()[1]?.click());
  await until(() => bridge.callsTo('navigate').length === 2);

  const close = side()?.querySelectorAll<HTMLElement>('[data-slot="tabs-closable-close"]')[0];
  await act(async () => close?.click());
  await until(() => bridge.callsTo('close').length === 1);
  expect(bridge.callsTo('close')).toEqual([['b_one']]);

  const other = await createShellWorld({ server: true, folder: true });
  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: other.sessionId },
    });
  });
  await until(() => bridge.callsTo('unload').length === 1);
  expect(bridge.callsTo('unload')).toEqual([['b_two']]);
  expect(bridge.callsTo('close')).toEqual([['b_one']]);
});

it('일반 페이지가 새 창을 연다 → 탭 줄의 오른쪽 끝에 새 브라우저 탭이 열려 선택되고, 그 창이 닫히면 탭이 닫히되 페이지를 다시 닫지 않는다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [
      { kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } },
      { kind: 'files' },
    ],
    'browser:b_one',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.callsTo('navigate').length === 1);

  await act(async () => {
    bridge.emit({ type: 'popup', tabId: 'b_pop', openerTabId: 'b_one', projectId: at.projectId });
  });
  await settle();
  expect(tabNames()).toEqual(['a.example', messages.Docking.files, W.browser]);
  expect(selectedName()).toBe(W.browser);

  await act(async () => bridge.emit({ type: 'popup-closed', tabId: 'b_pop' }));
  await settle();
  expect(tabNames()).toEqual(['a.example', messages.Docking.files]);
  expect(bridge.callsTo('close')).toEqual([]);
});

it('페이지의 메뉴에서 "새 탭에서 링크 열기"를 고른다 → 그 탭 바로 오른쪽에 새 탭이 열리고 그 주소를 같은 프로젝트 저장소에 연다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [
      { kind: 'browser', browserId: 'b_one', at: { origin: 'https://shop.example', path: '/' } },
      { kind: 'files' },
    ],
    'browser:b_one',
  );
  const shell = await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.callsTo('navigate').length === 1);

  await act(async () =>
    bridge.emit({
      type: 'open-link',
      tabId: 'b_one',
      projectId: at.projectId,
      url: 'https://shop.example/help',
    }),
  );
  await until(() => tabNames().length === 3 && selectedName() === 'shop.example');

  const id = browserId(shell);
  expect(id).not.toBe('b_one');
  expect(bridge.callsTo('navigate').at(-1)).toEqual([
    id,
    at.projectId,
    'https://shop.example/help',
  ]);
  expect(tabNames()).toEqual(['shop.example', 'shop.example', messages.Docking.files]);
});

it('페이지에서 Shift+Escape를 누른다 → 포커스는 그 탭의 주소 입력란에 있다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } }],
    'browser:b_one',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => Boolean(addressField()));

  await act(async () => bridge.emit({ type: 'leave', tabId: 'b_one' }));
  await settle();
  expect(document.activeElement).toBe(addressField());
});

it('살아 있는 페이지의 탭이 보이는 동안 그 자리를 알리고, 다른 탭을 고르면 뷰를 숨긴다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [
      { kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } },
      { kind: 'files' },
    ],
    'browser:b_one',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.callsTo('place').some(([id, rect]) => id === 'b_one' && rect !== null));
  expect(bridge.callsTo('place').some(([id, rect]) => id === 'b_one' && rect !== null)).toBe(true);

  await act(async () => tabs()[1]?.click());
  await settle();
  expect(bridge.callsTo('place').at(-1)).toEqual(['b_one', null]);
});

it('웹 모드(데스크톱의 브라우저가 없음)에서는 "+" 목록에 브라우저가 없고 기억한 브라우저 탭도 되살리지 않는다 (반례)', async () => {
  const at = await world(null);
  remember(
    at.sessionId,
    [
      { kind: 'files' },
      { kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } },
    ],
    'files',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => tabNames().length >= 1);
  await settle();
  expect(tabNames()).toEqual([messages.Docking.files]);

  const plus = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === W.add,
  );
  await act(async () => plus?.click());
  await settle();
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows).not.toContain(W.browser.repeat(2));
});

// --- names and bodies of pages that could not open (탭의 이름과 표시, 불러오기와 오류) --------

/** A remembered page tab, selected, its page loaded and live. */
async function livePage(bridge: FakeBrowserBridge, id = 'b_one', origin = 'https://a.example') {
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: id, at: { origin, path: '/' } }, { kind: 'files' }],
    `browser:${id}`,
  );
  const shell = await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.stateOf(id)?.loading === false);
  await settle();
  return { at, shell };
}
const place = () => side()?.querySelector<HTMLElement>('[data-slot="browser-page"]') ?? null;
const buttonNamed = (name: string) =>
  [...(side()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  ) ?? null;

it('제목이 example.com인 페이지에서 https://localhost:8443/로 가다 열지 못한다 → 탭 이름은 실패한 주소의 호스트 localhost:8443이다 (반례: 앞 페이지의 제목이 남지 않는다)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge, 'b_one', 'https://example.com');
  expect(selectedName()).toBe('example.com');

  await act(async () =>
    bridge.setState('b_one', {
      page: 'failed',
      url: 'https://localhost:8443/',
      loading: false,
      failure: { kind: 'connection-refused', code: -102, certificate: null },
    }),
  );
  await settle();
  expect(bridge.stateOf('b_one')?.title).toBe('example.com');
  expect(selectedName()).toBe('localhost:8443');
});

it('열지 못한 페이지의 자리는 한 줄 까닭과 "다시 시도", "시스템 브라우저에서 열기"이고 테두리 상자(빈 목록의 표시)가 아니다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () =>
    bridge.setState('b_one', {
      page: 'failed',
      failure: { kind: 'connection-refused', code: -102, certificate: null },
    }),
  );
  await settle();

  expect(place()?.querySelector('[data-slot="empty-state"]')).toBeNull();
  expect(place()?.querySelector('p')?.textContent).toBe(messages.Browser.failure.connectionRefused);
  expect(buttonNamed(messages.Browser.tryAgain)).not.toBeNull();
  expect(buttonNamed(messages.Browser.openSystem)).not.toBeNull();
});

it('공개 주소의 인증서 오류(challengeId 없음) → 까닭과 "돌아가기", "시스템 브라우저에서 열기"가 보이고 "그래도 열기"는 없다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () =>
    bridge.setState('b_one', {
      page: 'failed',
      url: 'https://expired.example/',
      failure: {
        kind: 'certificate',
        code: -201,
        certificate: { reason: 'expired', challengeId: null },
      },
    }),
  );
  await settle();

  expect(place()?.querySelector('[data-slot="empty-state"]')).toBeNull();
  expect(place()?.textContent).toContain(messages.Browser.certificate.title);
  expect(place()?.textContent).toContain(messages.Browser.certificate.expired);
  expect(buttonNamed(messages.Browser.goBack)).not.toBeNull();
  expect(buttonNamed(messages.Browser.openSystem)).not.toBeNull();
  expect(buttonNamed(messages.Browser.openAnyway)).toBeNull();
});

it('localhost의 인증서 오류에서 "그래도 열기"를 누르는데 그 오류가 더는 지금 것이 아니다(false) → 본문은 그대로이고 다음 상태를 기다린다', async () => {
  const bridge = createFakeBrowserBridge();
  bridge.proceedCertificate = async (...args) => {
    bridge.calls.push(['proceedCertificate', ...args]);
    return false;
  };
  await livePage(bridge);
  await act(async () =>
    bridge.setState('b_one', {
      page: 'failed',
      url: 'https://localhost:8443/',
      failure: {
        kind: 'certificate',
        code: -202,
        certificate: { reason: 'self-signed', challengeId: 'c_1' },
      },
    }),
  );
  await settle();
  await act(async () => buttonNamed(messages.Browser.openAnyway)?.click());
  await settle();

  expect(bridge.callsTo('proceedCertificate')).toEqual([['b_one', 'c_1']]);
  expect(place()?.textContent).toContain(messages.Browser.certificate.title);
  expect(buttonNamed(messages.Browser.openAnyway)).not.toBeNull();
});

const certificateStop = (url: string) => ({
  page: 'failed' as const,
  url,
  loading: false,
  failure: {
    kind: 'certificate' as const,
    code: -201,
    certificate: { reason: 'expired' as const, challengeId: null },
  },
});

it('인증서 오류의 "돌아가기" → 탭 안의 기록이 있으면 그 앞 페이지로 간다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () =>
    bridge.setState('b_one', { ...certificateStop('https://expired.example/'), canGoBack: true }),
  );
  await settle();
  await act(async () => buttonNamed(messages.Browser.goBack)?.click());
  await settle();
  expect(bridge.callsTo('back')).toEqual([['b_one']]);
  expect(bridge.callsTo('reset')).toEqual([]);
});

it('기록이 없는 일반 탭에서 인증서 오류의 "돌아가기" → 탭은 새 탭의 상태("브라우저")로 돌아가고, 주소 입력란이 실패한 주소를 모두 고른 채 포커스를 갖는다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.setState('b_one', certificateStop('https://expired.example/')));
  await settle();
  expect(bridge.stateOf('b_one')?.canGoBack).toBe(false);
  await act(async () => buttonNamed(messages.Browser.goBack)?.click());
  await until(() => document.activeElement === addressField());

  expect(bridge.callsTo('back')).toEqual([]);
  expect(bridge.callsTo('reset')).toEqual([['b_one']]);
  expect(selectedName()).toBe(W.browser);
  const field = addressField();
  expect(document.activeElement).toBe(field);
  expect(field?.value).toBe('https://expired.example/');
  expect([field?.selectionStart, field?.selectionEnd]).toEqual([0, field?.value.length]);
  expect(place()?.textContent).toBe('');
});

it('기록이 없는 미리보기 탭의 인증서 오류에는 "돌아가기"가 없다 (반례: 미리보기 탭은 빈 탭이 되지 않는다)', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: 'b_pre', lease: 'lease_1' }],
    'browser:b_pre',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.stateOf('b_pre')?.loading === false);
  await act(async () =>
    bridge.setState('b_pre', certificateStop('http://127.0.0.2:4100/lease_1/')),
  );
  await settle();
  expect(place()?.textContent).toContain(messages.Browser.certificate.title);
  expect(buttonNamed(messages.Browser.goBack)).toBeNull();
});

// --- keys and focus (포커스와 키보드) -----------------------------------------------------------

async function keydown(target: Element | null, init: KeyboardEventInit) {
  let delivered = true;
  await act(async () => {
    delivered = Boolean(
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      ),
    );
  });
  await settle();
  return { prevented: !delivered };
}
const more = () => buttonNamed(messages.Browser.more);
const dialog = () => document.querySelector('[role="dialog"]');

it('앱의 단축키는 거르지 않은 effectiveShortcuts()로 데스크톱에 알린다: 주소 입력란에 포커스가 있어도 같다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await until(() => bridge.callsTo('setShortcuts').length > 0);
  expect(bridge.callsTo('setShortcuts').at(-1)).toEqual([effectiveShortcuts()]);

  await act(async () => addressField()?.focus());
  await settle();
  expect(bridge.callsTo('setShortcuts').at(-1)).toEqual([effectiveShortcuts()]);
});

it('페이지에서 명령 팔레트의 단축키를 누른다 → 팔레트가 뜨고, Escape로 닫으면 포커스는 그 페이지로 돌아간다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'shortcut', tabId: 'b_one', id: 'palette' }));
  await until(() => Boolean(dialog()));
  expect(dialog()).not.toBeNull();
  expect(bridge.callsTo('focus')).toEqual([]);

  await keydown(document.activeElement, { key: 'Escape' });
  await until(() => bridge.callsTo('focus').length > 0);
  expect(dialog()).toBeNull();
  expect(bridge.callsTo('focus')).toEqual([['b_one']]);
});

it('페이지에서 사이드바 여닫기 단축키를 누른다 → 사이드바가 바뀌고 포커스는 그 페이지로 돌아간다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'shortcut', tabId: 'b_one', id: 'view.sidebar' }));
  await until(() => bridge.callsTo('focus').length > 0);
  expect(bridge.callsTo('focus')).toEqual([['b_one']]);
});

it('페이지에서 패널 여닫기 단축키를 누른다 → 패널이 닫히고 포커스를 페이지에 돌려주지 않는다 (반례: 화면에 없는 페이지)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'shortcut', tabId: 'b_one', id: 'view.panel' }));
  await settle();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(
    document.querySelector('[data-slot="side-panel-frame"]')?.getAttribute('data-presentation'),
  ).toBe('closed');
  expect(bridge.callsTo('place').at(-1)).toEqual(['b_one', null]);
  expect(bridge.callsTo('focus')).toEqual([]);
});

it('주소 입력란에서 Mod+R → 그 페이지를 다시 불러오고 앱은 다시 불러오지 않는다; 확대 키는 그 페이지를 확대한다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  const field = addressField();

  expect((await keydown(field, { key: 'r', ctrlKey: true })).prevented).toBe(true);
  expect(bridge.callsTo('reload')).toEqual([['b_one']]);
  expect((await keydown(field, { key: '=', ctrlKey: true })).prevented).toBe(true);
  expect((await keydown(field, { key: '+', ctrlKey: true, shiftKey: true })).prevented).toBe(true);
  expect((await keydown(more(), { key: '-', ctrlKey: true })).prevented).toBe(true);
  expect((await keydown(more(), { key: '0', ctrlKey: true })).prevented).toBe(true);
  expect(bridge.callsTo('zoom')).toEqual([
    ['b_one', 'in'],
    ['b_one', 'in'],
    ['b_one', 'out'],
    ['b_one', 'reset'],
  ]);
});

it('페이지가 없는 새 탭에서 Mod+R과 확대 키 → 아무 일도 하지 않고 앱도 다시 불러오지 않는다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  await open(at, `/sessions/${at.sessionId}?panel=browser`);
  await until(() => Boolean(addressField()));

  expect((await keydown(addressField(), { key: 'r', ctrlKey: true })).prevented).toBe(true);
  expect((await keydown(addressField(), { key: '=', ctrlKey: true })).prevented).toBe(true);
  expect(bridge.callsTo('reload')).toEqual([]);
  expect(bridge.callsTo('zoom')).toEqual([]);
});

it('⋯에서 Tab을 누른다 → 포커스가 페이지로 들어간다; Shift+Tab은 머리 안에 머문다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);

  expect((await keydown(more(), { key: 'Tab', shiftKey: true })).prevented).toBe(false);
  expect(bridge.callsTo('focus')).toEqual([]);
  expect((await keydown(more(), { key: 'Tab' })).prevented).toBe(true);
  expect(bridge.callsTo('focus')).toEqual([['b_one']]);
});

it('일반 페이지가 연 새 창의 탭이 선택된다 → 포커스는 그 페이지로 간다', async () => {
  const bridge = createFakeBrowserBridge();
  const { at } = await livePage(bridge);
  await act(async () => {
    bridge.emit({ type: 'popup', tabId: 'b_pop', openerTabId: 'b_one', projectId: at.projectId });
    bridge.setState('b_pop', { page: 'live', url: 'https://a.example/login' });
  });
  await until(() => bridge.callsTo('focus').length > 0);
  expect(bridge.callsTo('focus')).toEqual([['b_pop']]);
});

it('서랍에 브라우저 탭이 떠 있다 → 페이지에서 Shift+Escape 뒤 Escape → 서랍이 닫힌다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: 'b_one', at: { origin: 'https://a.example', path: '/' } }],
    'browser:b_one',
  );
  const shell = await mountShell(at, [`/sessions/${at.sessionId}?panel=browser&browser=b_one`], {
    width: NARROW,
  });
  cleanups.push(() => shell.unmount());
  const presentation = () =>
    document.querySelector('[data-slot="side-panel-frame"]')?.getAttribute('data-presentation');
  await until(() => Boolean(presentation()));
  const toggle = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
    (button) => button.getAttribute('aria-label') === messages.SessionPanel.toggle,
  );
  await act(async () => toggle?.click());
  await until(() => presentation() === 'drawer' && Boolean(addressField()));
  expect(presentation()).toBe('drawer');

  await act(async () => bridge.emit({ type: 'leave', tabId: 'b_one' }));
  await settle();
  expect(document.activeElement).toBe(addressField());
  await keydown(document.activeElement, { key: 'Escape' });
  expect(presentation()).toBe('closed');
});

// --- the app over the page (앱 화면과 겹칠 때) -----------------------------------------------

const PLACE = { left: 600, top: 100, width: 600, height: 700 };
/** Boxes as a browser would give them: the page's place, and popups over it (or far from it). */
function layOut(popups: 'over' | 'far' = 'over') {
  const original = Element.prototype.getBoundingClientRect;
  const box = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    }) as DOMRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches('[data-slot="browser-page"]'))
      return box(PLACE.left, PLACE.top, PLACE.width, PLACE.height);
    // Tooltips stand beside their control, here off the page; menus and dialogs lie over it.
    const tooltip = this.closest('[role="tooltip"]') || this.querySelector('[role="tooltip"]');
    if (this.closest('[data-base-ui-portal]'))
      return popups === 'over' && !tooltip ? box(900, 80, 240, 200) : box(0, 0, 120, 30);
    return original.call(this);
  };
  cleanups.push(() => {
    Element.prototype.getBoundingClientRect = original;
  });
}
const STILL = {
  stillId: 's_1',
  dataUrl: 'data:image/png;base64,AAAA',
  width: 1200,
  height: 1400,
  overlay: null,
};
const picture = () => place()?.querySelector('img[data-slot="browser-still"]') ?? null;
const browserBody = () => side()?.querySelector('[data-slot="browser-tab"]') ?? null;
async function openMore() {
  const trigger = more();
  await act(async () => trigger?.click());
  await settle();
}
const menuOpen = () => Boolean(document.querySelector('[role="menu"]'));
async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

it('살아 있는 페이지 위로 ⋯ 메뉴를 연다 → 페이지 자리는 그 순간의 그림이고(그림을 칠한 뒤 뷰를 숨긴다), Escape로 닫으면 살아 있는 뷰가 돌아오고 그림은 버린다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  await openMore();
  await until(() => bridge.callsTo('freeze').length > 0);

  expect(menuOpen()).toBe(true);
  expect(bridge.callsTo('still')).toEqual([['b_one']]);
  expect(bridge.callsTo('freeze')).toEqual([['b_one', 's_1']]);
  expect(picture()?.getAttribute('src')).toBe(STILL.dataUrl);
  expect(picture()?.getAttribute('aria-hidden')).toBe('true');

  await keydown(document.activeElement, { key: 'Escape' });
  await until(() => bridge.callsTo('thaw').length > 0 && !picture());
  expect(menuOpen()).toBe(false);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
  expect(picture()).toBeNull();
  expect(browserBody()?.hasAttribute('data-page-still')).toBe(false);
});

it('데스크톱이 그림을 주지 못한다(still이 null) → 살아 있는 뷰를 그대로 두고 숨기지도 되돌리지도 않는다 (반례)', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = null;
  await livePage(bridge);
  await openMore();
  await until(() => bridge.callsTo('still').length > 0);
  await wait(50);
  expect(bridge.callsTo('freeze')).toEqual([]);
  expect(picture()).toBeNull();

  await keydown(document.activeElement, { key: 'Escape' });
  await wait(50);
  expect(bridge.callsTo('thaw')).toEqual([]);
});

it('그림이 오기 전에 메뉴가 닫힌다 → 뷰를 숨기지 않고 그림도 깔지 않는다 (반례: 늦은 답)', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  let answer: (still: typeof STILL) => void = () => {};
  bridge.still = async (...args) => {
    bridge.calls.push(['still', ...args]);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  await livePage(bridge);
  await openMore();
  await until(() => bridge.callsTo('still').length > 0);
  await keydown(document.activeElement, { key: 'Escape' });
  await until(() => !menuOpen());

  await act(async () => answer(STILL));
  await wait(80);
  expect(bridge.callsTo('freeze')).toEqual([]);
  expect(bridge.callsTo('thaw')).toEqual([]);
  expect(picture()).toBeNull();
});

it('더 새 걸음이 이겨 freeze가 false다 → 그림을 걷고 뷰는 살아 있으며 되돌릴 것도 없다 (반례)', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  bridge.freezeAnswer = false;
  await livePage(bridge);
  await openMore();
  await until(() => bridge.callsTo('freeze').length > 0);
  await wait(30);
  expect(picture()).toBeNull();

  await keydown(document.activeElement, { key: 'Escape' });
  await wait(50);
  expect(bridge.callsTo('thaw')).toEqual([]);
});

it('페이지 자리와 겹치지 않는 팝업(사이드바의 툴팁 같은) → 그림으로 바꾸지 않는다 (반례)', async () => {
  layOut('far');
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  await openMore();
  await wait(80);
  expect(menuOpen()).toBe(true);
  expect(bridge.callsTo('still')).toEqual([]);
});

it('분할선을 끌어 패널 폭을 바꾼다 → 끄는 동안 페이지 자리는 그림이고, 놓으면 살아 있는 뷰가 돌아온다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  const splitter = document.querySelector('[data-slot="side-panel-frame"] [data-slot="splitter"]');
  expect(splitter).not.toBeNull();
  const at = (x: number) => ({
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: 300,
  });
  await act(async () => {
    splitter?.dispatchEvent(new PointerEvent('pointerdown', at(600)));
    splitter?.dispatchEvent(new PointerEvent('pointermove', at(560)));
  });
  await until(() => bridge.callsTo('freeze').length > 0);
  expect(bridge.callsTo('freeze')).toEqual([['b_one', 's_1']]);

  await act(async () => {
    splitter?.dispatchEvent(new PointerEvent('pointerup', at(560)));
  });
  await until(() => bridge.callsTo('thaw').length > 0);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
});

it('탭 줄의 탭을 끄는 동안 → 페이지 자리는 그림이고, 놓으면 살아 있는 뷰가 돌아온다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  const tab = tabs()[1];
  const at = (x: number) => ({
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: 50,
  });
  await act(async () => {
    tab?.dispatchEvent(new PointerEvent('pointerdown', at(700)));
    tab?.dispatchEvent(new PointerEvent('pointermove', at(640)));
  });
  await until(() => bridge.callsTo('freeze').length > 0);
  expect(bridge.callsTo('freeze')).toEqual([['b_one', 's_1']]);

  await act(async () => {
    tab?.dispatchEvent(new PointerEvent('pointerup', at(640)));
  });
  await until(() => bridge.callsTo('thaw').length > 0);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
});

it('창의 크기가 바뀐다 → 그동안 페이지 자리는 그림이고, 자리가 멈추면 살아 있는 뷰가 돌아온다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
  await until(() => bridge.callsTo('freeze').length > 0);
  expect(bridge.callsTo('freeze')).toEqual([['b_one', 's_1']]);
  await until(() => bridge.callsTo('thaw').length > 0, 2000);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
});

it('페이지에서 연 명령 팔레트가 페이지를 덮는다 → 그림으로 바뀌고, 닫으면 뷰를 되돌린 뒤에 포커스를 페이지에 준다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'shortcut', tabId: 'b_one', id: 'palette' }));
  await until(() => bridge.callsTo('freeze').length > 0);
  expect(dialog()).not.toBeNull();

  await keydown(document.activeElement, { key: 'Escape' });
  await until(() => bridge.callsTo('focus').length > 0);
  const order = bridge.calls.map(([name]) => name).filter((name) => /^(thaw|focus)$/.test(name));
  expect(order).toEqual(['thaw', 'focus']);
});

it('그림으로 바뀐 채 다른 탭을 고른다 → 뷰를 되돌려 둔다 (반례: 숨긴 채 남지 않는다)', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  bridge.stillAnswer = STILL;
  await livePage(bridge);
  const release = holdPages();
  cleanups.push(release);
  await until(() => bridge.callsTo('freeze').length > 0);

  await act(async () => tabs()[1]?.click());
  await until(() => bridge.callsTo('thaw').length > 0);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
});

it('주석 모드의 덧뷰가 있는 페이지 위로 ⋯ 메뉴를 연다 → 페이지의 그림 위에 덧뷰의 그림을 겹쳐 깔고, 뷰를 되돌린 뒤 둘 다 버린다', async () => {
  layOut();
  const bridge = createFakeBrowserBridge();
  const overlay = { dataUrl: 'data:image/png;base64,BBBB', width: 1200, height: 1400 };
  bridge.stillAnswer = { ...STILL, overlay };
  await livePage(bridge);
  await openMore();
  await until(() => bridge.callsTo('freeze').length > 0);

  const pictures = () =>
    [...(place()?.querySelectorAll<HTMLImageElement>('img[data-slot^="browser-still"]') ?? [])].map(
      (image) => [image.dataset.slot, image.getAttribute('src'), image.getAttribute('aria-hidden')],
    );
  // In this order, the overlay's last: it lies over the page's.
  expect(pictures()).toEqual([
    ['browser-still', STILL.dataUrl, 'true'],
    ['browser-still-overlay', overlay.dataUrl, 'true'],
  ]);
  expect(bridge.callsTo('freeze')).toEqual([['b_one', 's_1']]);

  await keydown(document.activeElement, { key: 'Escape' });
  await until(() => bridge.callsTo('thaw').length > 0 && pictures().length === 0);
  expect(bridge.callsTo('thaw')).toEqual([['b_one']]);
  expect(pictures()).toEqual([]);
});

// --- lines under the head: permissions, downloads; under the page: a preview's blocked move ---

const B = messages.Browser;
const lineText = (selector: string) =>
  [...(side()?.querySelectorAll<HTMLElement>(selector) ?? [])].map((line) =>
    (line.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
const asks = () => lineText('[data-browser-line="permission"]');
const downloadLines = () => lineText('[data-browser-line="download"]');
const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

it('일반 페이지가 카메라를 요청한다 → 머리 아래 한 줄이 "meet.example wants to use camera"와 허용 · 거부를 보이고 포커스를 가져가지 않으며, 허용은 그 요청에 답하고 끝나면 줄이 사라진다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge, 'b_one', 'https://meet.example');
  await act(async () => addressField()?.focus());
  await act(async () =>
    bridge.emit({
      type: 'permission',
      tabId: 'b_one',
      requestId: 'r_1',
      origin: 'https://meet.example',
      permissions: ['camera'],
    }),
  );
  await settle();

  expect(asks()).toHaveLength(1);
  expect(asks()[0]).toContain(
    fill(B.permissionAsk, { site: 'meet.example', permissions: B.permission.camera }),
  );
  expect(document.activeElement).toBe(addressField());
  // The line lies above the page's place, so the page moves down rather than under it.
  const line = side()?.querySelector('[data-browser-line="permission"]');
  expect(
    line && place()
      ? line.compareDocumentPosition(place() as Node) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0,
  ).toBeTruthy();

  // 허용 · 거부, the same weight, so what the screen shows first the focus reaches first.
  const answers = [...(line?.querySelectorAll('button') ?? [])];
  expect(answers.map((button) => button.textContent?.trim())).toEqual([B.allow, B.deny]);
  expect(answers[0]?.className).toBe(answers[1]?.className);

  await act(async () => buttonNamed(B.allow)?.click());
  await settle();
  expect(bridge.callsTo('answerPermission')).toEqual([['b_one', 'r_1', true]]);
  await act(async () =>
    bridge.emit({ type: 'permission-ended', tabId: 'b_one', requestId: 'r_1' }),
  );
  await settle();
  expect(asks()).toEqual([]);
});

it('카메라와 마이크를 함께 요청하고, 같은 요청이 마이크만 남겨 다시 온다 → 한 줄이 둘을, 다음엔 마이크만 이름 대고 거부는 false로 답한다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge, 'b_one', 'https://meet.example');
  const ask = (permissions: ('camera' | 'microphone')[]) =>
    act(async () =>
      bridge.emit({
        type: 'permission',
        tabId: 'b_one',
        requestId: 'r_2',
        origin: 'https://meet.example',
        permissions,
      }),
    );
  await ask(['camera', 'microphone']);
  await settle();
  expect(asks()).toHaveLength(1);
  expect(asks()[0]).toContain(
    fill(B.permissionAsk, {
      site: 'meet.example',
      permissions: `${B.permission.camera} and ${B.permission.microphone}`,
    }),
  );

  await ask(['microphone']);
  await settle();
  expect(asks()).toHaveLength(1);
  expect(asks()[0]).toContain(
    fill(B.permissionAsk, { site: 'meet.example', permissions: B.permission.microphone }),
  );
  await act(async () => buttonNamed(B.deny)?.click());
  await settle();
  expect(bridge.callsTo('answerPermission')).toEqual([['b_one', 'r_2', false]]);
});

it('다른 대화의 탭이 권한을 요청한다 → 이 대화에는 줄이 없다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () =>
    bridge.emit({
      type: 'permission',
      tabId: 'b_elsewhere',
      requestId: 'r_3',
      origin: 'https://meet.example',
      permissions: ['camera'],
    }),
  );
  await settle();
  expect(asks()).toEqual([]);
});

const download = (
  patch: Partial<import('../../../desktop/src/browser-bridge.ts').BrowserDownload>,
) => ({
  downloadId: 'd_1',
  tabId: 'b_one',
  name: 'report.pdf',
  state: 'progressing' as const,
  receivedBytes: 40,
  totalBytes: 100,
  ...patch,
});

it('내려받기 → "{이름} 내려받는 중 · 40%"와 취소, 끝나면 "{이름}을 내려받았습니다"와 폴더에서 보기가 다음 페이지 이동까지 남는다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit({ type: 'download', download: download({}) }));
  await settle();
  expect(downloadLines()).toHaveLength(1);
  expect(downloadLines()[0]).toContain(fill(B.downloading, { name: 'report.pdf', percent: '40' }));
  await act(async () => buttonNamed(B.cancel)?.click());
  await settle();
  expect(bridge.callsTo('cancelDownload')).toEqual([['d_1']]);

  await act(async () =>
    bridge.emit({
      type: 'download',
      download: download({ state: 'completed', receivedBytes: 100 }),
    }),
  );
  await settle();
  expect(downloadLines()[0]).toContain(fill(B.downloaded, { name: 'report.pdf' }));
  await act(async () => buttonNamed(B.showInFolder)?.click());
  await settle();
  expect(bridge.callsTo('showDownload')).toEqual([['d_1']]);

  // A reload of the same page is not a move to the next page: the line stays.
  await act(async () => bridge.setState('b_one', { loading: true }));
  await act(async () => bridge.setState('b_one', { loading: false }));
  await settle();
  expect(downloadLines()).toHaveLength(1);
  await act(async () => bridge.setState('b_one', { url: 'https://a.example/next' }));
  await settle();
  expect(downloadLines()).toEqual([]);
});

it('중단된 내려받기 → "{이름} 내려받기가 중단되었습니다"이고 다시 이어지면 진행 줄로 돌아간다; 취소된 것은 줄이 없다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () =>
    bridge.emit({ type: 'download', download: download({ state: 'interrupted' }) }),
  );
  await settle();
  expect(downloadLines()[0]).toContain(fill(B.downloadInterrupted, { name: 'report.pdf' }));

  await act(async () =>
    bridge.emit({ type: 'download', download: download({ receivedBytes: 70 }) }),
  );
  await settle();
  expect(downloadLines()[0]).toContain(fill(B.downloading, { name: 'report.pdf', percent: '70' }));

  await act(async () =>
    bridge.emit({ type: 'download', download: download({ state: 'cancelled' }) }),
  );
  await settle();
  expect(downloadLines()).toEqual([]);
});

it('줄이 없는 내려받기(그 탭이 없음)나 다른 대화의 탭의 내려받기 → 이 탭에 줄이 없다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => {
    bridge.emit({ type: 'download', download: download({ downloadId: 'd_2', tabId: null }) });
    bridge.emit({
      type: 'download',
      download: download({ downloadId: 'd_3', tabId: 'b_elsewhere' }),
    });
  });
  await settle();
  expect(downloadLines()).toEqual([]);
});

it('대화를 떠났다 돌아와 그 탭을 고른다 → 이어지던 내려받기의 줄이 그대로 있다', async () => {
  const bridge = createFakeBrowserBridge();
  bridge.downloads = async (...args) => {
    bridge.calls.push(['downloads', ...args]);
    return [download({ receivedBytes: 55 })];
  };
  await livePage(bridge);
  await until(() => downloadLines().length > 0);
  expect(bridge.callsTo('downloads')).toEqual([['b_one']]);
  expect(downloadLines()[0]).toContain(fill(B.downloading, { name: 'report.pdf', percent: '55' }));
});

it('미리보기 페이지가 lease 밖으로 가려다 막혔다 → 페이지 자리 아래 한 줄 "미리보기 밖으로 가는 이동을 막았습니다"와 시스템 브라우저에서 열기; http(s)가 아닌 주소면 버튼이 없다', async () => {
  const bridge = createFakeBrowserBridge();
  const at = await world(bridge);
  remember(
    at.sessionId,
    [{ kind: 'browser', browserId: 'b_pre', lease: 'lease_1' }],
    'browser:b_pre',
  );
  await open(at, `/sessions/${at.sessionId}`);
  await until(() => bridge.stateOf('b_pre')?.loading === false);

  await act(async () => bridge.setState('b_pre', { blocked: { url: 'https://cdn.example/a' } }));
  await settle();
  const line = () => side()?.querySelector<HTMLElement>('[data-browser-line="blocked"]') ?? null;
  expect(line()?.textContent).toContain(B.blockedMove);
  expect(
    place() && line()
      ? (place() as Node).compareDocumentPosition(line() as Node) & Node.DOCUMENT_POSITION_FOLLOWING
      : 0,
  ).toBeTruthy();
  await act(async () => buttonNamed(B.openSystem)?.click());
  await settle();
  expect(bridge.callsTo('openBlocked')).toEqual([['b_pre']]);

  await act(async () => bridge.setState('b_pre', { blocked: { url: null } }));
  await settle();
  expect(line()?.textContent).toContain(B.blockedMove);
  expect(line()?.querySelector('button')).toBeNull();
  await act(async () => bridge.setState('b_pre', { blocked: null }));
  await settle();
  expect(line()).toBeNull();
});

const buttonIn = (root: Element | null, name: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent?.trim() === name,
  ) ?? null;

// --- HTTP sign-in (불러오기와 오류: HTTP 인증) -------------------------------------------------

const loginDialog = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes(fill(B.signInTitle, { origin: 'https://auth.example' })),
  ) ?? null;
const fieldNamed = (name: string) =>
  [...(loginDialog()?.querySelectorAll<HTMLInputElement>('input') ?? [])].find(
    (input) =>
      // The kit draws a field's label twice, once hidden to hold its width.
      [...(input.labels ?? [])].some((label) => label.textContent?.trim() === name.repeat(2)) ||
      input.getAttribute('aria-label') === name,
  ) ?? null;

async function typeInto(input: HTMLInputElement | null, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const login = (tabId = 'b_one', requestId = 'l_1') => ({
  type: 'login' as const,
  tabId,
  requestId,
  origin: 'https://auth.example',
});

it('사이트가 HTTP 인증을 요구한다 → "Sign in to {origin}" 대화상자가 사용자 이름에 포커스를 두고 뜨고, 로그인은 친 이름과 비밀번호로 답하며 아무 데도 남기지 않는다', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge, 'b_one', 'https://auth.example');
  await act(async () => bridge.emit(login()));
  await until(() => Boolean(loginDialog()) && document.activeElement === fieldNamed(B.userName));

  expect(document.activeElement).toBe(fieldNamed(B.userName));
  expect(fieldNamed(B.password)?.type).toBe('password');
  const buttons = [...(loginDialog()?.querySelectorAll('button') ?? [])].map((b) =>
    b.textContent?.trim(),
  );
  expect(buttons.indexOf(B.cancel)).toBeLessThan(buttons.indexOf(B.signIn));

  await typeInto(fieldNamed(B.userName), 'ada');
  await typeInto(fieldNamed(B.password), 'hunter2');
  await act(async () => fieldNamed(B.password)?.form?.requestSubmit());
  await settle();
  expect(bridge.callsTo('answerLogin')).toEqual([
    ['b_one', 'l_1', { username: 'ada', password: 'hunter2' }],
  ]);
  expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
    'hunter2',
  );
  await act(async () => bridge.emit({ type: 'login-ended', tabId: 'b_one', requestId: 'l_1' }));
  await until(() => !loginDialog());
  expect(loginDialog()).toBeNull();
});

it('로그인 대화상자에서 취소하거나 Escape를 누른다 → null로 답한다(사이트의 401 페이지가 보인다)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge, 'b_one', 'https://auth.example');
  await act(async () => bridge.emit(login('b_one', 'l_1')));
  await until(() => Boolean(loginDialog()));
  await act(async () => buttonIn(loginDialog(), B.cancel)?.click());
  await settle();
  expect(bridge.callsTo('answerLogin')).toEqual([['b_one', 'l_1', null]]);
  await act(async () => bridge.emit({ type: 'login-ended', tabId: 'b_one', requestId: 'l_1' }));
  await until(() => !loginDialog());

  await act(async () => bridge.emit(login('b_one', 'l_2')));
  await until(() => document.activeElement === fieldNamed(B.userName));
  await keydown(document.activeElement, { key: 'Escape' });
  await settle();
  expect(bridge.callsTo('answerLogin').at(-1)).toEqual(['b_one', 'l_2', null]);
});

it('다른 대화의 탭이 HTTP 인증을 요구한다 → 이 대화에는 대화상자가 뜨지 않는다 (반례)', async () => {
  const bridge = createFakeBrowserBridge();
  await livePage(bridge);
  await act(async () => bridge.emit(login('b_elsewhere')));
  await settle();
  expect(loginDialog()).toBeNull();
});
