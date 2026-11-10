// @vitest-environment jsdom
import { type CorralDefinition, RunEvent } from '@corral/contracts';
import type {
  ArtifactVersionView,
  CorralRecord,
  ExecutionView,
  RuntimeTransport,
} from '@corral/core';
import { applyEvent, emptyProjection } from '@corral/core';
import { createRunSession, type RunSessionStore } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunResponseArea } from '../workbench/RunResponseArea.tsx';
import { ChatWidgetProvider, useChatWidget } from '../workbench/widgets/useChatWidgets.tsx';
import { RunDetail, type RunDetailSearch } from './RunPage.tsx';

const fixture = vi.hoisted(() => ({ services: {}, replays: 0, pending: 0, batch: 'a' }));
vi.mock('@corral/core', async (original) => {
  const module = await original<typeof import('@corral/core')>();
  return {
    ...module,
    // How many questions or approvals wait for the person; the record itself is not needed here.
    // `batch` names the waiting items, so a test can tell a new one from the same one.
    pendingInteractions: () =>
      Array.from({ length: fixture.pending }, (_, i) => ({
        kind: 'approval',
        approval: { approvalId: `${fixture.batch}_${i}` },
      })),
  };
});
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ runRoute: {} }));
// The real response area, observed: Needs you renders the same component.
vi.mock('../workbench/RunResponseArea.tsx', async (original) => {
  const module = await original<typeof import('../workbench/RunResponseArea.tsx')>();
  return { ...module, RunResponseArea: vi.fn(module.RunResponseArea) };
});
vi.mock('../workbench/RunStatusCards.tsx', () => ({
  ExecutionContext: () => null,
  RunStatusCards: () => (
    <details data-testid="status-card">
      <summary>Context</summary>Scope detail
    </details>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useNavigate: () => () => {},
}));
vi.mock('@corral/react', async (original) => {
  const module = await original<typeof import('@corral/react')>();
  return {
    ...module,
    reconstructRunHistory: (...args: Parameters<typeof module.reconstructRunHistory>) => {
      fixture.replays++;
      return module.reconstructRunHistory(...args);
    },
    RunResults: () => <output data-testid="results">Results</output>,
    ArtifactViewer: ({ versionId }: { versionId: string }) => (
      <output data-testid="artifact">{versionId}</output>
    ),
    ReinsPanel: ({ target }: { target: { executionId: string } | null }) => (
      <section data-testid="reins-probe">
        <span>{target?.executionId ?? 'Missing target'}</span>
        <textarea aria-label="Instruction" />
      </section>
    ),
    RunFlowView: () => <output data-testid="run-flow">Workflow</output>,
    ApprovalPanel: ({ onOpenArtifact }: { onOpenArtifact: (id: string) => void }) => (
      <button type="button" onClick={() => onOpenArtifact('artv_evidence')}>
        Approval evidence
      </button>
    ),
    RunCanvas: ({
      definition,
      session,
      display,
      onSelectNode,
      selectedNodeId,
      renderNodePreview,
    }: {
      definition: CorralDefinition;
      session: RunSessionStore;
      display?: 'map' | 'list';
      onSelectNode: (nodeId: string, trigger?: HTMLElement | null) => void;
      selectedNodeId: string | null;
      renderNodePreview?: (
        nodeId: string,
        controls: { close: () => void; trigger: HTMLElement | null },
      ) => ReactNode;
    }) => {
      const [preview, setPreview] = useState<{ id: string; trigger: HTMLElement } | null>(null);
      return (
        <div>
          <output data-testid="layout">
            {JSON.stringify({ definition, runId: session.getState().runId })}
          </output>
          {/* The real canvas draws the list rows with the same trigger as the map's nodes. */}
          <output data-testid="graph-display">{display ?? 'map'}</output>
          {['worker', 'reviewer'].map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`select-${id}`}
              aria-pressed={selectedNodeId === id}
              onClick={(event) => {
                setPreview({ id, trigger: event.currentTarget });
                onSelectNode(id, event.currentTarget);
              }}
            >
              Select {id}
            </button>
          ))}
          {preview && renderNodePreview ? (
            <div data-testid="node-preview">
              <h3>
                {definition.nodes.find((node) => node.id === preview.id)?.label ?? preview.id}
              </h3>
              {renderNodePreview(preview.id, {
                close: () => setPreview(null),
                trigger: preview.trigger,
              })}
            </div>
          ) : null}
        </div>
      );
    },
  };
});

// jsdom does not scroll; focusing a waiting decision asks it to.
Element.prototype.scrollIntoView ??= () => {};
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  // Browser cases cover measured layout; jsdom needs a visible viewport for lazy views.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.pending = 0;
  fixture.batch = 'a';
});

async function mount(
  corralId: string,
  record: CorralRecord | null,
  search: RunDetailSearch = { view: 'run' },
  request?: string,
  holdNavigation = false,
  agentIds = ['worker'],
  runDefinition?: CorralDefinition,
  runNumber?: number,
) {
  // jsdom has no layout; pointer and resize behavior is checked in the browser.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const definition = runDefinition ?? linearCorral(agentIds, corralId);
  const projection = {
    ...emptyProjection('run_layout'),
    corralId,
    status: 'succeeded' as const,
    startedAt: '2026-10-26T09:05:00.000Z',
    endedAt: '2026-10-26T09:06:30.000Z',
  };
  const transport = {
    listRuns: async () => [],
    getSnapshot: async () => ({ projection, seq: 0 }),
  } as unknown as RuntimeTransport;
  const run = createRunSession(transport);
  run.setState({ runId: projection.runId, definition, projection, open: async () => {} });
  const repository = {
    list: vi.fn(async () => (record ? [{ corralId }] : [])),
    get: vi.fn(async () => record),
  };
  fixture.services = { runFor: () => run, retainRun: () => () => {}, transport, repository };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const navigations: { patch: RunDetailSearch; options: { replace?: boolean } | undefined }[] = [];
  let changeSearch: (patch: RunDetailSearch) => void = () => {};
  function Screen() {
    const [selection, setSelection] = useState(search);
    changeSearch = (patch) => setSelection((current) => ({ ...current, ...patch }));
    return (
      <RunDetail
        runId={projection.runId}
        {...(request ? { request } : {})}
        {...(runNumber ? { runNumber } : {})}
        search={selection}
        setSearch={(patch, options) => {
          navigations.push({ patch, options });
          if (!holdNavigation) setSelection((current) => ({ ...current, ...patch }));
        }}
      />
    );
  }
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Screen />
      </IntlProvider>,
    ),
  );
  return {
    repository,
    container,
    run,
    navigations,
    navigate: (patch: RunDetailSearch) => act(async () => changeSearch(patch)),
  };
}

const graphExecution = (executionId: string, nodeId: string): ExecutionView => ({
  executionId,
  nodeId,
  taskId: `task_${executionId}`,
  attemptNo: 1,
  parentExecutionId: null,
  previousExecutionId: null,
  depth: 0,
  iterationId: null,
  modelProfile: 'model-a',
  configRevision: 0,
  criteriaVersionId: null,
  status: 'active',
  activity: 'model',
  waitingOn: null,
  modelCallIds: [],
  error: null,
});

async function populateGraph(run: RunSessionStore, executions: ExecutionView[]) {
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  const nodeExecutions: Record<string, string[]> = {};
  for (const execution of executions) {
    const ids = nodeExecutions[execution.nodeId] ?? [];
    ids.push(execution.executionId);
    nodeExecutions[execution.nodeId] = ids;
  }
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        status: 'running',
        executionOrder: executions.map((execution) => execution.executionId),
        executions: Object.fromEntries(
          executions.map((execution) => [execution.executionId, execution]),
        ),
        nodeExecutions,
      },
    }),
  );
}

it('workspace opens the graph first and keeps the empty inspector closed even on wide screens', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container } = await mount('inline_team', null, {});
  const selected = container.querySelector('[aria-label="Execution views"] [aria-selected="true"]');
  expect(selected?.textContent).toContain('Graph');
  expect(container.querySelector('[data-testid="layout"]')?.closest('[hidden]')).toBeNull();
  expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
  expect(container.querySelector('[data-testid="run-dock"]')).toBeNull();
});

