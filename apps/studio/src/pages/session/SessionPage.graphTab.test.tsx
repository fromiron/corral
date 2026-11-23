// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { editorWorkingCopy } from '../../workbench/editorDraft.ts';
import { panelMemoryKey, serializePanelMemory } from '../../workbench/panel/memory.ts';
import {
  createShellWorld,
  type MountedShell,
  mountShell,
  type ShellWorld,
  settle,
  stubBrowser,
  WIDE,
} from './sessionShell.fixture.tsx';

// The 팀 그래프 tab (features/session-panel.md 탭, 여는 길, 주소와 기억): "Corral 설계 열기" opens the
// team's graph in the panel, one tab per team named by the team; `panel=graph&corral=…` names it;
// a restored one whose team the project no longer has is dropped. The route and dock open
// the same team's editor, including its last-used view.

vi.setConfig({ testTimeout: 20_000 });

const TEAM = 'Linear writer';
const W = {
  panelTabs: messages.SessionPanel.tabs,
  editTeam: messages.Sessions.editTeam,
  actions: messages.Desktop.sessionActions.replace('{title}', 'Conversation'),
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
const panelTabNames = () => panelTabs().map(tabName);
const panelSelected = () => {
  const tab = panelTabs().find((item) => item.getAttribute('aria-selected') === 'true');
  return tab ? tabName(tab) : null;
};
const presentation = () =>
  document.querySelector('[data-slot="side-panel-frame"]')?.getAttribute('data-presentation') ??
  null;
const search = (shell: MountedShell) =>
  shell.router.state.location.search as Record<string, unknown>;
const editorTab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('header [role="tab"]')].find(
    (tab) => nameOf(tab) === name,
  );

async function editTeam() {
  const trigger = [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) => nameOf(button) === W.actions,
  );
  await press(trigger);
  const row = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => spoken(item).trim() === W.editTeam,
    ) ?? null;
  await until(() => Boolean(row()));
  await press(row());
}

it('패널이 닫힘이다 → 더 보기 메뉴의 "Corral 설계 열기" → 패널이 열리고 팀 이름의 팀 그래프 탭이 선택되며 주소는 panel=graph&corral=…이다; 다시 열면 새 탭 없이 그 탭을 고른다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  expect(presentation()).toBe('closed');

  await editTeam();
  await until(() => panelSelected() === TEAM && Boolean(editorTab('Flow graph')));

  expect(presentation()).not.toBe('closed');
  expect(panelTabNames()).toEqual([TEAM]);
  expect(search(shell).panel).toBe('graph');
  expect(search(shell).corral).toBe('corral_team');
  expect(editorTab('Flow graph')?.getAttribute('aria-selected')).toBe('true');

  await editTeam();
  await settle(20);
  expect(panelTabNames()).toEqual([TEAM]);
  expect(panelSelected()).toBe(TEAM);
});

it('새 페이지를 panel=graph&corral=… 주소로 연다 → 그 팀의 팀 그래프 탭이 열려 선택된다', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=graph&corral=corral_team`);
  await until(() => panelSelected() === TEAM && Boolean(editorTab('Flow graph')));

  expect(panelTabNames()).toEqual([TEAM]);
  expect(editorTab('Flow graph')?.getAttribute('aria-selected')).toBe('true');
  expect(search(shell).corral).toBe('corral_team');
});

it('opens the same view in the session graph tab that was chosen on the team route', async () => {
  const world = await serverWorld();
  const route = await open(world, '/corrals/corral_team/edit');
  await until(() => Boolean(editorTab('Team composition')));
  await press(editorTab('Team composition'));
  await route.unmount();

  await open(world, `/sessions/${world.sessionId}?panel=graph&corral=corral_team`);
  await until(() => editorTab('Team composition')?.getAttribute('aria-selected') === 'true');
  expect(panelSelected()).toBe(TEAM);
  expect(editorTab('Team composition')?.getAttribute('aria-selected')).toBe('true');
  expect(panelTabs()[0]?.getAttribute('aria-description')).toBeNull();
});

it('대화의 기억에 프로젝트에 없는 팀의 팀 그래프 탭과 파일 탭이 있다 → 들어오면 그 팀 그래프 탭은 버려지고 파일 탭이 선택된다; 있는 팀의 탭은 남는다', async () => {
  const world = await serverWorld();
  window.localStorage.setItem(
    panelMemoryKey(world.sessionId),
    serializePanelMemory({
      tabs: [
        { kind: 'graph', corralId: 'corral_gone' },
        { kind: 'files' },
        { kind: 'graph', corralId: 'corral_team' },
      ],
      selected: 'graph:corral_gone',
      open: true,
    }),
  );
  await open(world, `/sessions/${world.sessionId}`);
  await until(() => panelTabNames().length > 0);
  await settle(20);

  expect(panelTabNames()).toEqual([W.files, TEAM]);
  expect(panelSelected()).toBe(W.files);
});

it('주소가 프로젝트에 없는 팀을 가리킨다 → 그 탭은 버려지지 않고 열린 채다 (반례)', async () => {
  const world = await serverWorld();
  const shell = await open(world, `/sessions/${world.sessionId}?panel=graph&corral=corral_gone`);
  await until(() => panelTabs().length === 1);
  await settle(20);

  expect(panelTabs()).toHaveLength(1);
  expect(side()?.textContent).toContain(messages.Docking.unknownPanel);
  expect(search(shell).corral).toBe('corral_gone');
});

it('팀 그래프 탭이 열려 있다 → 그 팀의 초안이 저장되지 않은 채 바뀐다 → 탭은 미저장 표시를 달고 그 뜻을 설명으로 읽히며 이름은 팀 이름 그대로다; 저장되면 표시가 사라진다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}?panel=graph&corral=corral_team`);
  await until(() => panelSelected() === TEAM);
  const tab = () => panelTabs()[0] ?? null;
  expect(tab()?.getAttribute('aria-description')).toBeNull();

  const record = await world.services.repository.get('corral_team');
  if (!record) throw new Error('the team is missing');
  const copy = editorWorkingCopy(world.services.repository, record);
  await act(async () => copy.setState({ saving: true }));
  await until(() => tab()?.getAttribute('aria-description') === messages.Documents.dirty);

  expect(tab()?.getAttribute('aria-description')).toBe(messages.Documents.dirty);
  expect(panelTabNames()).toEqual([TEAM]);
  await act(async () => copy.setState({ saving: false }));
  await until(() => tab()?.getAttribute('aria-description') === null);
  expect(tab()?.getAttribute('aria-description')).toBeNull();
});

it('더 보기 메뉴를 연다 → 목록의 줄은 맨 앞의 대화 밀도 줄부터 차례로 한 번씩 번호가 매겨진다', async () => {
  const world = await serverWorld();
  await open(world, `/sessions/${world.sessionId}`);
  await settle(20);
  const trigger = [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) => nameOf(button) === W.actions,
  );
  await press(trigger);
  const rows = () => [
    ...(document.querySelector('[role="menu"]')?.querySelectorAll('[data-fluid-hover-index]') ??
      []),
  ];
  await until(() => rows().length > 1);

  expect(rows()[0]?.getAttribute('aria-label')?.startsWith(messages.Desktop.chatDensity)).toBe(
    true,
  );
  expect(rows().map((row) => row.getAttribute('data-fluid-hover-index'))).toEqual(
    rows().map((_, index) => String(index)),
  );
});
