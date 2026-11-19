// @vitest-environment jsdom

import type { HarnessBindingRef } from '@corral/contracts';
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
  navigate: vi.fn().mockResolvedValue(undefined),
  fromSession: undefined as string | undefined,
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({
  editorRoute: {
    useLoaderData: () => fixture.record,
    useSearch: () => ({ fromSession: fixture.fromSession }),
  },
  demoRoute: {},
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useBlocker: () => {},
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
  fixture.navigate.mockClear();
  fixture.fromSession = undefined;
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
    transport: {},
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: () => Promise.resolve(),
    models: null,
    harnesses: harness ? { preview: harness.preview, profileManagement: async () => [] } : null,
    live: false,
    persistent: true,
    ...configure?.(repository, record),
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
    await click(named(document, m.testRun));
    expect(document.body.textContent).toContain('Checking referenced teams');
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', true);
    await click(named(testRun(), 'Edit request'));
    expect(shown(sheet())).toBe(true);
    expect(sheet().querySelector('[data-team-brief]')).toBe(document.activeElement);
    await click(named(document, m.testRun));
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', true);
    await act(async () => release(inner.definition));
    await click(named(document, 'Retry'));
    expect(read.mock.calls).toEqual([
      ['inner', 2],
      ['leaf', 3],
      ['leaf', 3],
    ]);
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', false);
    expect(outline().textContent).toContain('No problems');
  });

  it('offers a missing revision’s owning step instead of retrying a missing record', async () => {
    await mount('route', 768, (repo, record) => {
      edit(record, repo, linear('outer', 'team'));
      repo.getRevision = vi.fn().mockResolvedValue(null);
      return {};
    });
    await click(named(document, m.testRun));
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', true);
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

  it('shares a known model error and opens its problem from the narrow test panel', async () => {
    await mount('route', 768, (repo, record) => {
      edit(record, repo, linear('unknown-model'));
      return {
        models: {
          catalog: async () => [],
          profiles: async () => [
            { profileId: 'elsewhere', provider: 'local', providerName: 'Local', modelId: 'other' },
          ],
        },
      };
    });
    await click(named(document, m.testRun));
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', true);
    await click(named(testRun(), 'View problems'));
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
    await click(named(document, m.testRun));
    const start = named(testRun(), 'Run');
    await act(async () => {
      start.click();
      start.click();
    });
    expect(repo.save).toHaveBeenCalledTimes(1);
    const editor = editorWorkingCopy(repo, fixture.record as CorralRecord).getState().editor;
    await act(async () => {
      editor.getState().setName('B');
      release();
    });
    expect(startRun).not.toHaveBeenCalled();
    expect(editor.getState().draft.definition.name).toBe('B');
    await click(named(testRun(), 'Run'));
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0]?.[0]).toMatchObject({ definitionRevision: 3 });
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
    await click(named(document, m.testRun));
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
    await click(named(document, m.testRun));
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
    await click(named(document, m.testRun));
    expect(testRun().textContent).toContain(messages.Validation.codes.SPAWNS_CAPPED);
    expect(named(testRun(), 'Run')).toHaveProperty('disabled', false);
  });
});