it('opens a node quick view without opening the inspector or changing execution navigation', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(true);
  const before = navigations.length;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  expect(side?.hidden).toBe(true);
  expect(navigations).toHaveLength(before);
  expect(container.querySelector('[data-testid="node-preview"]')?.textContent).toContain('worker');
});

it('keeps Run info open while quickly checking an agent', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const info = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Run info',
  );
  await act(async () => info?.click());
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('[data-testid="run-facts"]')).not.toBeNull();
  const before = navigations.length;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('[data-testid="run-facts"]')).not.toBeNull();
  expect(navigations).toHaveLength(before);
  expect(container.querySelector('[data-testid="node-preview"]')).not.toBeNull();
});

it.each(['Run info', 'Waiting for you'] as const)(
  'keeps %s open when a deep-linked execution arrives during history replay',
  async (label) => {
    if (label === 'Waiting for you') fixture.pending = 1;
    const { container, run } = await mount('inline_team', null, { execution: 'exec_worker' });
    const control =
      label === 'Run info'
        ? [...container.querySelectorAll('button')].find((button) =>
            button.textContent?.startsWith(label),
          )
        : container.querySelector<HTMLButtonElement>('[data-testid="run-respond"]');
    expect(control).toBeDefined();
    await act(async () => control?.click());
    const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
    expect(side?.hidden).toBe(false);
    expect(side?.querySelector('h2')?.textContent).toBe(label);
    await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
    expect(side?.hidden).toBe(false);
    expect(side?.querySelector('h2')?.textContent).toBe(label);
  },
);

it('does not replace an inspected execution when another agent is quickly checked', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount(
    'inline_team',
    null,
    { execution: 'exec_worker' },
    undefined,
    false,
    ['worker', 'reviewer'],
  );
  await populateGraph(run, [
    graphExecution('exec_worker', 'worker'),
    graphExecution('exec_reviewer', 'reviewer'),
  ]);
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('h2')?.textContent).toBe('worker');
  const before = navigations.length;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-reviewer"]')?.click(),
  );
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('h2')?.textContent).toBe('worker');
  expect(navigations).toHaveLength(before);
  expect(container.querySelector('[data-testid="node-preview"]')?.textContent).toContain(
    'reviewer',
  );
});

it('opens an exact execution detail only after the quick view action and returns focus to its node', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount('inline_team', null, {});
  await populateGraph(run, [
    { ...graphExecution('exec_worker', 'worker'), attemptNo: 2, iterationId: 'round_2' },
  ]);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        iterations: {
          round_2: {
            iterationId: 'round_2',
            loopNodeId: 'loop',
            no: 2,
            criteriaVersionId: 'criteria',
            parentIterationId: null,
            outcome: null,
          },
        },
      },
    }),
  );
  const node = container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]');
  node?.focus();
  await act(async () => node?.click());
  const preview = container.querySelector('[data-testid="node-preview"]');
  expect(preview?.textContent).toContain('Agent execution 1');
  expect(preview?.textContent).toContain('Round 2');
  expect(preview?.textContent).toContain('Attempt 2');
  expect(preview?.textContent).not.toContain('All executions');
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(true);
  const details = [...(preview?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === 'Details',
  );
  expect(details).toBeDefined();
  details?.focus();
  await act(async () => {
    details?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(container.querySelector('[data-testid="node-preview"]')).toBeNull();
  expect(navigations.at(-1)?.patch.execution).toBe('exec_worker');
  expect(side?.hidden).toBe(false);
  expect(side?.contains(document.activeElement)).toBe(true);
  const heading = side?.querySelector('h2')?.parentElement?.textContent ?? '';
  expect(heading).toContain('worker');
  expect(heading).toContain('Agent execution 1');
  expect(heading).toContain('Round 2');
  expect(heading).toContain('Attempt 2');
  const close = side?.querySelector<HTMLButtonElement>('button[aria-label="Close details"]');
  await act(async () => {
    close?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(document.activeElement).toBe(node);
});

it('limits quick executions to three, prioritizing active work and the latest other execution', async () => {
  const { container, run } = await mount('inline_team', null, {});
  await populateGraph(run, [
    { ...graphExecution('old', 'worker'), status: 'succeeded', activity: null },
    graphExecution('active', 'worker'),
    { ...graphExecution('cancelled', 'worker'), status: 'cancelled', activity: null },
    { ...graphExecution('waiting', 'worker'), status: 'waiting_message', activity: null },
    { ...graphExecution('latest', 'worker'), status: 'succeeded', activity: null },
  ]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const preview = container.querySelector('[data-testid="node-preview"]');
  const rows = [...(preview?.querySelectorAll('li') ?? [])];
  expect(rows).toHaveLength(3);
  const firstTwo = rows
    .slice(0, 2)
    .map((row) => row.textContent ?? '')
    .join(' ');
  expect(firstTwo).toContain('Agent execution 2');
  expect(firstTwo).toContain('Agent execution 4');
  expect(rows[2]?.textContent).toContain('Agent execution 5');
  expect(preview?.textContent).not.toContain('Agent execution 1');
  expect(preview?.textContent).not.toContain('Agent execution 3');
  expect(
    [...(preview?.querySelectorAll('button') ?? [])].some((button) =>
      button.textContent?.trim().startsWith('All executions'),
    ),
  ).toBe(true);
});

it('describes each repeated quick action with its own execution identity', async () => {
  const { container, run } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('first', 'worker'), graphExecution('second', 'worker')]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const preview = container.querySelector('[data-testid="node-preview"]');
  for (const [id, number] of [
    ['first', 1],
    ['second', 2],
  ] as const) {
    const row = preview?.querySelector(`[data-execution-id="${id}"]`);
    for (const label of ['Details', 'Give instruction']) {
      const button = [...(row?.querySelectorAll('button') ?? [])].find(
        (item) => item.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      const description = (button?.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .map((reference) => document.getElementById(reference)?.textContent ?? '')
        .join(' ');
      expect(description).toContain(`Agent execution ${number}`);
    }
  }
});

it.each(['run', 'execution'] as const)(
  'keeps details available but hides the quick instruction action when the %s is cancelling',
  async (scope) => {
    const { container, run } = await mount('inline_team', null, {});
    await populateGraph(run, [
      {
        ...graphExecution('exec_worker', 'worker'),
        status: scope === 'execution' ? 'cancelling' : 'active',
      },
      graphExecution('exec_other', 'worker'),
      { ...graphExecution('exec_done', 'worker'), status: 'succeeded', activity: null },
    ]);
    if (scope === 'run') {
      const projection = run.getState().projection;
      if (!projection) throw new Error('Missing projection');
      await act(async () => run.setState({ projection: { ...projection, status: 'cancelling' } }));
    }
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
    );
    const preview = container.querySelector('[data-testid="node-preview"]');
    const row = (id: string) => preview?.querySelector(`[data-execution-id="${id}"]`);
    const buttonNames = (id: string) =>
      [...(row(id)?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim());
    const buttons = buttonNames('exec_worker');
    expect(buttons).toContain('Details');
    expect(buttons).not.toContain('Give instruction');
    expect(buttonNames('exec_other').includes('Give instruction')).toBe(scope === 'execution');
    expect(
      [...(preview?.querySelectorAll('li') ?? [])].map((item) =>
        item.getAttribute('data-execution-id'),
      ),
    ).toEqual(['exec_other', 'exec_worker', 'exec_done']);
  },
);

it('shows a requested agent without inventing an execution or action', async () => {
  const { container, run } = await mount('inline_team', null, {}, undefined, false, [
    'worker',
    'reviewer',
  ]);
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        questions: {
          q: {
            questionId: 'q',
            taskId: 'answer_q',
            senderExecutionId: 'exec_worker',
            targetNodeId: 'reviewer',
            targetRoleId: 'reviewer_role',
            body: 'Private question',
            artifactRefs: [],
            deadline: '2026-11-07T00:00:00.000Z',
            status: 'open',
            answer: null,
          },
        },
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-reviewer"]')?.click(),
  );
  const preview = container.querySelector('[data-testid="node-preview"]');
  expect(preview?.textContent).toContain('This node has not run in this run.');
  expect(preview?.textContent).not.toContain('Private question');
  const names = [...(preview?.querySelectorAll('button') ?? [])].map((button) =>
    button.textContent?.trim(),
  );
  expect(names).not.toContain('Details');
  expect(names).not.toContain('Give instruction');
  expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
});

it('opens the exact readable result in the centre and returns to the previously inspected execution', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount(
    'inline_team',
    null,
    { execution: 'exec_reviewer' },
    undefined,
    false,
    ['worker', 'reviewer'],
  );
  await populateGraph(run, [
    graphExecution('exec_worker', 'worker'),
    graphExecution('exec_reviewer', 'reviewer'),
  ]);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  const draft: ArtifactVersionView = {
    artifactVersionId: 'artv_draft_2',
    artifactId: 'draft',
    version: 2,
    parentVersionId: null,
    name: 'Draft',
    contract: 'draft',
    contentHash: 'hash',
    byteLength: 10,
    authorExecutionId: 'exec_worker',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  };
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        artifacts: {
          artv_draft_2: draft,
          artv_retired: {
            ...draft,
            artifactVersionId: 'artv_retired',
            version: 1,
            bodyAvailable: false,
          },
        },
        tasks: {
          task_exec_worker: {
            taskId: 'task_exec_worker',
            nodeId: 'worker',
            roleId: 'worker_role',
            contract: 'draft',
            status: 'in_progress',
            activeExecutionId: 'exec_worker',
            attemptCount: 1,
            submittedArtifactVersionIds: ['artv_retired', 'artv_draft_2'],
          },
        },
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.querySelector('h2')?.textContent).toBe('reviewer');
  const preview = container.querySelector('[data-testid="node-preview"]');
  const buttons = [...(preview?.querySelectorAll('button') ?? [])];
  expect(buttons.some((button) => /Draft\s*.*v1/i.test(button.textContent ?? ''))).toBe(false);
  const result = buttons.find((button) => /Draft\s*.*v2/i.test(button.textContent ?? ''));
  expect(result).toBeDefined();
  await act(async () => result?.click());
  expect(container.querySelector('[data-testid="node-preview"]')).toBeNull();
  expect(
    ['artifact', 'result'].some(
      (key) => navigations.at(-1)?.patch[key as 'artifact' | 'result'] === 'artv_draft_2',
    ),
  ).toBe(true);
  expect(
    container.querySelector('[data-testid="run-document"] [data-testid="artifact"]')?.textContent,
  ).toBe('artv_draft_2');
  expect(side?.hidden).toBe(true);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-document"] button')?.click(),
  );
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('h2')?.textContent).toBe('reviewer');
});

