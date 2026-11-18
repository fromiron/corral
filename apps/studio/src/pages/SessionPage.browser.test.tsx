// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { effectiveShortcuts } from '../shortcuts.ts';
import {
  createFakeBrowserBridge,
  type FakeBrowserBridge,
} from '../workbench/browser/fakeBrowserBridge.ts';
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
