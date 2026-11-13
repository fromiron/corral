// @vitest-environment jsdom
import { canonicalJson, emptyProjection, type RunProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ComposerActivity } from '../session/ComposerActivity.tsx';
import { type ChatWidgetModel, ChatWidgetProvider, useChatWidget } from './useChatWidgets.tsx';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  archived: null as RunProjection | null,
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../readRunView.ts', () => ({
  readRunView: async (_transport: unknown, _history: unknown, runId: string) => ({
    runId,
    projection: fixture.archived,
    definition: null,
    events: [],
    artifactTexts: {},
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#run" className={className}>
      {children}
    </a>
  ),
}));

const plan = {
  scope: 'execution',
  executionId: 'exec_plan',
  attemptNo: 1,
  revision: 1,
  criteriaVersionId: 'criteria_plan',
  items: [
    { id: 'read', title: 'Read the layout', status: 'completed' },
    { id: 'write', title: 'Write the change', status: 'in_progress' },
  ],
};

async function hashOf(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function projection(status: RunProjection['status']): Promise<RunProjection> {
  const value = emptyProjection('run_plan');
  value.status = status;
  value.executionOrder = ['exec_plan'];
  value.executions.exec_plan = {
    executionId: 'exec_plan',
    nodeId: 'assistant',
    taskId: 'task_plan',
    status: status === 'running' ? 'active' : 'succeeded',
    attemptNo: 1,
    modelCallIds: [],
  } as unknown as RunProjection['executions'][string];
  value.workPlans = {
    plan: {
      scope: 'execution',
      executionId: 'exec_plan',
      attemptNo: 1,
      revision: 1,
      criteriaVersionId: 'criteria_plan',
      bodyRef: 'body_plan',
      bodyHash: await hashOf(plan),
    },
  };
  return value;
}

function runStore(state: Record<string, unknown>) {
  return createStore(() => ({
    runId: null as string | null,
    projection: null as RunProjection | null,
    definition: null,
    events: [],
    artifactTexts: {},
    streamError: null,
    missingRunId: null,
    open: vi.fn(async () => {}),
    loadArtifact: vi.fn(async () => {}),
    ...state,
  }));
}

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

let seen: ChatWidgetModel | null = null;
/** Lets reads, hashing and their state updates settle until `done` holds, or about a second. */
async function settle(done: () => boolean) {
  for (let tick = 0; tick < 100 && !done(); tick++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
function Probe() {
  seen = useChatWidget();
  return (
    <ComposerActivity
      sessionId="session_plan"
      ownActive={null}
      target={null}
      targets={[]}
      onJoin={vi.fn()}
      onStop={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      viewingOther={false}
    />
  );
}

async function mount(live: boolean) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const paint = (isLive: boolean) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatWidgetProvider
            sessionId="session_plan"
            presentationRunId="run_plan"
            live={isLive}
            runIds={['run_plan']}
          >
            <Probe />
          </ChatWidgetProvider>
        </IntlProvider>,
      ),
    );
  await paint(live);
  return { container, repaint: paint };
}

function services(store: ReturnType<typeof runStore>) {
  return {
    runFor: () => store,
    sessionFor: () => store,
    retainRun: () => () => {},
    transport: { getArtifactText: vi.fn(async () => null) },
    readHistory: vi.fn(),
    workspaces: undefined,
    mode: 'server',
  };
}

it('shows no plan chip, and never a load error, for an ended run whose plan body was released', async () => {
  fixture.archived = await projection('succeeded');
  // The session's store holds another run, so this ended run is read from its archive.
  fixture.services = services(runStore({ runId: 'run_other' }));
  const view = await mount(false);
  await settle(() => seen?.readState === 'ready');
  // The archived body read fails, as a released body does; give it time to.
  await settle(() => false);
  expect(seen?.readState).toBe('ready');
  expect(seen?.plan.status.state).toBe('hidden');
  expect(view.container.querySelector('[data-testid="activity-plan"]')).toBeNull();
  expect(view.container.textContent).not.toContain(messages.Widgets.planError);
});

it('keeps the last known done count once the run ends and its plan body is released', async () => {
  const running = await projection('running');
  const store = runStore({
    runId: 'run_plan',
    projection: running,
    artifactTexts: { body_plan: JSON.stringify(plan) },
  });
  fixture.services = services(store);
  const view = await mount(true);
  await settle(() => seen?.plan.status.state === 'ready');
  expect(seen?.plan.status.state).toBe('ready');
  // The run ends and the store moves on; the archive no longer holds the plan body.
  fixture.archived = await projection('succeeded');
  await act(async () => store.setState({ runId: 'run_next', projection: null }));
  await view.repaint(false);
  // The activity bar's idle summary keeps the plan's count.
  const planCount = () => view.container.querySelector('[data-testid="activity-plan"]');
  await settle(() => seen?.readState === 'ready');
  await settle(() => false);
  expect(seen?.readState).toBe('ready');
  expect(planCount()?.textContent).toContain('1/2 done');
  expect(view.container.textContent).not.toContain(messages.Widgets.planError);
});