it('opens the requested execution instruction directly and preserves another execution’s draft', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount(
    'inline_team',
    null,
    { execution: 'exec_worker' },
    undefined,
    false,
    ['worker', 'reviewer'],
  );
  await populateGraph(run, [
    graphExecution('exec_worker', 'worker'),
    graphExecution('exec_reviewer', 'reviewer'),
  ]);
  const instruction = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Give instruction',
  );
  await act(async () => instruction?.click());
  const original = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="reins-probe"] textarea',
  );
  expect(original).not.toBeNull();
  if (original) original.value = 'Keep worker draft';
  const back = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="run-instructions"] button'),
  ].find((button) => button.textContent?.includes('Back to work'));
  await act(async () => back?.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-reviewer"]')?.click(),
  );
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.querySelector('h2')?.textContent).toBe('worker');
  expect(container.querySelector('[data-testid="reins-probe"]')?.textContent).toBe('exec_worker');
  const preview = container.querySelector('[data-testid="node-preview"]');
  const steer = [...(preview?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === 'Give instruction',
  );
  expect(steer).toBeDefined();
  await act(async () => steer?.click());
  expect(container.querySelector('[data-testid="node-preview"]')).toBeNull();
  expect(container.querySelector<HTMLElement>('[data-testid="run-instructions"]')?.hidden).toBe(
    false,
  );
  const probes = [...container.querySelectorAll<HTMLElement>('[data-testid="reins-probe"]')];
  expect(probes.find((probe) => !probe.closest('[hidden]'))?.textContent).toBe('exec_reviewer');
  expect(
    probes.find((probe) => probe.textContent === 'exec_worker')?.querySelector('textarea'),
  ).toBe(original);
  expect(original?.value).toBe('Keep worker draft');
});

it('closes an empty selection inspector when Back removes the execution from the URL', async () => {
  const { container, navigate } = await mount('inline_team', null, { execution: 'exec_past' });
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(false);
  await navigate({ execution: undefined });
  expect(side?.hidden).toBe(true);
});

it('closes a quick-view execution on Back while keeping its agent selected', async () => {
  const { container, run, navigate } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const node = container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]');
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  await act(async () => node?.click());
  const preview = container.querySelector('[data-testid="node-preview"]');
  const details = [...(preview?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === 'Details',
  );
  expect(details).toBeDefined();
  await act(async () => details?.click());
  expect(side?.hidden).toBe(false);
  await navigate({ execution: undefined });
  expect(side?.hidden).toBe(true);
  expect(node?.getAttribute('aria-pressed')).toBe('true');
});

it('returns to the selected agent executions when Back leaves an execution', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigate } = await mount('inline_team', null, {});
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        executionOrder: ['first', 'retry', 'third', 'fourth'],
        nodeExecutions: { worker: ['first', 'retry', 'third', 'fourth'] },
        executions: Object.fromEntries(
          ['first', 'retry', 'third', 'fourth'].map((id, index) => [
            id,
            {
              executionId: id,
              nodeId: 'worker',
              taskId: 'task',
              status: 'succeeded',
              attemptNo: index + 1,
              modelProfile: 'default',
            },
          ]),
        ) as never,
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(true);
  const preview = container.querySelector('[data-testid="node-preview"]');
  const all = [...(preview?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.trim().startsWith('All executions'),
  );
  expect(all).toBeDefined();
  await act(async () => all?.click());
  const list = () => side?.querySelector('[aria-label="worker executions"]');
  expect(list()?.querySelector('[data-execution-id="first"]')).not.toBeNull();
  expect(list()?.querySelector('[data-execution-id="retry"]')).not.toBeNull();
  await act(async () =>
    list()?.querySelector<HTMLButtonElement>('[data-execution-id="retry"] button')?.click(),
  );
  expect(list()).toBeNull();
  expect(side?.hidden).toBe(false);
  await navigate({ execution: undefined });
  expect(side?.hidden).toBe(false);
  expect(list()?.querySelector('[data-execution-id="first"]')).not.toBeNull();
  expect(list()?.querySelector('[data-execution-id="retry"]')).not.toBeNull();
});

it('closes a listed execution and returns focus while URL navigation is pending', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigate } = await mount('inline_team', null, {}, undefined, true);
  await populateGraph(
    run,
    ['first', 'second', 'third', 'fourth'].map((id) => graphExecution(id, 'worker')),
  );
  const node = container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]');
  node?.focus();
  await act(async () => node?.click());
  const preview = container.querySelector('[data-testid="node-preview"]');
  const all = [...(preview?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.trim().startsWith('All executions'),
  );
  expect(all).toBeDefined();
  await act(async () => all?.click());
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  const details = side?.querySelector<HTMLButtonElement>('[data-execution-id="first"] button');
  expect(details).not.toBeNull();
  await act(async () => details?.click());
  await navigate({ execution: 'first' });
  expect(side?.hidden).toBe(false);
  const close = side?.querySelector<HTMLButtonElement>('button[aria-label="Close details"]');
  await act(async () => {
    close?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(side?.hidden).toBe(true);
  expect(document.activeElement).toBe(node);
});

it('does not reopen a completed approval panel when a later decision appears', async () => {
  fixture.pending = 1;
  const { container, run } = await mount('inline_team', null, {});
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-respond"]')?.click(),
  );
  expect(side?.hidden).toBe(false);
  const updatePending = async (pending: number) => {
    fixture.pending = pending;
    const projection = run.getState().projection;
    if (!projection) throw new Error('Missing projection');
    await act(async () =>
      run.setState({ projection: { ...projection, lastSeq: projection.lastSeq + 1 } }),
    );
  };
  await updatePending(0);
  expect(side?.hidden).toBe(true);
  await updatePending(1);
  expect(side?.hidden).toBe(true);
});

it('returns focus to Run info after closing it even if a node was selected earlier', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container } = await mount('inline_team', null, {});
  const node = container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]');
  node?.focus();
  await act(async () => node?.click());
  const info = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Run info',
  );
  info?.focus();
  await act(async () => info?.click());
  const close = container.querySelector<HTMLButtonElement>(
    '[data-testid="run-side"] button[aria-label="Close details"]',
  );
  close?.focus();
  await act(async () => {
    close?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(document.activeElement).toBe(info);
});

