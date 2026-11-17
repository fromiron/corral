// @vitest-environment jsdom
import {
  type CorralRecord,
  type CorralRepository,
  createKeyValueCorralRepository,
} from '@corral/core';
import { type EditorDraft, emptyDraft } from '@corral/react';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { placeStep } from '../../../../packages/react/src/team-editor/commands.ts';
import { editorWorkingCopy } from '../workbench/editorDraft.ts';
import { EditorPage, TeamDesign } from './EditorPage.tsx';

// The team editor in its two hosts, the route editor and the session's team graph pane, stacks
// when its own width is under 960px (docs/specs/features/canvas.md 1, canvas.feature): the
// path bar stays above, both drags still land, and the 768px test-run rule still holds.

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  record: null as unknown,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({
  editorRoute: { useLoaderData: () => fixture.record, useSearch: () => ({}) },
  demoRoute: {},
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useBlocker: () => {},
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));

const m = messages.TeamEditor;

// jsdom has no layout. The host's width is set here and read the way the editor reads it: the
// column that holds the team editor is the host's width less a test run beside it; the canvas
// pane has a size of its own so its view can fit.
let hostWidth = 900;
const RUN_WIDTH = 400;
const observers = new Set<() => void>();
function widthOf(element: HTMLElement): number {
  if (element.closest('[hidden]')) return 0;
  if (element.hasAttribute('data-team-canvas')) return 600;
  if (element.firstElementChild?.hasAttribute('data-layout')) {
    const run = element.parentElement?.querySelector(
      `:scope > aside[aria-label="${m.testRun}"]:not([hidden])`,
    );
    return hostWidth - (run ? RUN_WIDTH : 0);
  }
  return hostWidth;
}
/** The host takes `width`, and every observer hears of it, as a resize would tell them. */
function resize(width = hostWidth) {
  hostWidth = width;
  act(() => {
    for (const notify of observers) notify();
  });
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  hostWidth = 900;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {
        observers.add(this.notify);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.notify);
      }
    },
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[hidden]') ? 0 : 400;
    },
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  observers.clear();
  vi.unstubAllGlobals();
  // Restores jsdom's own prototype getters.
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  localStorage.clear();
});

function memoryRepository(): CorralRepository {
  const values = new Map<string, string>();
  let id = 0;
  return createKeyValueCorralRepository(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    {
      clock: { nowIso: () => '2026-11-18T00:00:00.000Z', monotonicMs: () => 0 },
      newCorralId: () => `corral_${++id}`,
      newProjectId: () => 'project_1',
      newSessionId: () => 'session_1',
    },
  );
}

function ok(result: ReturnType<typeof placeStep>): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}

/** A saved team: agent 1 → agent 2, and an empty Loop to move a step into. */
async function savedTeam(repository: CorralRepository): Promise<CorralRecord> {
  const a = ok(placeStep(emptyDraft('stacked', 'Stacked team'), 'agent', { kind: 'empty' }));
  const b = ok(placeStep(a.draft, 'agent', { kind: 'after', nodeId: a.nodeId }));
  const { draft } = ok(placeStep(b.draft, 'loop', { kind: 'empty' }));
  await repository.createProject({ name: 'Project' });
  const saved = await repository.save({
    definition: draft.definition,
    expectedDefinitionRevision: null,
    projectId: 'project_1',
  });
  if (!saved.ok) throw new Error(saved.message);
  return saved.record;
}

type Host = 'route' | 'session';

/** Mounts the editor in its host at `width` and waits for its canvas to draw. */
async function mount(host: Host, width: number) {
  hostWidth = width;
  const repository = memoryRepository();
  const record = await savedTeam(repository);
  fixture.record = record;
  fixture.services = {
    mode: 'browser',
    repository,
    transport: {},
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: () => Promise.resolve(),
    models: null,
    harnesses: null,
    live: false,
    persistent: true,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {host === 'route' ? <EditorPage /> : <TeamDesign corralId={record.corralId} />}
      </IntlProvider>,
    ),
  );
  // The session's pane reads the saved team first.
  for (let i = 0; i < 20 && !canvasNode('agent_1'); i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(canvasNode('agent_1'), 'the canvas drew the team').toBeTruthy();
  /** The draft the editor is editing, which the session pane and the route share. */
  return () => editorWorkingCopy(repository, record).getState().editor.getState().draft;
}

const editorRoot = () => document.querySelector('[data-layout]') as HTMLElement;
const layoutOf = () => editorRoot()?.getAttribute('data-layout');
const region = (selector: string) => document.querySelector(selector) as HTMLElement;
const outline = () => region(`aside[aria-label="${m.outline}"]`);
const palette = () => region(`[role="toolbar"][aria-label="${m.palette}"]`);
const canvas = () => region('[data-team-canvas]');
const sheet = () => region(`aside[aria-label="${m.inspector}"]`);
const testRun = () => region(`aside[aria-label="${m.testRun}"]`);
const shown = (element: HTMLElement | null) => Boolean(element && !element.closest('[hidden]'));
const canvasNode = (id: string) =>
  document.querySelector(`[data-team-canvas] [data-node="${id}"]`) as HTMLElement;
const named = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLElement>('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === name,
  ) as HTMLElement;
const isSelected = (id: string) => canvasNode(id).getAttribute('aria-pressed') === 'true';

async function click(element: HTMLElement) {
  expect(element, 'the control to press is on screen').toBeTruthy();
  await act(async () => element.click());
}

