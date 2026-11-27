// @vitest-environment jsdom

import type { AgentStartInput, HarnessBindingRef } from '@corral/contracts';
import {
  Coordinator,
  type CorralRecord,
  type CorralRepository,
  createKeyValueCorralRepository,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import {
  draftFromDefinition,
  type EditorDraft,
  type EditorStore,
  emptyDraft,
  type RunSessionStore,
} from '@corral/react';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { placeStep } from '../../../../../packages/react/src/team-editor/commands.ts';
import { templateDefinition, templateText } from '../../templates.ts';
import { editorWorkingCopy, newEditorWorkingCopy } from '../../workbench/editorDraft.ts';
import { readEditorView, rememberEditorView } from '../../workbench/editorView.ts';
import { EditorPage, TeamDesign } from './EditorPage.tsx';

// The team editor in its two hosts, the route editor and the session's team graph pane, stacks
// when its own width is under 960px (docs/specs/features/canvas.md 1, canvas.feature): the
// path bar stays above, both drags still land, and the 768px test-run rule still holds.

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  record: null as unknown,
  navigate: vi.fn().mockResolvedValue(undefined),
  fromSession: undefined as string | undefined,
  template: undefined as 'starter' | 'blank' | undefined,
  blocker: null as null | {
    shouldBlockFn: (location: {
      current: { pathname: string; search?: unknown };
      next: { pathname: string; search?: unknown };
    }) => boolean | Promise<boolean>;
  },
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({
  editorRoute: {
    useLoaderData: () => fixture.record,
    useSearch: () => ({ fromSession: fixture.fromSession }),
    useMatch: () =>
      fixture.template
        ? undefined
        : {
            loaderData: fixture.record,
            search: { fromSession: fixture.fromSession },
          },
  },
  newEditorRoute: {
    useMatch: () =>
      fixture.template
        ? {
            loaderData: { projectId: 'project_1', newTemplate: fixture.template },
            search: {},
          }
        : undefined,
  },
  demoRoute: {},
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useBlocker: (options: NonNullable<typeof fixture.blocker>) => {
    fixture.blocker = options;
  },
  useNavigate: () => fixture.navigate,
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
  const column = element.closest('[data-layout]')?.parentElement ?? element;
  if (column.firstElementChild?.hasAttribute('data-layout')) {
    const run = column.parentElement?.querySelector(
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
const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
beforeEach(() => {
  hostWidth = 900;
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
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
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
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
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  localStorage.clear();
  fixture.navigate.mockClear();
  fixture.fromSession = undefined;
  fixture.template = undefined;
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
async function savedTeam(
  repository: CorralRepository,
  binding?: HarnessBindingRef,
): Promise<CorralRecord> {
  const a = ok(placeStep(emptyDraft('stacked', 'Stacked team'), 'agent', { kind: 'empty' }));
  const b = ok(placeStep(a.draft, 'agent', { kind: 'after', nodeId: a.nodeId }));
  const { draft } = ok(placeStep(b.draft, 'loop', { kind: 'empty' }));
  await repository.createProject({ name: 'Project' });
  const saved = await repository.save({
    definition: binding
      ? {
          ...draft.definition,
          roles: draft.definition.roles.map((role) => ({ ...role, harness: binding })),
        }
      : draft.definition,
    expectedDefinitionRevision: null,
    projectId: 'project_1',
  });
  if (!saved.ok) throw new Error(saved.message);
  return saved.record;
}

type Host = 'route' | 'session';

/** Mounts the editor in its host at `width` and waits for its canvas to draw. */
async function mount(
  host: Host,
  width: number,
  configure?: (repository: CorralRepository, record: CorralRecord) => Record<string, unknown>,
  harness?: {
    binding: HarnessBindingRef;
    preview: (
      binding: HarnessBindingRef,
      project: string,
    ) => Promise<{ snapshot: { allowedTools: string[] } }>;
  },
) {
  hostWidth = width;
  const repository = memoryRepository();
  const record = await savedTeam(repository, harness?.binding);
  fixture.record = record;
  fixture.services = {
    mode: 'browser',
    repository,
    agents: { list: async () => [] },
    transport: {},
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: () => Promise.resolve(),
    models: null,
    harnesses: harness
      ? {
          preview: (target: HarnessBindingRef | { id: string }, project: string) =>
            'id' in target
              ? Promise.resolve({ snapshot: { resources: [] } })
              : harness.preview(target, project),
          profileManagement: async () => [],
          entries: async () => [],
          packages: async () => [],
        }
      : null,
    live: false,
    persistent: true,
    ...configure?.(repository, record),
  };
  await renderPage(host === 'route' ? <EditorPage /> : <TeamDesign corralId={record.corralId} />);
  // The session's pane reads the saved team first.
  for (let i = 0; i < 20 && !canvasNode('agent_1'); i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(canvasNode('agent_1'), 'the canvas drew the team').toBeTruthy();
  /** The draft the editor is editing, which the session pane and the route share. */
  return () => editorWorkingCopy(repository, record).getState().editor.getState().draft;
}

async function renderPage(page: ReactNode) {
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
        {page}
      </IntlProvider>,
    ),
  );
}

async function renderNewEditor(template: 'blank' | 'starter') {
  const repository = memoryRepository();
  await repository.createProject({ name: 'Project' });
  const save = vi.spyOn(repository, 'save');
  fixture.template = template;
  fixture.services = {
    mode: 'browser',
    repository,
    newCorralId: () => 'corral_working',
    agents: { list: async () => [] },
    transport: {},
    editorSessions: new Map(),
    models: null,
    harnesses: null,
    runModes: {},
    live: false,
  };
  await renderPage(<EditorPage />);
  const copy = newEditorWorkingCopy(repository, 'project_1', template !== 'blank', () => {
    throw Error('The editor must have opened its working copy');
  });
  return { repository, save, editor: copy.getState().editor };
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

async function click(element: HTMLElement | undefined) {
  assert(element, 'the control to press is on screen');
  await act(async () => element.click());
}

async function prepareRun() {
  const menu = named(document, 'Run options');
  assert(menu);
  await act(async () => {
    menu.focus();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await click(region('[role="menuitem"][aria-label="Prepare a run"]'));
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

const viewTab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('header [role="tab"]')].find((tab) =>
    tab.textContent?.includes(name),
  );

describe('team editor views', () => {
  it('expands the assistant inline in the 640px editor beside the open test run', async () => {
    await mount('route', 640 + RUN_WIDTH);
    await prepareRun();
    resize();
    expect(shown(testRun())).toBe(true);
    expect(editorRoot().clientWidth).toBe(640);
    expect(layoutOf()).toBe('stacked');
    await click(named(editorRoot(), messages.TeamAssistant.editTitle));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Without a model the switched-off request stands in the input's place and takes its focus.
    expect(named(editorRoot(), messages.TeamAssistant.localServer)).toBe(document.activeElement);
    await click(named(editorRoot(), messages.TeamAssistant.choice.describe));
    expect(shown(testRun())).toBe(true);
  });

  it('uses a keyboard-accessible assistant sheet in a 360px session team tab, but stays inline at 30rem', async () => {
    await mount('session', 480);
    await click(named(editorRoot(), messages.TeamAssistant.editTitle));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(named(editorRoot(), messages.TeamAssistant.collapse));
    resize(360);
    const entry = named(editorRoot(), messages.TeamAssistant.editTitle);
    await click(entry);
    const dialog = region('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const input = named(dialog, messages.TeamAssistant.localServer);
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(entry));
  });

  it('turns the request off without a server, keeping the choices that need no model', async () => {
    const draft = await mount('route', 1280);
    const before = draft();
    await click(named(editorRoot(), 'Edit the team with AI'));
    expect(editorRoot().querySelector('textarea')).toBeNull();
    const off = named(editorRoot(), messages.TeamAssistant.localServer);
    expect(off?.getAttribute('aria-disabled')).toBe('true');
    expect(named(editorRoot(), 'Connect a model')).toBeFalsy();
    expect(named(editorRoot(), messages.TeamAssistant.choice.describe)).toBeTruthy();
    expect(draft()).toBe(before);
  });

  it('does not claim there is no model while the model list is still loading', async () => {
    await mount('route', 1280, () => ({
      live: true,
      models: {
        catalog: async () => [],
        profiles: () => new Promise(() => {}),
        assistTeam: vi.fn(),
      },
    }));
    await click(named(editorRoot(), 'Edit the team with AI'));
    expect(editorRoot().querySelector('textarea')).toBeTruthy();
    expect(named(editorRoot(), 'Connect a model')).toBeFalsy();
  });

  it('offers Connect a model, not a waiting input, when the model list cannot be read', async () => {
    const assistTeam = vi.fn();
    await mount('route', 1280, () => ({
      live: true,
      models: {
        catalog: async () => [],
        profiles: async () => {
          throw new Error('offline');
        },
        assistTeam,
      },
    }));
    await click(named(editorRoot(), 'Edit the team with AI'));
    await vi.waitFor(() => expect(named(editorRoot(), 'Connect a model')).toBeTruthy());
    expect(editorRoot().querySelector('textarea')).toBeNull();
    expect(assistTeam).not.toHaveBeenCalled();
  });

  it('opens the model settings from the switched-off request when no model can run', async () => {
    const assistTeam = vi.fn();
    const profile = { source: 'profile', providerName: 'Provider', available: true };
    await mount('route', 1280, () => ({
      live: true,
      models: {
        catalog: async () => [],
        profiles: async () => [
          { ...profile, profileId: 'model-a', modelName: 'Offline model', method: null },
        ],
        assistTeam,
      },
    }));
    await click(named(editorRoot(), 'Edit the team with AI'));
    expect(editorRoot().querySelector('textarea')).toBeNull();
    await click(named(editorRoot(), 'Connect a model'));
    expect(fixture.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/settings/models' }),
    );
    expect(assistTeam).not.toHaveBeenCalled();
  });

  it.each([
    {
      case: 'the first named profile is offline',
      listed: [
        { source: 'profile', profileId: 'model-a', modelName: 'Offline model', method: null },
        { source: 'profile', profileId: 'model-b', modelName: 'Ready model', method: 'apiKey' },
      ],
    },
    {
      case: 'only a provider is connected',
      listed: [
        {
          source: 'connection',
          profileId: 'provider:ready',
          modelName: 'Ready model',
          method: 'apiKey',
        },
      ],
    },
  ])('asks the first ready model of the list when $case', async ({ listed }) => {
    await mount('route', 1280, () => ({
      live: true,
      models: {
        catalog: async () => [],
        profiles: async () =>
          listed.map((entry) => ({ providerName: 'Provider', available: true, ...entry })),
        assistTeam: vi.fn(),
      },
    }));
    await click(named(editorRoot(), 'Edit the team with AI'));
    await vi.waitFor(() => expect(editorRoot().querySelector('textarea')).toBeTruthy());
    expect(editorRoot().textContent).toContain('Ready model');
    expect(editorRoot().textContent).not.toContain('Offline model');
    expect(named(editorRoot(), 'Connect a model')).toBeFalsy();
  });

  it.each(['route', 'session'] as const)(
    'loads the current project’s originals in the %s editor',
    async (host) => {
      const list = vi.fn().mockResolvedValue([]);
      await mount(host, 1000, () => ({ agents: { list } }));
      expect(list).toHaveBeenCalledExactlyOnceWith('project_1');
      await click(named(palette(), 'Add Agent'));
      const dialog = region('[role="dialog"]');
      expect(dialog.textContent).toContain('My agents');
      expect(dialog.textContent).not.toContain('Project: Project');
      expect(dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
        'Built-in',
      );
      await click(
        [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) =>
          tab.textContent?.includes('My agents'),
        ),
      );
      expect(dialog.textContent).toContain('Project: Project');
    },
  );

  it('uses one create operation per opened save dialog and reloads originals after success', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValue({ ok: true });
    const draft = await mount('route', 1280, () => ({ agents: { list, create } }));
    const before = draft();
    await click(canvasNode('agent_1'));
    async function openSave() {
      const trigger = named(sheet(), messages.Inspector.seatActions);
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      await click(region('[role="menuitem"][aria-label="Save to library"]'));
    }
    await openSave();
    await click(named(region('[role="dialog"]'), 'Save agent'));
    expect(region('[role="dialog"] [role="alert"]').textContent).toContain('Could not save');
    await click(named(region('[role="dialog"]'), 'Save agent'));
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]).toEqual([
      'project_1',
      { role: expect.objectContaining({ name: 'Agent 1' }), operationId: expect.any(String) },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    await openSave();
    await click(named(region('[role="dialog"]'), 'Save agent'));
    expect(create.mock.calls[2]?.[1].operationId).not.toBe(create.mock.calls[0]?.[1].operationId);
    expect(draft()).toBe(before);
  });

  it('isolates each team’s view and keeps a refused write for the rest of this tab', () => {
    rememberEditorView('private-team', 'graph');
    const refuse = () => {
      throw new DOMException('Storage denied', 'SecurityError');
    };
    try {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
      rememberEditorView('private-team', 'composition');
      expect(readEditorView('private-team')).toBe('composition');
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
      expect(readEditorView('another-team')).toBe('graph');
      expect(readEditorView('private-team')).toBe('composition');
    } finally {
      vi.restoreAllMocks();
      rememberEditorView('private-team', 'graph');
    }
  });

  it('opens an existing team in Flow graph; arrows switch focus and view, not the working copy', async () => {
    const draft = await mount('route', 390, () => ({
      transport: { getRunStats: vi.fn().mockRejectedValue(Error('unavailable')) },
    }));
    const original = draft();
    const graph = viewTab('Flow graph');
    const composition = viewTab('Team composition');
    expect(graph?.getAttribute('aria-selected')).toBe('true');
    await click(named(document, m.stats.toggle));
    expect(document.querySelector('header')?.textContent).toContain(m.stats.failed);
    await act(async () => {
      graph?.focus();
      graph?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(composition);
    expect(composition?.getAttribute('aria-selected')).toBe('true');
    expect(named(document, m.stats.toggle)).toBeUndefined();
    expect(document.querySelector('header')?.textContent).not.toContain(m.stats.failed);
    expect(shown(canvas())).toBe(false);
    expect(draft()).toBe(original);
    expect(named(document, m.undo)).toHaveProperty('disabled', true);
    expect(named(document, messages.Editor.save)).toHaveProperty('disabled', true);
    await act(async () => {
      composition?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(graph);
    expect(shown(canvas())).toBe(true);
  });

  it.each(['Team composition', 'Flow graph'])(
    '%s hides the problem badge until the first work agent, then opens request problems',
    async (view) => {
      hostWidth = 1280;
      const { editor } = await renderNewEditor('blank');
      await click(viewTab(view));
      const area = view === 'Flow graph' ? outline() : region('[data-composition-scroll]');
      const count = () =>
        [...area.querySelectorAll('button')].find((button) =>
          /^(?:\d+ problems?|No problems|Set up the flow)$/.test(button.textContent.trim()),
        );
      expect(count()).toBeUndefined();
      await act(async () => {
        const { draft } = ok(placeStep(editor.getState().draft, 'agent', { kind: 'empty' }));
        editor.getState().applyDraft(draft);
      });
      expect(count()?.textContent).toMatch(/^\d+ problems?$/);
      await click(count());
      expect(sheet().textContent).toContain(messages.Validation.schema.runInput);
    },
  );

  it('disables both mock-test controls with the Save reason until an empty draft is edited', async () => {
    const { editor } = await renderNewEditor('blank');
    const actions = [m.saveAndMockTest, m.runOptions, messages.Editor.save].map((name) =>
      named(document, name),
    );
    for (const action of actions) {
      expect(action).toHaveProperty('disabled', true);
      expect(action.getAttribute('aria-description')).toBe(messages.Editor.noChanges);
    }
    await act(async () => editor.getState().setBrief('A request'));
    for (const action of actions) {
      expect(action).toHaveProperty('disabled', false);
      expect(action.hasAttribute('aria-description')).toBe(false);
    }
    await act(async () => editor.getState().undo());
    expect(actions.every((action) => action.matches(':disabled'))).toBe(true);
  });

  it('opens an unsaved template copy in composition, creates it once, and remembers the chosen view', async () => {
    const { repository, save } = await renderNewEditor('starter');
    expect(viewTab('Team composition')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('header')?.textContent).toContain('Not saved yet');
    expect(named(document, m.saveAndMockTest)).toHaveProperty('disabled', false);
    expect(named(document, m.runOptions)).toHaveProperty('disabled', false);
    expect(document.querySelector('[data-composition-scroll]')?.textContent).toContain('Agent 1');
    expect(save).not.toHaveBeenCalled();
    await click(viewTab('Flow graph'));
    expect(named(document, m.stats.toggle)).toBeUndefined();
    await click(named(document, messages.Editor.save));
    expect(save).toHaveBeenCalledTimes(1);
    const [record] = await repository.list();
    if (!record) throw Error('Expected a saved template copy');
    const id = record.corralId;
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: '/corrals/$corralId/edit',
      params: { corralId: id },
      replace: true,
    });
    await cleanups.pop()?.();
    fixture.template = undefined;
    fixture.record = await repository.get(id);
    await renderPage(<EditorPage />);
    expect(viewTab('Flow graph')?.getAttribute('aria-selected')).toBe('true');
    await cleanups.pop()?.();
    await renderPage(<TeamDesign corralId={id} />);
    expect(viewTab('Flow graph')?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the chosen tab, the roster and its detail consecutive in the native tab order', async () => {
    await mount('route', 960);
    const tab = viewTab('Team composition');
    await click(tab);
    assert(tab);
    const stops = [
      ...document.querySelectorAll<HTMLElement>('button,input,textarea,a[href],[tabindex]'),
    ].filter((el) => shown(el) && el.tabIndex >= 0 && !el.matches(':disabled,[inert] *'));
    const position = stops.indexOf(tab);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(stops[position + 1]?.closest('[data-composition-scroll]')).not.toBeNull();
    expect(stops[position + 2]?.closest('aside')).toBe(sheet());
  });

  it('discloses import and export in the header menu and opens the callable agent dialog', async () => {
    await mount('route', 960);
    const header = region('header');
    expect(named(header, 'Import Markdown agent')).toBeUndefined();
    expect(named(header, messages.Editor.export)).toBeUndefined();
    const more = named(header, 'More actions');
    await act(async () => {
      more.focus();
      more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Import Markdown agent',
      messages.Editor.export,
    ]);
    await click(items[0]);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Import a callable agent',
    );
  });
});

describe('leaving a team with unsaved edits', () => {
  const leave = () =>
    fixture.blocker?.shouldBlockFn({
      current: { pathname: '/corrals/x/edit', search: {} },
      next: { pathname: '/library', search: {} },
    });
  const prompt = () => document.querySelector<HTMLElement>('[data-settings-guard]');
  const edited = async () => {
    let repo!: CorralRepository;
    let saved!: CorralRecord;
    const draft = await mount('route', 1280, (repository, record) => {
      repo = repository;
      saved = record;
      return {};
    });
    await act(async () =>
      editorWorkingCopy(repo, saved).getState().editor.getState().setName('Mine'),
    );
    return { repo, saved, draft };
  };
  const choose = async (name: string, answer: Promise<boolean> | boolean | undefined) => {
    await click(named(prompt() as HTMLElement, name));
    return answer;
  };

  it('asks with the settings’ three choices instead of the browser’s confirm', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    await edited();
    let answer: Promise<boolean> | boolean | undefined;
    await act(async () => {
      answer = leave();
    });
    expect(confirm).not.toHaveBeenCalled();
    const names = [...(prompt()?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(names).toEqual([
      messages.SettingsDialog.saveLeave,
      messages.SettingsDialog.discard,
      messages.SettingsDialog.keepEditing,
    ]);
    expect(await choose(messages.SettingsDialog.keepEditing, answer)).toBe(true);
    expect(prompt()).toBeNull();
  });

  it('Save and continue saves, then lets the person go', async () => {
    const { repo, saved } = await edited();
    let answer: Promise<boolean> | boolean | undefined;
    await act(async () => {
      answer = leave();
    });
    expect(await choose(messages.SettingsDialog.saveLeave, answer)).toBe(false);
    expect((await repo.get(saved.corralId))?.definition.name).toBe('Mine');
  });

  it('a failed Save and continue keeps the editor open with the failure where saves fail', async () => {
    const { repo, draft } = await edited();
    vi.spyOn(repo, 'save').mockResolvedValueOnce({
      ok: false,
      error: 'storage_unavailable',
      message: 'disk full',
    });
    let answer: Promise<boolean> | boolean | undefined;
    await act(async () => {
      answer = leave();
    });
    expect(await choose(messages.SettingsDialog.saveLeave, answer)).toBe(true);
    expect(prompt()).toBeNull();
    expect(region('header').querySelector('[role="alert"]')?.textContent).toBe(
      messages.Editor.saveError.storage_unavailable,
    );
    expect(draft().definition.name).toBe('Mine');
  });

  it('Discard changes lets the person go without saving', async () => {
    const { repo, saved } = await edited();
    let answer: Promise<boolean> | boolean | undefined;
    await act(async () => {
      answer = leave();
    });
    expect(await choose(messages.SettingsDialog.discard, answer)).toBe(false);
    expect((await repo.get(saved.corralId))?.definition.name).not.toBe('Mine');
  });
});

describe('a team saved elsewhere while it is edited', () => {
  const conflicted = async () => {
    let repo!: CorralRepository;
    let saved!: CorralRecord;
    const draft = await mount('route', 1280, (repository, record) => {
      repo = repository;
      saved = record;
      return {};
    });
    const theirs = await repo.save({
      definition: { ...saved.definition, name: 'Theirs' },
      expectedDefinitionRevision: saved.definitionRevision,
    });
    assert(theirs.ok);
    await act(async () =>
      editorWorkingCopy(repo, saved).getState().editor.getState().setName('Mine'),
    );
    await click(named(region('header'), messages.Editor.save));
    return { repo, saved, draft };
  };
  const banner = () => document.querySelector<HTMLElement>('[data-slot="banner"]');

  it('keeps the edits and offers to load the latest or save them on top, in one place', async () => {
    const { draft } = await conflicted();
    expect(banner()?.textContent).toContain(messages.Editor.saveConflict);
    expect(region('header').textContent).not.toContain('Reload before saving');
    expect(named(banner() as HTMLElement, messages.Editor.loadLatest)).toBeDefined();
    expect(named(banner() as HTMLElement, messages.Editor.saveMine)).toBeDefined();
    expect(draft().definition.name).toBe('Mine');
  });

  it('Save mine saves the working copy over the stored revision and keeps the edit', async () => {
    const { repo, saved, draft } = await conflicted();
    await click(named(banner() as HTMLElement, messages.Editor.saveMine));
    const stored = await repo.get(saved.corralId);
    expect(stored?.definition.name).toBe('Mine');
    expect(stored?.definitionRevision).toBe(3);
    expect(draft().definition.name).toBe('Mine');
    expect(banner()).toBeNull();
    expect(region('[data-testid="revisions"]').textContent).toBe(
      messages.Editor.revisions.replace('{definition}', '3'),
    );
  });

  it('a first save refused because the ID is taken says so in the app’s words and keeps the draft', async () => {
    const { save, editor } = await renderNewEditor('starter');
    const before = editor.getState().draft;
    save.mockResolvedValueOnce({
      ok: false,
      error: 'revision_conflict',
      message: 'This Corral ID already belongs to a different first save.',
    });
    await click(named(region('header'), messages.Editor.save));
    expect(region('header').querySelector('[role="alert"]')?.textContent).toBe(
      messages.Editor.saveError.idTaken,
    );
    expect(document.querySelector('[data-slot="banner"]')).toBeNull();
    expect(editor.getState().draft).toBe(before);
  });

  it('Load the latest replaces the working copy with the stored team', async () => {
    const { repo, saved, draft } = await conflicted();
    await click(named(banner() as HTMLElement, messages.Editor.loadLatest));
    expect(draft().definition.name).toBe('Theirs');
    expect((await repo.get(saved.corralId))?.definitionRevision).toBe(2);
    expect(banner()).toBeNull();
    expect(document.querySelector('h1')?.textContent).toBe('Theirs');
  });
});

describe('team editor hosts: stacked below 960px', () => {
  it('shows pinned Harness ask permission for the project in the shared Outrider roster and worker settings', async () => {
    const binding = { profileId: 'restricted', revision: 2 };
    let finishPreview!: (value: { snapshot: { allowedTools: string[] } }) => void;
    const first = new Promise<{ snapshot: { allowedTools: string[] } }>((resolve) => {
      finishPreview = resolve;
    });
    const preview = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ snapshot: { allowedTools: ['ask'] } });
    await mount('route', 390, undefined, { binding, preview });
    await click(named(outline(), 'Add shared Outrider'));
    expect(sheet().textContent).toContain('Harness question permission is unconfirmed.');
    expect(preview).toHaveBeenCalledExactlyOnceWith(binding, 'project_1');
    await act(async () => finishPreview({ snapshot: { allowedTools: ['read_file'] } }));
    expect(sheet().textContent).toContain('This Harness does not allow questions.');
    await click(named(sheet(), 'Apply'));
    await click(named(outline(), 'Agent 1'));
    expect(sheet().textContent).toContain('This Harness does not allow questions.');
    expect(sheet().textContent).not.toContain('Can ask the shared Outrider');
    await act(async () => {
      window.dispatchEvent(new Event('corral:harness-changed'));
    });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(sheet().textContent).toContain('Can ask the shared Outrider');
  });
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
      if (host === 'session') {
        expect(named(pathBar, 'Mock test')).toBeUndefined();
        expect(named(pathBar, 'Run options')).toBeUndefined();
        expect(testRun()).toBeNull();
      }
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
      // Moving Agent 2 across the Loop boundary requires confirming the affected connection.
      const beforeMove = draft();
      const row = transfer();
      const agent = named(outline(), 'Agent 2');
      const loop = named(outline(), 'Loop');
      drag('dragstart', agent, row);
      expect(row.types).toEqual(['application/x-corral-node']);
      drag('dragover', loop, row);
      drag('drop', loop, row);
      drag('dragend', agent, row);
      expect(draft()).toBe(beforeMove);
      const preview = region('[role="dialog"]');
      expect(preview.querySelector('h2')?.textContent).toBe(m.placement.previewTitle);
      expect(preview.textContent).toContain(m.placement.boundary);
      expect([...preview.querySelectorAll('li')].map((item) => item.textContent)).toContain(
        `${added?.label} · ${messages.Canvas.ports.pass} → Agent 2 · ${messages.Canvas.ports.in}`,
      );
      await click(named(preview, m.placement.apply));
      const box = draft().definition.nodes.find((n) => n.type === 'loop');
      expect(draft().definition.nodes.find((n) => n.id === 'agent_2')?.parentId).toBe(box?.id);
    },
  );

  it('route at 768px: the test run takes the editor’s place, and the editor comes back as it was', async () => {
    await mount('route', 768);
    expect(layoutOf()).toBe('stacked');
    await click(canvasNode('agent_1'));
    await prepareRun();
    resize();
    expect(shown(testRun())).toBe(true);
    expect(shown(canvas())).toBe(false);
    expect(shown(palette())).toBe(false);
    await click(named(testRun(), 'Close test panel'));
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
    await prepareRun();
    resize();
    expect(shown(testRun())).toBe(true);
    expect(shown(canvas())).toBe(true);
    expect(layoutOf()).toBe('stacked');
    expect(isSelected('agent_1')).toBe(true);
    await click(named(testRun(), 'Close test panel'));
    resize();
    expect(layoutOf()).toBe('beside');
    expect(isSelected('agent_1')).toBe(true);
  });
});

/** A runnable flow created through the same commands as the canvas. */
function linear(id: string, kind?: 'check' | 'team') {
  const a = ok(placeStep(emptyDraft(id, id), 'agent', { kind: 'empty' }));
  const next = kind
    ? ok(
        placeStep(
          a.draft,
          kind,
          { kind: 'after', nodeId: a.nodeId },
          {
            reference: { corralId: 'inner', name: 'Release check', definitionRevision: 2 },
          },
        ),
      )
    : a;
  return ok(placeStep(next.draft, 'output', { kind: 'after', nodeId: next.nodeId })).draft;
}

function edit(record: CorralRecord, repository: CorralRepository, draft: EditorDraft) {
  const editor = editorWorkingCopy(repository, record).getState().editor;
  editor
    .getState()
    .applyDraft({ ...draft, definition: { ...draft.definition, id: record.corralId } });
  return editor;
}

describe('test run validation and recovery in the editor', () => {
  it('delivers the template base and seat duty separately to each scheduled mock worker', async () => {
    const inputs: AgentStartInput[] = [];
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({
          turns: 1,
          script: async (input) => {
            inputs.push(input);
            return null;
          },
        }),
      }),
    );
    const sessions = new Map<string, RunSessionStore>();
    let editor!: EditorStore;
    await mount('route', 1280, (repo, record) => {
      editor = editorWorkingCopy(repo, record).getState().editor;
      return { transport, editorSessions: sessions };
    });
    const team = templateDefinition(
      'implement-review',
      editor.getState().draft.definition.id,
      templateText(messages),
    );
    await act(async () => editor.getState().applyDraft(draftFromDefinition(team)));
    await click(named(document, 'Mock test'));
    const runId = [...sessions.values()][0]?.getState().runId;
    assert(runId);
    await act(async () => {
      const run = await waitForProjection(transport, runId, (p) =>
        ['succeeded', 'failed'].includes(p.status),
      );
      expect(run.status).toBe('succeeded');
    });
    expect([...new Set(inputs.map(({ nodeId }) => nodeId))].sort()).toEqual([
      'implement',
      'review',
    ]);
    for (const input of inputs) {
      const agent = ({ implement: 'builder', review: 'reviewer' } as const)[
        input.nodeId as 'implement' | 'review'
      ];
      const duty = messages.TeamTemplates.presets[agent].duty;
      expect(input.assignment.kind).toBe('scheduled');
      expect(input.stepInstruction).toBe(duty);
      expect(input.role.prompt).toBe(team.roles.find((role) => role.id === input.role.id)?.prompt);
      expect(input.role.prompt).toContain('submit with submit_result.');
      expect(input.role.prompt).not.toContain(duty);
    }
  });

  it.each(['browser', 'server'])('updates Will apply on edit and save (%s)', async (mode) => {
    let editor!: EditorStore;
    await mount('route', 1280, (repository, record) => {
      editor = edit(record, repository, linear('Research'));
      editor.getState().updateNode('agent_1', { label: 'Saved writer' });
      return { mode };
    });
    await click(named(document, messages.Editor.save));
    await prepareRun();
    const setup = [...testRun().querySelectorAll('h3')]
      .find((heading) => heading.textContent === 'Will apply')
      ?.closest('section');
    assert(setup);
    expect(setup.textContent).toContain('comes from Saved writer.');
    expect(setup.textContent).not.toContain('Shared Outrider advice');
    expect(setup.textContent).toContain('Saved version 2');
    await act(async () => {
      editor.getState().updateNode('agent_1', { label: 'Draft writer' });
      const { draft, applyDraft } = editor.getState();
      applyDraft({
        ...draft,
        definition: {
          ...draft.definition,
          sharedOutrider: {
            modelProfile: 'critic',
            principles: 'Check sources.',
            targets: { kind: 'all' },
          },
        },
      });
    });
    expect(setup.textContent).toContain('comes from Draft writer.');
    expect(setup.textContent).toContain('Shared Outrider advice is set up for the whole team.');
    expect(setup.textContent).toContain('Includes unsaved changes');
    expect(setup.textContent).not.toContain('Saved version');
    await click(named(document, messages.Editor.save));
    expect(setup.textContent).toContain('comes from Draft writer.');
    expect(setup.textContent).toContain('Shared Outrider advice is set up for the whole team.');
    expect(setup.textContent).toContain('Saved version 3');
    expect(setup.textContent).not.toContain('Includes unsaved changes');
  });

  it('opens the authored revision pinned to a reloaded test run instead of the latest saved team', async () => {
    const sessions = new Map<string, RunSessionStore>();
    const source = vi.fn(async () => ({ corralId: 'historical-team', definitionRevision: 7 }));
    const historical = linear('Historical writer').definition;
    historical.sharedOutrider = {
      modelProfile: 'critic',
      principles: 'Check sources.',
      targets: { kind: 'all' },
    };
    const getRevision = vi.fn(async () => historical);
    await mount('route', 1280, (repository, record) => ({
      mode: 'server',
      repository: { ...repository, getRevision },
      editorSessions: sessions,
      transport: {
        getRunDefinition: async () => record.definition,
        getRunSource: source,
        subscribe: () => () => {},
      },
    }));
    const [session] = sessions.values();
    assert(session);
    await act(async () => session.getState().open('reloaded'));
    await prepareRun();
    expect(source).toHaveBeenCalledExactlyOnceWith('reloaded');
    expect(getRevision).toHaveBeenCalledWith('historical-team', 7);
    expect(testRun().textContent).toContain('0 requests · nobody asked');
  });

  it('starts the draft once in mock mode despite the saved live choice, and only restarts a terminal run', async () => {
    const sessions = new Map<string, RunSessionStore>();
    const startRun = vi.fn().mockResolvedValue({ runId: 'run_one' });
    const subscribe = vi.fn(() => vi.fn());
    await mount('route', 1000, (repo, record) => {
      edit(record, repo, linear('Unsaved draft'));
      return {
        live: true,
        runModes: { [JSON.stringify([record.projectId, 'corral', record.corralId])]: 'live' },
        editorSessions: sessions,
        transport: { startRun, subscribe, getRunDefinition: async () => record.definition },
      };
    });
    const header = named(document, 'Mock test');
    await prepareRun();
    expect(shown(named(testRun(), 'Run with real models'))).toBe(true);
    expect(startRun).not.toHaveBeenCalled();
    await click(named(testRun(), 'Close test panel'));
    await act(async () => {
      header.click();
      header.click();
    });
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      definition: { name: 'Unsaved draft' },
      mode: 'mock',
    });
    expect(shown(testRun())).toBe(true);
    expect(shown(region('[data-testid="run-status"]'))).toBe(true);
    await click(named(testRun(), 'Close test panel'));
    expect(shown(testRun())).toBe(false);
    const [session] = sessions.values();
    assert(session);
    const current = session.getState().projection;
    assert(current);
    expect(session.getState().runId).toBe('run_one');
    expect(subscribe.mock.results[0]?.value).not.toHaveBeenCalled();
    await click(header);
    expect(shown(testRun())).toBe(true);
    expect(startRun).toHaveBeenCalledTimes(1);
    await act(async () => session.setState({ projection: { ...current, status: 'succeeded' } }));
    startRun.mockResolvedValue({ runId: 'run_two' });
    await click(header);
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(session.getState().runId).toBe('run_two');
  });

  it('retains the previous run and unsaved draft on a server save failure', async () => {
    const sessions = new Map<string, RunSessionStore>();
    const startRun = vi.fn().mockResolvedValue({ runId: 'previous' });
    let repo!: CorralRepository;
    const draft = await mount('route', 1280, (repository, record) => {
      repo = repository;
      edit(record, repo, linear('First'));
      return {
        mode: 'server',
        editorSessions: sessions,
        transport: {
          startRun,
          subscribe: () => () => {},
          getRunDefinition: async () => record.definition,
        },
      };
    });
    await click(named(document, 'Save and mock test'));
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({ definitionRevision: 2, mode: 'mock' });
    const [session] = sessions.values();
    assert(session);
    const current = session.getState().projection;
    assert(current);
    await act(async () => {
      session.setState({ projection: { ...current, status: 'succeeded' } });
      editorWorkingCopy(repo, fixture.record as CorralRecord)
        .getState()
        .editor.getState()
        .setName('Second');
    });
    const previous = session.getState();
    const unsaved = draft();
    vi.spyOn(repo, 'save').mockRejectedValueOnce(Error('save failed'));
    await click(named(document, 'Save and mock test'));
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(session.getState()).toBe(previous);
    expect(draft()).toBe(unsaved);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('save failed');
  });

  it('waits for pinned references and retries only the failed nested revision', async () => {
    const inner = linear('inner', 'team');
    const reference = inner.definition.nodes.find((n) => n.type === 'team');
    if (reference?.type !== 'team') throw Error('missing fixture reference');
    reference.source = { kind: 'reference', corralId: 'leaf', definitionRevision: 3 };
    reference.label = 'Leaf';
    let release: (definition: typeof inner.definition) => void = () => {};
    const read = vi
      .fn<CorralRepository['getRevision']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(Error('temporary'))
      .mockResolvedValueOnce(linear('leaf').definition);
    await mount('route', 768, (repo, record) => {
      edit(record, repo, linear('outer', 'team'));
      repo.getRevision = read;
      return {};
    });
    await prepareRun();
    expect(document.body.textContent).toContain('Checking referenced teams');
    expect(named(testRun(), 'Start mock test')).toHaveProperty('disabled', true);
    await click(named(testRun(), 'Edit request'));
    expect(shown(sheet())).toBe(true);
    expect(sheet().querySelector('[data-team-brief]')).toBe(document.activeElement);
    await prepareRun();
    expect(named(testRun(), 'Start mock test')).toHaveProperty('disabled', true);
    await act(async () => release(inner.definition));
    await click(named(document, 'Retry'));
    expect(read.mock.calls).toEqual([
      ['inner', 2],
      ['leaf', 3],
      ['leaf', 3],
    ]);
    expect(named(testRun(), 'Start mock test')).toHaveProperty('disabled', false);
    expect(outline().textContent).toContain('No problems');
  });

  it('offers a missing revision’s owning step instead of retrying a missing record', async () => {
    await mount('route', 768, (repo, record) => {
      edit(record, repo, linear('outer', 'team'));
      repo.getRevision = vi.fn().mockResolvedValue(null);
      return {};
    });
    await prepareRun();
    expect(named(testRun(), 'Start mock test')).toHaveProperty('disabled', true);
    const ref = [...document.querySelectorAll<HTMLElement>('button')].find((el) =>
      el.textContent?.includes('Release check · r2'),
    );
    await click(ref as HTMLElement);
    expect(shown(sheet())).toBe(true);
    expect(sheet().querySelector<HTMLInputElement>('[data-node-settings] input')?.value).toBe(
      'Release check',
    );
    expect(named(document, 'Retry')).toBeUndefined();
  });

  it('opens structural problems directly from the header without starting a run', async () => {
    const startRun = vi.fn();
    await mount('route', 768, (repo, record) => {
      edit(record, repo, linear('unknown-model'));
      return {
        transport: { startRun },
        models: {
          catalog: async () => [],
          profiles: async () => [
            { profileId: 'elsewhere', provider: 'local', providerName: 'Local', modelId: 'other' },
          ],
        },
      };
    });
    await click(named(document, 'Mock test'));
    expect(startRun).not.toHaveBeenCalled();
    expect(shown(testRun())).toBe(false);
    expect(shown(sheet())).toBe(true);
    expect(sheet().textContent).toContain('model');
    expect(document.activeElement).toBe(sheet().querySelector('h2'));
  });

  it('keeps an edit made during a server test save and only runs the retried revision', async () => {
    let repo!: CorralRepository;
    const startRun = vi.fn().mockResolvedValue({
      receipt: { error: { code: 'SCHEMA_INVALID', message: 'fixture end' } },
    });
    let release: () => void = () => {};
    await mount('route', 1280, (repository, record) => {
      repo = repository;
      edit(record, repo, linear('A'));
      const save = repository.save.bind(repository);
      vi.spyOn(repository, 'save').mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return save(input);
      });
      return { mode: 'server', transport: { startRun } };
    });
    const start = named(document, 'Save and mock test');
    await act(async () => {
      start.click();
      start.click();
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(startRun).not.toHaveBeenCalled();
    const editor = editorWorkingCopy(repo, fixture.record as CorralRecord).getState().editor;
    await act(async () => {
      editor.getState().setName('B');
      release();
    });
    expect(startRun).not.toHaveBeenCalled();
    expect(editor.getState().draft.definition.name).toBe('B');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(messages.Run.draftChanged);
    await click(named(document, 'Save and mock test'));
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({
      corralId: (fixture.record as CorralRecord).corralId,
      definitionRevision: 3,
      mode: 'mock',
    });
    expect(startRun.mock.calls[0]?.[0]).not.toHaveProperty('definition');
    expect(named(document, 'Mock test')).toBeTruthy();
  });

  it('opens a conversation with the saved check team only after its save succeeds', async () => {
    let repo!: CorralRepository;
    const startRun = vi.fn();
    await mount('route', 1000, (repository, record) => {
      repo = repository;
      edit(record, repo, linear('checked', 'check'));
      vi.spyOn(repo, 'save').mockRejectedValueOnce(Error('save failed'));
      vi.spyOn(repo, 'createSession');
      return { mode: 'server', transport: { startRun } };
    });
    await click(named(document, 'Save and mock test'));
    expect(shown(testRun())).toBe(true);
    expect(testRun().textContent).toContain(messages.Run.checksNeedSession);
    expect(startRun).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    await click(named(testRun(), 'Open conversation with this team'));
    expect(repo.createSession).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    await click(named(testRun(), 'Open conversation with this team'));
    expect(repo.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        corralId: (fixture.record as CorralRecord).corralId,
        projectId: 'project_1',
      }),
    );
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: '/sessions/$sessionId',
      params: { sessionId: 'session_1' },
    });
    expect(startRun).not.toHaveBeenCalled();
  });
  it('returns to the original conversation on the same saved team', async () => {
    fixture.fromSession = 'session_1';
    let repository!: CorralRepository;
    await mount('route', 1000, (repo, record) => {
      repository = repo;
      void repo.createSession({
        projectId: record.projectId,
        corralId: record.corralId,
        title: 'Original',
        objective: 'Keep this context',
      });
      vi.spyOn(repo, 'createSession');
      edit(record, repo, linear('checked', 'check'));
      return { mode: 'server' };
    });
    await click(named(document, 'Save and mock test'));
    await click(named(testRun(), 'Open conversation with this team'));
    expect(repository.createSession).not.toHaveBeenCalled();
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: '/sessions/$sessionId',
      params: { sessionId: 'session_1' },
    });
    expect((await repository.getSession('session_1'))?.objective).toBe('Keep this context');
  });

  it('shows an execution limit without blocking a runnable team', async () => {
    await mount('route', 1000, (repo, record) => {
      const team = linear('cap');
      team.definition.limits.maxSpawns = 1000;
      edit(record, repo, team);
      return {};
    });
    await prepareRun();
    expect(testRun().textContent).toContain(messages.Validation.codes.SPAWNS_CAPPED);
    expect(named(testRun(), 'Start mock test')).toHaveProperty('disabled', false);
  });
});