it('normalizes a legacy cursor once while a parent update precedes the route commit', async () => {
  const { navigations, navigate } = await mount('inline_team', null, { atSeq: 1 }, undefined, true);
  expect(navigations).toHaveLength(1);
  // The remembered view can update before the asynchronous router commits the URL.
  await navigate({});
  expect(navigations).toHaveLength(1);
  await navigate({ atSeq: undefined });
  await navigate({ atSeq: 1 });
  expect(navigations).toHaveLength(2);
});

it.each([
  { result: 'artv_result' },
  { artifact: 'artv_evidence' },
  { view: 'results' },
] as RunDetailSearch[])(
  'workspace reads an explicit document in the centre without stacking it in the inspector: %j',
  async (search) => {
    const { container } = await mount('inline_team', null, search);
    const document = container.querySelector('[data-testid="results"], [data-testid="artifact"]');
    expect(document?.closest('[data-testid="run-column"]')).not.toBeNull();
    expect(document?.closest('[data-testid="run-side"]')).toBeNull();
    expect(document?.closest('[hidden]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
  },
);

it('workspace preserves the mounted graph and the selected view while opening and closing a result', async () => {
  const { container, navigate } = await mount('inline_team', null, {});
  const graph = container.querySelector('[data-testid="layout"]');
  expect(graph).not.toBeNull();
  await navigate({ result: 'artv_result' });
  expect(graph?.closest('[hidden]')).not.toBeNull();
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click();
  });
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
  expect(graph?.closest('[hidden]')).toBeNull();
  expect(
    container.querySelector('[aria-label="Execution views"] [aria-selected="true"]')?.textContent,
  ).toContain('Graph');
});

it('workspace preserves expanded run info details across documents and its tabs', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, navigate } = await mount('inline_team', null);
  const info = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Run info',
  );
  await act(async () => info?.click());
  const details = container.querySelector<HTMLDetailsElement>('[data-testid="status-card"]');
  expect(details).not.toBeNull();
  if (details) details.open = true;
  await navigate({ result: 'artv_result' });
  expect(details?.isConnected).toBe(true);
  await navigate({ result: undefined });
  expect(container.querySelector('[data-testid="status-card"]')).toBe(details);
  expect(details?.open).toBe(true);
  const tab = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes(name),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(button?.getAttribute('aria-selected')).toBe('true');
  };
  await tab('Usage');
  expect(details?.isConnected).toBe(true);
  await tab('Overview');
  expect(container.querySelector('[data-testid="status-card"]')).toBe(details);
  expect(details?.open).toBe(true);
});

it('an execution detail shows only that execution, in one view without tabs', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, { execution: 'exec_worker' });
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('h2')?.textContent).toBe('worker');
  // Environment, connections, changes and run usage belong to Run info only.
  expect(side?.querySelector('[data-testid="status-card"]')).toBeNull();
  expect(side?.querySelector('[role="tablist"]')).toBeNull();
  // The running execution can still be given an instruction.
  expect(
    [...(side?.querySelectorAll('button') ?? [])].some(
      (button) => button.textContent?.trim() === 'Give instruction',
    ),
  ).toBe(true);
});

it('a finished execution offers no instruction screen', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, { execution: 'exec_worker' });
  await populateGraph(run, [{ ...graphExecution('exec_worker', 'worker'), status: 'succeeded' }]);
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.querySelector('h2')?.textContent).toBe('worker');
  const labels = [...(side?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim());
  expect(labels).not.toContain('Reins');
  expect(labels).not.toContain('Give instruction');
});

it('workspace changes inspected executions without silently retargeting an instruction draft', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigate } = await mount('inline_team', null, {
    execution: 'exec_writer',
  });
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        status: 'running',
        executionOrder: ['exec_writer', 'exec_reviewer'],
        nodeExecutions: { worker: ['exec_writer', 'exec_reviewer'] },
        executions: Object.fromEntries(
          ['exec_writer', 'exec_reviewer'].map((id) => [
            id,
            {
              executionId: id,
              nodeId: 'worker',
              taskId: id,
              status: 'active',
              attemptNo: 1,
              modelProfile: 'default',
            },
          ]),
        ) as never,
      },
    }),
  );
  expect(container.querySelector('[data-testid="reins-probe"]')).toBeNull();
  const instruction = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === 'Give instruction',
  );
  expect(instruction).toBeDefined();
  instruction?.focus();
  expect(document.activeElement).toBe(instruction);
  await act(async () => instruction?.click());
  const draft = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="reins-probe"] textarea',
  );
  expect(draft).not.toBeNull();
  if (draft) draft.value = 'Writer only';
  const back = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="run-instructions"] button'),
  ].find((button) => button.textContent?.includes('Back to work'));
  expect(back).toBeDefined();
  back?.focus();
  expect(document.activeElement).toBe(back);
  await act(async () => {
    back?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(document.activeElement).toBe(instruction);
  expect(container.querySelector('[data-testid="select-worker"]')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const preview = container.querySelector('[data-testid="node-preview"]');
  expect(preview?.querySelector('[data-execution-id="exec_writer"]')).not.toBeNull();
  expect(preview?.querySelector('[data-execution-id="exec_reviewer"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="reins-probe"]')?.textContent).toBe('exec_writer');
  const reviewerDetails = preview?.querySelector<HTMLButtonElement>(
    '[data-execution-id="exec_reviewer"] button',
  );
  expect(reviewerDetails).not.toBeNull();
  await act(async () => reviewerDetails?.click());
  expect(container.querySelector('[data-testid="reins-probe"]')?.textContent).toBe('exec_writer');
  expect(container.querySelector('[data-testid="reins-probe"] textarea')).toBe(draft);
  await navigate({ execution: 'exec_writer' });
  expect(container.querySelector('[data-testid="reins-probe"]')?.textContent).toBe('exec_writer');
  await navigate({ result: 'artv_result' });
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click(),
  );
  expect(container.querySelector('[data-testid="reins-probe"] textarea')).toBe(draft);
  expect(draft?.value).toBe('Writer only');
});

async function openGraph(container: HTMLElement) {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) =>
    element.textContent?.includes('Graph'),
  );
  if (!tab) throw new Error('The Graph tab must exist');
  await act(async () => tab.click());
}

it('an inline run uses its snapshot definition without fetching an unsaved Corral', async () => {
  const { repository, container } = await mount('inline_team', null);
  await openGraph(container);
  expect(repository.get).not.toHaveBeenCalled();
  expect(
    JSON.parse(container.querySelector('[data-testid="layout"]')?.textContent ?? '{}'),
  ).toEqual({
    definition: linearCorral(['worker'], 'inline_team'),
    runId: 'run_layout',
  });
});

it('a saved Corral uses the run snapshot without fetching the saved team', async () => {
  const { repository, container } = await mount('auto_saved', {} as CorralRecord);
  await openGraph(container);
  expect(repository.get).not.toHaveBeenCalled();
  expect(
    JSON.parse(container.querySelector('[data-testid="layout"]')?.textContent ?? '{}'),
  ).toEqual({
    definition: linearCorral(['worker'], 'auto_saved'),
    runId: 'run_layout',
  });
});

it('a removed Corral still displays its own snapshot definition', async () => {
  const { repository, container } = await mount('removed_corral', null);
  await openGraph(container);
  expect(repository.get).not.toHaveBeenCalled();
  expect(
    JSON.parse(container.querySelector('[data-testid="layout"]')?.textContent ?? '{}'),
  ).toEqual({
    definition: linearCorral(['worker'], 'removed_corral'),
    runId: 'run_layout',
  });
});