/** The drag data one drag carries from its start to its drop, as a browser keeps it. */
function transfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
}
type Transfer = ReturnType<typeof transfer>;
function drag(
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  target: Element,
  dataTransfer: Transfer,
  at?: { x: number; y: number },
) {
  // jsdom has no DragEvent: the data and the pointer position go on a plain event.
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  if (at) {
    Object.defineProperty(event, 'clientX', { value: at.x });
    Object.defineProperty(event, 'clientY', { value: at.y });
  }
  act(() => {
    target.dispatchEvent(event);
  });
}
/** Where a point of the canvas stage is on screen; jsdom puts the pane at 0, 0. */
function onScreen(element: HTMLElement) {
  const stage = document.querySelector('[data-graph-stage]') as HTMLElement;
  const [, x, y, k] =
    /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(stage.style.transform) ?? [];
  return {
    x: Number(x) + Number.parseFloat(element.style.left) * Number(k),
    y: Number(y) + Number.parseFloat(element.style.top) * Number(k),
  };
}

const HOSTS: [Host, number][] = [
  ['route', 900],
  ['session', 540],
];

describe('team editor hosts: stacked below 960px', () => {
  it.each(['route', 'session'] as const)(
    '%s: stacks at 959px of its own width and lays out beside at 960px, under its path bar',
    async (host) => {
      await mount(host, 959);
      expect(layoutOf()).toBe('stacked');
      // The path bar stays above; only what is under it scrolls.
      const pathBar = named(document, messages.Editor.save).closest('header') as HTMLElement;
      expect(pathBar).toBeTruthy();
      expect(editorRoot().contains(pathBar)).toBe(false);
      expect(
        pathBar.compareDocumentPosition(editorRoot()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      resize(960);
      expect(layoutOf()).toBe('beside');
      resize(959);
      expect(layoutOf()).toBe('stacked');
    },
  );

  it.each(HOSTS)(
    '%s at %ipx: a palette step dropped on a connection and an outline row dropped on a Loop land',
    async (host, width) => {
      const draft = await mount(host, width);
      expect(layoutOf()).toBe('stacked');
      // A Review dropped on the connection between agent 1 and agent 2 goes between them.
      const step = transfer();
      const review = named(palette(), `Add ${m.kinds.review}`);
      drag('dragstart', review, step);
      expect(step.types).toEqual(['application/x-corral-step']);
      const insert = named(canvas(), m.insertHere);
      const at = onScreen(insert);
      drag('dragover', canvas(), step, at);
      drag('drop', canvas(), step, at);
      drag('dragend', review, step);
      const added = draft().definition.nodes.find((n) => n.type === 'decision');
      const edges = draft().definition.controlEdges.map((e) => `${e.source}>${e.target}`);
      expect(edges).toContain(`agent_1>${added?.id}`);
      expect(edges).toContain(`${added?.id}>agent_2`);
      expect(edges).not.toContain('agent_1>agent_2');
      // Agent 2's row dropped on the Loop's row moves it into the Loop.
      const row = transfer();
      const agent = named(outline(), 'Agent 2');
      const loop = named(outline(), 'Loop');
      drag('dragstart', agent, row);
      expect(row.types).toEqual(['application/x-corral-node']);
      drag('dragover', loop, row);
      drag('drop', loop, row);
      drag('dragend', agent, row);
      const box = draft().definition.nodes.find((n) => n.type === 'loop');
      expect(draft().definition.nodes.find((n) => n.id === 'agent_2')?.parentId).toBe(box?.id);
    },
  );

  it('route at 768px: the test run takes the editor’s place, and the editor comes back as it was', async () => {
    await mount('route', 768);
    expect(layoutOf()).toBe('stacked');
    await click(canvasNode('agent_1'));
    await click(named(document, m.testRun));
    resize();
    expect(shown(testRun())).toBe(true);
    expect(shown(canvas())).toBe(false);
    expect(shown(palette())).toBe(false);
    await click(named(document, m.hideRun));
    resize();
    expect(shown(canvas())).toBe(true);
    expect(layoutOf()).toBe('stacked');
    expect(isSelected('agent_1')).toBe(true);
    expect(shown(sheet())).toBe(true);
  });

  it('route at 1010px, a 1280px window with the sidebar open, lays out beside', async () => {
    await mount('route', 1010);
    expect(layoutOf()).toBe('beside');
  });

  it('route: crossing 960px either way keeps the selection and the focus', async () => {
    await mount('route', 1200);
    expect(layoutOf()).toBe('beside');
    await click(canvasNode('agent_1'));
    const name = sheet().querySelector<HTMLInputElement>('[data-node-settings] input');
    expect(name?.value).toBe('Agent 1');
    await act(async () => name?.focus());
    resize(900);
    expect(layoutOf()).toBe('stacked');
    expect(document.activeElement).toBe(name);
    resize(1200);
    expect(layoutOf()).toBe('beside');
    expect(document.activeElement).toBe(name);
    const card = canvasNode('agent_1');
    await act(async () => card.focus());
    resize(900);
    expect(document.activeElement).toBe(card);
    resize(1200);
    expect(document.activeElement).toBe(card);
    expect(isSelected('agent_1')).toBe(true);
  });

  it('route at 1300px: a test run beside leaves the editor 900px, so it stacks and keeps the selection', async () => {
    await mount('route', 1300);
    expect(layoutOf()).toBe('beside');
    await click(canvasNode('agent_1'));
    await click(named(document, m.testRun));
    resize();
    expect(shown(testRun())).toBe(true);
    expect(shown(canvas())).toBe(true);
    expect(layoutOf()).toBe('stacked');
    expect(isSelected('agent_1')).toBe(true);
    await click(named(document, m.hideRun));
    resize();
    expect(layoutOf()).toBe('beside');
    expect(isSelected('agent_1')).toBe(true);
  });
});
