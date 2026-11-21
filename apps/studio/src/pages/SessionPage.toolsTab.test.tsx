// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { panelMemoryKey, parsePanelMemory } from '../workbench/panel/memory.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// The 작업 tab (features/session-panel.md 탭, "+" 목록, 주소와 기억), until 미리보기 is a tab of its
// own: today's tools pane with both inner tabs (작업 · 미리보기), its own panel tab. `panel=tools`
// opens it as it is, `panel=preview` opens it on 미리보기, and the address names the inner tab in
// front.

vi.setConfig({ testTimeout: 20_000 });

const W = {
  panelTabs: messages.SessionPanel.tabs,
  add: messages.SessionPanel.add,
  tools: messages.Docking.tools,
  tasks: messages.DevTasks.title,
  preview: messages.Preview.tab,
  files: messages.Docking.files,
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

async function open(world: ShellWorld, address: string) {
  const shell = await mountShell(world, [address], { width: WIDE });
  cleanups.push(() => shell.unmount());
  return shell;
}
const serverWorld = () => createShellWorld({ server: true, folder: true });

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
}
function spoken(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(spoken).join('');
}
const nameOf = (element: Element) => (element.getAttribute('aria-label') ?? spoken(element)).trim();
async function press(element: HTMLElement | null | undefined) {
  expect(element, 'the control to press is on screen').toBeTruthy();
  const target = element as HTMLElement;
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      if (type === 'mousedown' && !event.defaultPrevented) target.focus();
    }
    target.click();
  });
  await settle();
}

const side = () => document.querySelector<HTMLElement>('[data-slot="side-panel-side"]');
const panelStrip = () =>
  side()?.querySelector<HTMLElement>(`[role="tablist"][aria-label="${W.panelTabs}"]`) ?? null;
const tabName = (tab: HTMLElement) =>
  (
    tab.querySelector('[data-slot="tabs-closable-label"]')?.textContent ??
    tab.textContent ??
    ''
  ).trim();
const panelTabs = () => [...(panelStrip()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
const panelSelected = () => {
  const tab = panelTabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
/** The inner tabs inside the selected 작업 tab: 작업 · 미리보기. */
const innerTabs = () => {
  const selected = panelTabs().find((item) => item.getAttribute('aria-selected') === 'true');
  const panelId = selected?.getAttribute('aria-controls');
  const body = panelId ? document.getElementById(panelId) : null;
  return [
    ...(body
      ?.querySelector(`[role="tablist"][aria-label="${W.tools}"]`)
      ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
  ];
};
const innerSelected = () => {
  const tab = innerTabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? nameOf(tab) : null;
};
const innerTab = (name: string) => innerTabs().find((item) => nameOf(item) === name) ?? null;
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;
const historyLength = (shell: MountedShell) => shell.router.history.length;

it('새 페이지를 panel=tools 주소로 연다 → 작업 탭이 열려 선택되고 안쪽은 작업이며 주소는 그대로다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=tools`);
  await until(() => panelSelected() === W.tools && innerSelected() !== null);

  expect(panelSelected()).toBe(W.tools);
  expect(innerSelected()).toBe(W.tasks);
  expect(search(shell).panel).toBe('tools');
});

it('새 페이지를 panel=preview 주소로 연다 → 작업 탭이 그 미리보기 안쪽 탭으로 열리고 주소는 panel=preview다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=preview`);
  await until(() => panelSelected() === W.tools && innerSelected() !== null);

  expect(panelSelected()).toBe(W.tools);
  expect(innerSelected()).toBe(W.preview);
  expect(search(shell).panel).toBe('preview');
  // One tab carries both: no tab of its own for 미리보기 yet.
  expect(panelTabs().map(tabName)).toEqual([W.tools]);
});

it('작업 탭에서 안쪽의 미리보기를 고른다 → 주소가 기록 없이 panel=preview로 바뀌고 대화의 기억에 남는다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=tools`);
  await until(() => innerSelected() === W.tasks);
  const before = historyLength(shell);

  await press(innerTab(W.preview));
  await until(() => search(shell).panel === 'preview');

  expect(innerSelected()).toBe(W.preview);
  expect(search(shell).panel).toBe('preview');
  expect(historyLength(shell)).toBe(before);
  const memory = parsePanelMemory(window.localStorage.getItem(panelMemoryKey(world.sessionId)));
  expect(memory?.tabs).toEqual([{ kind: 'tools', view: 'preview' }]);
});

it('미리보기가 앞에 있는 작업 탭이 열려 있다 → panel=tools 링크를 따라간다 → 안쪽 탭은 그대로이고 주소는 panel=preview로 바뀌어 쓰인다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=preview`);
  await until(() => innerSelected() === W.preview);

  await act(async () => {
    void shell.router.navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: world.sessionId },
      search: { panel: 'tools' },
    });
  });
  await settle();
  await until(() => search(shell).panel === 'preview');

  expect(panelSelected()).toBe(W.tools);
  expect(innerSelected()).toBe(W.preview);
  expect(search(shell).panel).toBe('preview');
});

it('Paddock이 있는 대화의 "+" 목록 → 작업이 마지막 항목이고, 고르면 작업 탭이 열린다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=files`);
  await until(() => panelSelected() === W.files);
  const plus = [...(side()?.querySelectorAll<HTMLElement>('button') ?? [])].find(
    (button) => nameOf(button) === W.add,
  );
  await press(plus);
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((row) =>
      spoken(row).trim(),
    );
  await until(() => rows().length > 0);

  expect(rows().at(-1)).toBe(W.tools);

  const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => spoken(item).trim() === W.tools,
  );
  await press(row);
  await until(() => panelSelected() === W.tools);
  expect(panelTabs().map(tabName)).toEqual([W.files, W.tools]);
  expect(search(shell).panel).toBe('tools');
});