it('heads the run with its team, start and id over the request, then numbers without cost', async () => {
  const { container } = await mount('inline_team', null, {}, 'Summarise the release');
  const header = container.querySelector('[data-testid="run-header"]');
  expect(header?.querySelector('h2')?.textContent).toBe('Summarise the release');
  expect(header?.querySelector('[data-run-meta]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === 'Run info')?.click(),
  );
  const info = container.querySelector('[data-testid="run-facts"]');
  const meta = info?.querySelector('[data-run-meta]');
  expect(meta?.textContent).toContain('Linear worker');
  expect(meta?.textContent).toContain('9:05');
  expect(meta?.textContent).toContain('run_layout');
  expect(meta?.querySelector('button[aria-label="Copy run ID"]')).not.toBeNull();
  const stats = info?.querySelector('[data-run-stats]');
  expect(stats?.textContent).toContain('0/0 tasks');
  expect(stats?.textContent).toContain('0 tool calls');
  expect(stats?.textContent).toContain('0 model requests');
  expect(header?.textContent).toContain('1:30');
  expect(meta?.closest('[hidden]')).toBeNull();
  expect(header?.textContent).not.toMatch(/\$|cost/i);
  // One explicit information entry opens the inspector; diagnostics do not expand the header.
  expect(header?.querySelector('button[aria-expanded]')).toBeNull();
  // No per-agent summary card: the activity heads carry each execution's state.
  expect(container.querySelector('[data-testid="run-summary-card"]')).toBeNull();
  const unnamed = await mount('inline_team', null, {});
  expect(unnamed.container.querySelector('[data-testid="run-header"] h2')?.textContent).toBe(
    'Linear worker',
  );
});

it('a completed run opens its central graph with the header outside the scrollable workspace', async () => {
  const { container } = await mount('inline_team', null, {});
  const column = container.querySelector('[data-testid="run-column"]');
  expect(column?.querySelector('[data-testid="layout"]')).not.toBeNull();
  expect(column?.querySelector('[data-testid="run-header"]')).toBeNull();
  expect(container.querySelector('[data-testid="run-header"]')).not.toBeNull();
  expect(
    column?.querySelector('[aria-label="Execution views"] [aria-selected="true"]')?.textContent,
  ).toContain('Graph');
  expect(container.querySelector('[role="tree"]')).toBeNull();
  expect(container.querySelector('[data-testid="run-side"]')?.hasAttribute('hidden')).toBe(true);
});

it('a results address opens the result in the central document workspace', async () => {
  for (const search of [{ view: 'results' }, { result: 'artv_result' }] as RunDetailSearch[]) {
    const { container } = await mount('inline_team', null, search);
    expect(container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(true);
    const document = container.querySelector('[data-testid="run-document"]');
    expect(document?.querySelector('[data-testid="results"]')).not.toBeNull();
    expect(document?.closest('[hidden]')).toBeNull();
  }
});

it('shows the selected inspector beside the workspace only when the container fits both', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  const wide = await mount('inline_team', null, { execution: 'worker' });
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(false);
  expect(wide.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    false,
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(999);
  const narrow = await mount('inline_team', null, { execution: 'worker' });
  expect(narrow.container.querySelector<HTMLElement>('[data-testid="run-side"]')?.hidden).toBe(
    false,
  );
  expect(narrow.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    true,
  );
});

it('primary views retain the graph when switching and keep the active view on a repeat press', async () => {
  const { container } = await mount('inline_team', null);
  const tabs = () => [
    ...container.querySelectorAll<HTMLElement>('[aria-label="Execution views"] [role="tab"]'),
  ];
  const tab = async (name: string) => {
    const button = tabs().find((el) => el.textContent?.includes(name));
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  expect(tabs().map((el) => el.textContent)).toEqual([
    expect.stringContaining('Graph'),
    expect.stringContaining('Workflow'),
    expect.stringContaining('Timeline'),
    expect.stringContaining('Events 0'),
    expect.stringContaining('Results'),
  ]);
  const graph = container.querySelector('[data-testid="layout"]');
  await tab('Workflow');
  expect(container.querySelector('[data-testid="run-work-flow"]')?.closest('[hidden]')).toBeNull();
  await tab('Graph');
  expect(container.querySelector('[data-testid="layout"]')).toBe(graph);
  await tab('Graph');
  expect(graph?.closest('[hidden]')).toBeNull();
  expect(
    tabs()
      .find((el) => el.textContent?.includes('Graph'))
      ?.getAttribute('aria-selected'),
  ).toBe('true');
});

it('keeps the timeline view selection across primary workspace switches', async () => {
  const { container } = await mount('inline_team', null);
  const tab = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes(name),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await tab('Timeline');
  await tab('By task');
  const taskTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
    el.textContent?.includes('By task'),
  );
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
  await tab('Workflow');
  await tab('Timeline');
  expect(taskTab?.isConnected).toBe(true);
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
  await tab('Timeline');
  await tab('Timeline');
  expect(taskTab?.isConnected).toBe(true);
  expect(taskTab?.getAttribute('aria-selected')).toBe('true');
});

it('event count updates keep the current tab and mounted filter controls', async () => {
  const { container, run } = await mount('inline_team', null);
  const tab = [
    ...container.querySelectorAll<HTMLElement>('[aria-label="Execution views"] [role="tab"]'),
  ].find((el) => el.textContent?.startsWith('Events'));
  await act(async () => tab?.click());
  const panel = container.querySelector('[data-run-workspace-view="events"]');
  const filter = panel?.querySelector('[role="combobox"]');
  expect(filter).not.toBeNull();
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: 'evt_new',
    runId: 'run_layout',
    runSeq: 1,
    recordedAt: '2026-10-26T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'run.state_changed',
    payload: { from: 'created', to: 'running', reasonCode: 'started' },
  });
  await act(async () => run.setState({ events: [event] }));
  expect(tab?.textContent).toContain('Events 1');
  expect(tab?.getAttribute('aria-selected')).toBe('true');
  expect(panel?.querySelector('[role="combobox"]')).toBe(filter);
});

it('the right panel shows what needs the person only while something waits', async () => {
  const idle = await mount('inline_team', null, { execution: 'worker' });
  const idlePanel = idle.container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(idlePanel?.hidden).toBe(false);
  expect(idlePanel?.querySelector('[data-testid="run-needs-you"]')).toBeNull();
  expect(idlePanel?.textContent).not.toContain('Nothing needs you');
});

it('answers through the shared run response area, leaving receipts to the run header', async () => {
  fixture.pending = 1;
  const area = vi.mocked(RunResponseArea);
  area.mockClear();
  const { container, run } = await mount('inline_team', null);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-respond"]')?.click(),
  );
  expect(area.mock.calls.some(([props]) => props.session === run)).toBe(true);
  expect(area.mock.calls.every(([props]) => !props.receipts)).toBe(true);
  expect(
    container.querySelector('[data-testid="run-side"] [data-testid="run-needs-you"]'),
  ).not.toBeNull();
});

it('pending decisions stay reachable and replace the inspector rather than stacking with details', async () => {
  fixture.pending = 1;
  const { container } = await mount('inline_team', null);
  const panel = () => container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(panel()?.hidden).toBe(true);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-respond"]')?.click(),
  );
  expect(panel()?.hidden).toBe(false);
  expect(panel()?.querySelector('[data-testid="run-needs-you"]')).not.toBeNull();
  expect(panel()?.querySelector('[role="tablist"]')?.closest('[hidden]')).not.toBeNull();
  expect(container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(true);
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Approval evidence'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(true);
  expect(
    container.querySelector('[data-testid="run-document"] [data-testid="artifact"]')?.textContent,
  ).toBe('artv_evidence');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click(),
  );
  expect(panel()?.hidden).toBe(false);
  expect(panel()?.querySelector('[data-testid="run-needs-you"]')?.closest('[hidden]')).toBeNull();
});

it('normalizes an old cursor URL and follows current state without replaying or disabling controls', async () => {
  const { container, run, navigations } = await mount('inline_team', null, { atSeq: 0 });
  expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('Succeeded');
  expect(container.querySelector('fieldset[disabled]')).toBeNull();
  expect(container.querySelector('[data-testid="history-mode"]')).toBeNull();
  expect(navigations.at(-1)).toEqual({ patch: { atSeq: undefined }, options: { replace: true } });
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: 'evt_future',
    runId: 'run_layout',
    runSeq: 1,
    recordedAt: '2026-10-26T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'run.state_changed',
    payload: { from: 'created', to: 'running', reasonCode: 'started' },
  });
  const live = applyEvent(emptyProjection('run_layout'), event);
  await act(async () => run.setState({ projection: live, events: [event] }));
  const replays = fixture.replays;
  await act(async () => {
    for (let i = 0; i < 100; i++)
      run.setState({
        streams: {
          future: { text: String(i), completed: false, broken: false, next: i },
        },
      });
  });
  expect(fixture.replays).toBe(replays);
  expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('Running');
  expect(run.getState().projection).toBe(live);
  expect(container.querySelector('fieldset[disabled]')).toBeNull();
  expect(container.querySelector('[aria-label="View time"]')).toBeNull();
});

it('ended requests are not shown in flight', async () => {
  const live = await mount('inline_team', null);
  const projection = live.run.getState().projection;
  if (!projection) throw new Error('missing fixture');
  await act(async () =>
    live.run.setState({
      projection: {
        ...projection,
        status: 'cancelled',
        modelCalls: { pending: { finished: false } as never },
      },
    }),
  );
  await act(async () =>
    [...live.container.querySelectorAll('button')]
      .find((el) => el.textContent === 'Run info')
      ?.click(),
  );
  expect(live.container.textContent).not.toContain('in flight');
  expect(live.container.textContent).toContain('termination unconfirmed');
});

it('does not list a cancelled tool as a failed step or choose it as the failure destination', async () => {
  const { container, run } = await mount('inline_team', null, { execution: 'worker' });
  const projection = emptyProjection('run_layout');
  projection.status = 'cancelled';
  for (const id of ['stopped', 'failed']) {
    projection.toolCalls[id] = {
      toolCallId: id,
      executionId: 'worker',
      name: 'await_tasks',
      status: 'requested',
      phase: 'failed',
      effectId: id,
      reason: id === 'stopped' ? 'scope cancelled' : 'tool failed',
    };
    projection.effects[id] = {
      effectId: id,
      kind: 'tool',
      scope: 'worker',
      epoch: 1,
      dispatched: true,
      modelCallId: null,
      status: 'settled',
      outcome: id === 'stopped' ? 'cancelled' : 'failed',
    };
  }
  await act(async () => run.setState({ projection }));
  expect.soft(container.querySelector('[data-testid="failed-step-stopped"]')).toBeNull();
  expect(container.querySelector('[data-testid="failed-step-failed"]')).not.toBeNull();

  const stopped = projection.toolCalls.stopped;
  if (!stopped) throw new Error('The cancelled tool fixture is missing');
  stopped.executionId = 'cancelled-execution';
  const widgetRoot = createRoot(document.createElement('div'));
  let destination: string | null | undefined;
  function Probe() {
    destination = useChatWidget()?.failedExecutionId;
    return null;
  }
  cleanup.push(async () => {
    await act(async () => widgetRoot.unmount());
  });
  await act(async () =>
    widgetRoot.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatWidgetProvider
          sessionId="session"
          presentationRunId="run_layout"
          runIds={['run_layout']}
          live={false}
        >
          <Probe />
        </ChatWidgetProvider>
      </IntlProvider>,
    ),
  );
  expect(destination).toBe('worker');
});

// docs/specs/features/fork-and-breakpoints.md: a step's run options in its quick view.
it('starts a new run from a step of a finished run of a saved team', async () => {
  const record = {
    corralId: 'saved_team',
    definition: linearCorral(['worker', 'reviewer'], 'saved_team'),
    definitionRevision: 3,
  } as CorralRecord;
  const { container } = await mount('saved_team', record, {}, undefined, false, [
    'worker',
    'reviewer',
  ]);
  const transport = (fixture.services as { transport: Record<string, unknown> }).transport;
  const startRun = vi.fn(async () => ({ runId: 'run_fork', receipt: {} }));
  transport.startRun = startRun;
  transport.listRuns = async () => [{ runId: 'run_layout', sessionId: 'session_fork' }];
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-reviewer"]')?.click(),
  );
  const fork = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Run again from here',
  );
  expect(fork).toBeDefined();
  expect(container.textContent).not.toContain('Pause before this step');
  await act(async () => fork?.click());
  expect(startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      corralId: 'saved_team',
      definitionRevision: 3,
      sessionId: 'session_fork',
      forkFrom: { runId: 'run_layout', nodeId: 'reviewer' },
    }),
  );
});

it('offers no fork once a later run released the step results', async () => {
  const { container, run } = await mount('saved_team', {} as CorralRecord);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        executions: {
          exec_worker: { ...graphExecution('exec_worker', 'worker'), status: 'succeeded' },
        },
        executionOrder: ['exec_worker'],
        nodeExecutions: { worker: ['exec_worker'] },
        tasks: {
          task_exec_worker: {
            status: 'completed',
            submittedArtifactVersionIds: ['artv_worker'],
          } as never,
        },
        artifacts: {
          artv_worker: { artifactVersionId: 'artv_worker', bodyAvailable: false } as never,
        },
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  expect(container.querySelector('[data-testid="node-preview"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Run again from here');
});

it('sets a breakpoint on a step of a live run', async () => {
  const { container, run } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  const sendCommand = vi.fn(async () => ({}));
  await act(async () => run.setState({ sendCommand } as never));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  const toggle = [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find((el) =>
    el.closest('div')?.textContent?.includes('Pause before this step'),
  );
  expect(toggle).toBeDefined();
  await act(async () => toggle?.click());
  expect(sendCommand).toHaveBeenCalledWith({
    type: 'set_breakpoints',
    payload: { nodeIds: ['worker'] },
  });
  expect(container.textContent).not.toContain('Run again from here');
});

/** worker → Revision (a top-level Loop: reviewer, then the Gate Decision repeats or exits) → output */
function loopTeam(corralId: string): CorralDefinition {
  const definition = linearCorral(['worker', 'reviewer'], corralId);
  definition.nodes = definition.nodes.map((node) =>
    node.id === 'reviewer' ? { ...node, label: 'Reviewer', parentId: 'revision' } : node,
  );
  definition.nodes.push(
    { id: 'revision', type: 'loop', label: 'Revision', maxIterations: 2 },
    {
      id: 'gate',
      type: 'decision',
      label: 'Gate',
      parentId: 'revision',
      mode: 'rule',
      rule: 'required_tasks_submitted',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
    },
  );
  const edge = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ) => ({ id, source, sourcePort, target, targetPort }) as CorralDefinition['controlEdges'][number];
  definition.controlEdges = [
    edge('e1', 'worker', 'out', 'revision', 'enter'),
    edge('e2', 'revision', 'body', 'reviewer', 'in'),
    edge('e3', 'reviewer', 'out', 'gate', 'in'),
    edge('e4', 'gate', 'yes', 'revision', 'exit'),
    edge('e5', 'gate', 'no', 'revision', 'repeat'),
    edge('e6', 'revision', 'next', 'output', 'in'),
  ];
  return definition;
}

/** Opens Run info and its Steps section; returns the section. */
async function openSteps(container: HTMLElement) {
  await act(async () =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === 'Run info')?.click(),
  );
  // The kit's trigger repeats its label for its motion.
  const trigger = [...container.querySelectorAll('button')].find((el) =>
    el.textContent?.startsWith('Steps'),
  );
  expect(trigger).toBeDefined();
  await act(async () => trigger?.click());
  return container.querySelector<HTMLElement>('[data-testid="run-step-options"]');
}

// #193: Run info lists every step a run option applies to, not only the agents seen in the graph.
it('forks a finished run from a top-level Loop listed in Run info', async () => {
  const definition = loopTeam('saved_team');
  const record = { corralId: 'saved_team', definition, definitionRevision: 3 } as CorralRecord;
  const { container } = await mount('saved_team', record, {}, undefined, false, [], definition);
  const transport = (fixture.services as { transport: Record<string, unknown> }).transport;
  const startRun = vi.fn(async () => ({ runId: 'run_fork', receipt: {} }));
  transport.startRun = startRun;
  transport.listRuns = async () => [{ runId: 'run_layout', sessionId: 'session_fork' }];
  const steps = await openSteps(container);
  const rows = [...(steps?.querySelectorAll('li') ?? [])].map((row) => row.textContent);
  expect(rows).toEqual(['workerRun again from here', 'RevisionRun again from here']);
  expect(steps?.textContent).not.toContain('Pause before');
  const fork = [...(steps?.querySelectorAll('li') ?? [])]
    .find((row) => row.textContent?.startsWith('Revision'))
    ?.querySelector('button');
  await act(async () => fork?.click());
  expect(startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      corralId: 'saved_team',
      definitionRevision: 3,
      forkFrom: { runId: 'run_layout', nodeId: 'revision' },
    }),
  );
});

it('pauses a live run before a Decision or a step that has not started yet', async () => {
  const definition = loopTeam('inline_team');
  const { container, run } = await mount('inline_team', null, {}, undefined, false, [], definition);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  const sendCommand = vi.fn(async () => ({}));
  await act(async () =>
    run.setState({
      projection: { ...projection, status: 'running', endedAt: null, breakpoints: ['reviewer'] },
      sendCommand,
    } as never),
  );
  const steps = await openSteps(container);
  const switches = [...(steps?.querySelectorAll<HTMLElement>('[role="switch"]') ?? [])];
  const labelled = (name: string) =>
    switches.find((el) => el.closest('li')?.textContent?.includes(name));
  expect(switches).toHaveLength(3);
  expect(labelled('Reviewer')?.getAttribute('aria-checked')).toBe('true');
  expect(steps?.textContent).not.toContain('Run again from here');
  await act(async () => labelled('Gate')?.click());
  expect(sendCommand).toHaveBeenCalledWith({
    type: 'set_breakpoints',
    payload: { nodeIds: ['reviewer', 'gate'] },
  });
});

// docs/specs/features/execution-monitor.md: the waiting status is the way in, and opens once.
async function waitFor(run: RunSessionStore, pending: number, batch = 'a') {
  fixture.pending = pending;
  fixture.batch = batch;
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        status: pending ? 'awaiting_user' : 'running',
        endedAt: null,
        lastSeq: projection.lastSeq + 1,
      },
    }),
  );
}
const side = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="run-side"]');

it('turns the waiting status into the one way to respond', async () => {
  const { container, run } = await mount('inline_team', null, {});
  await waitFor(run, 2);
  const status = container.querySelector('[data-testid="run-status"]');
  const respond = status?.querySelector<HTMLButtonElement>('[data-testid="run-respond"]');
  expect(respond?.textContent).toContain('2');
  const header = container.querySelector('[data-testid="run-header"]');
  expect(
    [...(header?.querySelectorAll('button') ?? [])].filter((b) =>
      b.textContent?.includes('Needs your input'),
    ),
  ).toEqual([]);
  expect(side(container)?.hidden).toBe(true);
  await act(async () => respond?.click());
  expect(side(container)?.hidden).toBe(false);
  expect(side(container)?.querySelector('[data-testid="run-needs-you"]')).not.toBeNull();
  await waitFor(run, 0);
  expect(container.querySelector('[data-testid="run-respond"]')).toBeNull();
});

it('opens the response area once when a new decision arrives and the side is free', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, {});
  const focused = document.activeElement;
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(false);
  // The panel is titled with the state's own name, as the run's status says it.
  expect(side(container)?.querySelector('h2')?.textContent).toBe(messages.Status.awaiting_user);
  expect(
    side(container)?.querySelector('[data-testid="run-needs-you"]')?.getAttribute('aria-label'),
  ).toBe(messages.Status.awaiting_user);
  expect(document.activeElement).toBe(focused);
  // Closed by the person: the same decision does not bring it back.
  await act(async () =>
    side(container)?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.click(),
  );
  expect(side(container)?.hidden).toBe(true);
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(true);
  // Another decision does.
  await waitFor(run, 1, 'b');
  expect(side(container)?.hidden).toBe(false);
});

it('does not take over Run info or a narrow page for a new decision', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const wide = await mount('inline_team', null, {});
  await act(async () =>
    [...wide.container.querySelectorAll('button')]
      .find((el) => el.textContent === 'Run info')
      ?.click(),
  );
  await waitFor(wide.run, 1);
  expect(side(wide.container)?.querySelector('h2')?.textContent).toBe('Run info');

  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  const narrow = await mount('inline_team', null, {});
  await waitFor(narrow.run, 1);
  expect(side(narrow.container)?.hidden).toBe(true);
});

const frames = (count = 2) =>
  act(async () => {
    for (let i = 0; i < count; i++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
const responseArea = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="run-side"] [data-run-response]');

it('a request to respond opens the response area on a narrow page and focuses it, once', async () => {
  // Narrow: a decision alone never takes the page over, but an explicit request does.
  fixture.pending = 1;
  const area = vi.mocked(RunResponseArea);
  area.mockClear();
  const arriving = await mount('inline_team', null, { view: 'run', respond: true });
  await frames();
  expect(side(arriving.container)?.hidden).toBe(false);
  expect(arriving.container.querySelector<HTMLElement>('[data-testid="run-column"]')?.hidden).toBe(
    true,
  );
  expect(document.activeElement).toBe(responseArea(arriving.container));
  // Answering stays on the shared response area and its run store.
  expect(area.mock.calls.some(([props]) => props.session === arriving.run)).toBe(true);
  // The request is consumed in place, once, without a history entry of its own.
  expect(arriving.navigations.filter(({ patch }) => 'respond' in patch)).toStrictEqual([
    { patch: { respond: undefined }, options: { replace: true } },
  ]);
  // Closed by hand, the same decision does not bring it back.
  await act(async () =>
    side(arriving.container)
      ?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')
      ?.click(),
  );
  expect(side(arriving.container)?.hidden).toBe(true);
  await waitFor(arriving.run, 1);
  expect(side(arriving.container)?.hidden).toBe(true);
});

it('a request to respond reaches a run page that is already open, closing what is in the way', async () => {
  fixture.pending = 1;
  const { container, navigate, navigations } = await mount('inline_team', null, {
    artifact: 'artv_evidence',
  });
  expect(side(container)?.hidden).toBe(true);
  await navigate({ respond: true });
  await frames();
  expect(side(container)?.hidden).toBe(false);
  expect(container.querySelector<HTMLElement>('[data-testid="run-document"]')?.hidden).toBe(true);
  expect(document.activeElement).toBe(responseArea(container));
  expect(navigations.filter(({ patch }) => 'respond' in patch)).toStrictEqual([
    {
      patch: { respond: undefined, artifact: undefined, result: undefined, view: undefined },
      options: { replace: true },
    },
  ]);
});

it('a request to respond that finds nothing waiting leaves the page as it was', async () => {
  const { container, run, navigate, navigations } = await mount('inline_team', null, {});
  // Until the history is read, the request waits for what it may find.
  await act(async () => run.setState({ initialLoadSeq: null }));
  await navigate({ respond: true });
  await frames();
  expect(navigations).toEqual([]);
  await act(async () => run.setState({ initialLoadSeq: undefined }));
  await frames();
  expect(side(container)?.hidden).toBe(true);
  expect(navigations).toStrictEqual([
    { patch: { respond: undefined }, options: { replace: true } },
  ]);
  // A decision arriving later on a narrow page follows the ordinary rule.
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(true);
});

it('a decision first seen behind a document opens the response area when the document closes', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigate } = await mount('inline_team', null, { result: 'artv_result' });
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(true);
  await navigate({ result: undefined, view: undefined });
  expect(side(container)?.hidden).toBe(false);
  expect(side(container)?.querySelector('[data-testid="run-needs-you"]')).not.toBeNull();
  // Once opened for it, closing it by hand is final for that decision.
  await act(async () =>
    side(container)?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.click(),
  );
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(true);
});

it('a response area opened by hand stays closed once closed, even after Run info was in the way', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, {});
  await act(async () =>
    [...container.querySelectorAll('button')].find((el) => el.textContent === 'Run info')?.click(),
  );
  await waitFor(run, 1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="run-respond"]')?.click(),
  );
  expect(side(container)?.querySelector('[data-testid="run-needs-you"]')?.closest('[hidden]')).toBe(
    null,
  );
  await act(async () =>
    side(container)?.querySelector<HTMLButtonElement>('[aria-label="Close details"]')?.click(),
  );
  await waitFor(run, 1);
  expect(side(container)?.hidden).toBe(true);
});

const viewTab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[aria-label="Execution views"] [role="tab"]')].find(
    (el) => el.textContent?.startsWith(name),
  );

const chooseDisplay = async (container: HTMLElement, name: string) => {
  const toggle = container.querySelector<HTMLElement>('[role="group"][aria-label="Graph display"]');
  expect(toggle).not.toBeNull();
  const option = [...(toggle?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === name,
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
  return option;
};

it('switches the graph between its map and list, keeping the choice across views and new events', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, {});
  const display = () => container.querySelector('[data-testid="graph-display"]')?.textContent;
  expect(display()).toBe('map');
  const list = await chooseDisplay(container, 'List');
  expect(display()).toBe('list');
  expect(list?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => viewTab(container, 'Workflow')?.click());
  await act(async () => viewTab(container, 'Graph')?.click());
  expect(display()).toBe('list');
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  expect(display()).toBe('list');
  const map = await chooseDisplay(container, 'Map');
  expect(display()).toBe('map');
  expect(map?.getAttribute('aria-pressed')).toBe('true');
});

it('choosing a list row is choosing its node and keeps the open right panel', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount('inline_team', null, {});
  await populateGraph(run, [graphExecution('exec_worker', 'worker')]);
  await chooseDisplay(container, 'List');
  const info = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Run info',
  );
  await act(async () => info?.click());
  const side = container.querySelector<HTMLElement>('[data-testid="run-side"]');
  expect(side?.querySelector('[data-testid="run-facts"]')).not.toBeNull();
  const before = navigations.length;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="select-worker"]')?.click(),
  );
  expect(side?.hidden).toBe(false);
  expect(side?.querySelector('[data-testid="run-facts"]')).not.toBeNull();
  expect(navigations).toHaveLength(before);
  expect(container.querySelector('[data-testid="node-preview"]')?.textContent).toContain('worker');
});

async function withResults(run: RunSessionStore, status: 'succeeded' | 'running' = 'succeeded') {
  await populateGraph(run, [
    { ...graphExecution('exec_worker', 'worker'), iterationId: 'round_2', status: 'succeeded' },
  ]);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  const version = (id: string, name: string, number: number): ArtifactVersionView => ({
    artifactVersionId: id,
    artifactId: name.toLowerCase(),
    version: number,
    parentVersionId: null,
    name,
    contract: 'draft',
    contentHash: `hash_${id}`,
    byteLength: 10,
    authorExecutionId: 'exec_worker',
    modelCallId: null,
    contextSnapshotId: null,
    submitted: true,
    configRevision: 0,
    criteriaVersionId: null,
    inputArtifactVersionIds: [],
  });
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        status,
        iterations: {
          round_2: {
            iterationId: 'round_2',
            loopNodeId: 'loop',
            no: 2,
            criteriaVersionId: 'criteria',
            parentIterationId: null,
            outcome: null,
          },
        },
        artifacts: {
          artv_draft_1: version('artv_draft_1', 'Draft', 1),
          artv_draft_2: version('artv_draft_2', 'Draft', 2),
          artv_report: version('artv_report', 'Report', 1),
        },
        output: { nodeId: 'output', artifactVersionIds: ['artv_report'] },
      },
    }),
  );
}

it('lists every result version with its source execution and opens it in the centre, then Back returns to the list', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigations } = await mount('inline_team', null, {});
  await withResults(run);
  // No results-only strip: what the run made is read in its own view.
  const column = container.querySelector<HTMLElement>('[data-testid="run-column"]');
  expect(
    [...(column?.querySelectorAll<HTMLElement>('[aria-label="Results"]') ?? [])].filter(
      (element) =>
        element.dataset.testid !== 'run-document' &&
        !element.closest('[data-run-workspace-view="results"]'),
    ),
  ).toEqual([]);
  await act(async () => viewTab(container, 'Results')?.click());
  const view = container.querySelector<HTMLElement>('[data-run-workspace-view="results"]');
  expect(view?.closest('[hidden]')).toBeNull();
  const rows = [...(view?.querySelectorAll<HTMLElement>('[data-result-version]') ?? [])];
  expect(rows.map((row) => row.dataset.resultVersion)).toEqual([
    'artv_report',
    'artv_draft_2',
    'artv_draft_1',
  ]);
  for (const row of rows) {
    expect(row.textContent).toContain('worker · Round 2 · Attempt 1');
    expect(row.textContent).not.toMatch(/token|cost|\$/i);
  }
  expect(rows[0]?.textContent).toContain('Report');
  expect(rows[0]?.textContent).toContain('v1');
  expect(rows[1]?.textContent).toContain('v2');
  const open = rows[0]?.querySelector<HTMLButtonElement>('button');
  open?.focus();
  await act(async () => {
    open?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(navigations.at(-1)?.patch.result).toBe('artv_report');
  const reader = container.querySelector<HTMLElement>('[data-testid="run-document"]');
  expect(reader?.hidden).toBe(false);
  expect(reader?.querySelector('[data-testid="results"]')).not.toBeNull();
  await act(async () => {
    [...(reader?.querySelectorAll('button') ?? [])]
      .find((el) => el.textContent?.includes('Back to work'))
      ?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(reader?.hidden).toBe(true);
  expect(viewTab(container, 'Results')?.getAttribute('aria-selected')).toBe('true');
  expect(view?.closest('[hidden]')).toBeNull();
  expect(document.activeElement).toBe(open);
});

it('opens an intermediate version with the artifact reader and Back returns to the list', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run, navigate } = await mount('inline_team', null, {});
  // While the run goes on, the latest draft is still readable; the earlier one is not.
  await withResults(run, 'running');
  await act(async () => viewTab(container, 'Results')?.click());
  expect(container.querySelector('[data-result-version="artv_draft_1"] button')).toBeNull();
  expect(container.querySelector('[data-result-version="artv_draft_1"]')?.textContent).toContain(
    'Text no longer kept',
  );
  const draft = container.querySelector<HTMLButtonElement>(
    '[data-result-version="artv_draft_2"] button',
  );
  await act(async () => draft?.click());
  expect(
    container.querySelector('[data-testid="run-document"] [data-testid="artifact"]')?.textContent,
  ).toBe('artv_draft_2');
  // Browser Back drops the version from the address.
  await navigate({ artifact: undefined });
  expect(container.querySelector<HTMLElement>('[data-testid="run-document"]')?.hidden).toBe(true);
  expect(viewTab(container, 'Results')?.getAttribute('aria-selected')).toBe('true');
});

it('names the run by its session number and request, or its team when nothing was requested', async () => {
  const asked = await mount(
    'inline_team',
    null,
    {},
    'Summarise the release',
    false,
    ['worker'],
    undefined,
    3,
  );
  expect(asked.container.querySelector('[data-testid="run-header"] h2')?.textContent).toBe(
    '#3 · Summarise the release',
  );
  const unnamed = await mount('inline_team', null, {}, undefined, false, ['worker'], undefined, 3);
  expect(unnamed.container.querySelector('[data-testid="run-header"] h2')?.textContent).toBe(
    '#3 · Linear worker',
  );
});

it('reads run usage only in Run info › Usage, split by agent', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400);
  const { container, run } = await mount('inline_team', null, {});
  await populateGraph(run, [
    { ...graphExecution('exec_worker', 'worker'), status: 'succeeded', modelCallIds: ['call_a'] },
  ]);
  const projection = run.getState().projection;
  if (!projection) throw new Error('Missing projection');
  await act(async () =>
    run.setState({
      projection: {
        ...projection,
        modelCalls: {
          call_a: {
            modelCallId: 'call_a',
            executionId: 'exec_worker',
            contextSnapshotId: 'ctx',
            profile: 'model-a',
            configRevision: 0,
            directiveIds: [],
            inputArtifactVersionIds: [],
            finished: true,
            usage: {
              inputTokens: 10,
              outputTokens: 321,
              cachedInputTokens: null,
              reasoningTokens: null,
            },
            rawUsage: null,
            certainty: 'reported',
          },
        },
      },
    }),
  );
  const info = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Run info',
  );
  await act(async () => info?.click());
  const usageTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
    el.textContent?.includes('Usage'),
  );
  expect(usageTab).toBeDefined();
  await act(async () => usageTab?.click());
  const table = container.querySelector('table[aria-label="Usage by agent"]');
  expect(table?.closest('[hidden]')).toBeNull();
  expect(table?.textContent).toContain('worker');
  expect(table?.textContent).toContain('321');
  // The usage panel is the only place on the run page with the run's usage.
  const shown = [...container.querySelectorAll<HTMLElement>('*')].filter(
    (element) =>
      element.children.length === 0 &&
      element.textContent?.includes('321') &&
      !element.closest('[role="tabpanel"][data-value="usage"], [data-run-usage]'),
  );
  expect(shown).toEqual([]);
});
