// @vitest-environment jsdom
import type { SessionCompactionOutcome, SessionCompactionView } from '@corral/contracts';
import { emptyProjection, type RunProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SessionSummaryStore, type SummaryTimers } from '../sessionSummaryStore.ts';
import { ContextDetail } from './ChatWidgets.tsx';
import { type ChatWidgetModel, ChatWidgetProvider, useChatWidget } from './useChatWidgets.tsx';

// Idle session compaction has no run, so the context detail learns its outcome by reading the
// session's compaction again after the server accepts it.

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#run">{children}</a>,
}));

function manualTimers() {
  const queue = new Map<number, () => void>();
  let next = 0;
  const timers: SummaryTimers = {
    setTimeout: (run) => {
      next += 1;
      queue.set(next, run);
      return next;
    },
    clearTimeout: (handle) => {
      queue.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => queue.size,
    fire: () =>
      act(async () => {
        const runs = [...queue.values()];
        queue.clear();
        for (const run of runs) run();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
  };
}

function projection(
  status: RunProjection['status'],
  executionStatus: string,
  mode: 'live' | 'mock' = 'live',
): RunProjection {
  const value = emptyProjection('run_a');
  value.status = status;
  value.mode = mode;
  value.executionOrder = ['exec_a'];
  value.executions.exec_a = {
    executionId: 'exec_a',
    nodeId: 'assistant',
    taskId: 'task_a',
    status: executionStatus,
    attemptNo: 1,
    modelCallIds: [],
  } as unknown as RunProjection['executions'][string];
  return value;
}

function runStore(value: RunProjection) {
  return createStore(() => ({
    runId: 'run_a',
    projection: value,
    definition: null,
    events: [],
    artifactTexts: {},
    streamError: null,
    missingRunId: null,
    open: vi.fn(async () => {}),
    loadArtifact: vi.fn(async () => {}),
    sendCommand: vi.fn(),
  }));
}

const view: SessionCompactionView = {
  commandId: 'cmd_sent',
  throughRunId: 'run_a',
  coveredRunIds: ['run_a'],
  sessionRevision: 1,
};

type Reply = { compaction: SessionCompactionView | null; outcome: SessionCompactionOutcome | null };

function services(
  value: RunProjection,
  read: (sessionId: string, commandId?: string) => Promise<Reply>,
  timers: SummaryTimers,
) {
  const store = runStore(value);
  const compactSession = vi.fn(async (command: { commandId: string }) => ({
    commandId: command.commandId,
    status: 'accepted' as const,
  }));
  return {
    compactSession,
    services: {
      runFor: () => store,
      sessionFor: () => store,
      retainRun: () => () => {},
      transport: { getArtifactText: vi.fn(async () => null) },
      readHistory: vi.fn(),
      workspaces: null,
      mode: 'server',
      repository: { getSession: vi.fn(async () => ({ revision: 1 })) },
      compactSession,
      sessionSummaries: new SessionSummaryStore(read, timers),
    },
  };
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
function Probe() {
  seen = useChatWidget();
  return seen ? <ContextDetail model={seen} /> : null;
}

async function mount(props: { sessionId: string; live: boolean; sessionRunning: boolean }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const paint = (next: typeof props) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatWidgetProvider
            sessionId={next.sessionId}
            presentationRunId="run_a"
            live={next.live}
            sessionRunning={next.sessionRunning}
            runIds={['run_a']}
          >
            <Probe />
          </ChatWidgetProvider>
        </IntlProvider>,
      ),
    );
  await paint(props);
  return { container, repaint: paint };
}

it('does not offer the session path while the presented run is live but its execution ended', async () => {
  const clock = manualTimers();
  const read = vi.fn(async () => ({ compaction: null, outcome: null }));
  const made = services(projection('running', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  await mount({ sessionId: 'session_a', live: true, sessionRunning: true });
  expect(seen?.compaction?.idle).toBeFalsy();
  expect(seen?.compaction?.reason).toBe('compactNoExecution');
  await act(async () => {
    await seen?.compaction?.request();
  });
  expect(made.compactSession).not.toHaveBeenCalled();
});

it('does not offer the session path while another run in the session is still running', async () => {
  const clock = manualTimers();
  const read = vi.fn(async () => ({ compaction: null, outcome: null }));
  const made = services(projection('succeeded', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  await mount({ sessionId: 'session_a', live: false, sessionRunning: true });
  expect(seen?.compaction?.idle).toBeFalsy();
  expect(seen?.compaction?.reason).toBe('compactNoExecution');
});

it('shows the summary once the accepted compaction completes, without reopening', async () => {
  const clock = manualTimers();
  let settled = false;
  const read = vi.fn(async (_sessionId: string, commandId?: string) =>
    commandId && settled
      ? { compaction: { ...view, commandId }, outcome: { commandId, phase: 'completed' as const } }
      : {
          compaction: null,
          outcome: commandId ? { commandId, phase: 'pending' as const } : null,
        },
  );
  const made = services(projection('succeeded', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  const { container } = await mount({ sessionId: 'session_a', live: false, sessionRunning: false });
  expect(seen?.compaction?.idle).toBe(true);
  expect(container.querySelector('[data-testid="session-summary"]')).toBeNull();
  await act(async () => {
    expect(await seen?.compaction?.request()).toBeNull();
  });
  expect(made.compactSession).toHaveBeenCalledTimes(1);
  expect(seen?.compaction?.pending).toBe(true);
  expect(container.textContent).toContain(messages.RunStatus.compactPhase.started);
  await clock.fire();
  expect(seen?.sessionSummary).toBeNull();
  settled = true;
  await clock.fire();
  expect(seen?.sessionSummary).toMatchObject({ covered: 1 });
  expect(container.querySelector('[data-testid="session-summary"]')).not.toBeNull();
  expect(seen?.compaction?.pending).toBe(false);
  expect(container.textContent).not.toContain(messages.RunStatus.compactPhase.started);
  expect(clock.pending()).toBe(0);
});

it('says a failed compaction failed in the place it showed it was accepted', async () => {
  const clock = manualTimers();
  const read = vi.fn(async (_sessionId: string, commandId?: string) => ({
    compaction: null,
    outcome: commandId ? { commandId, phase: 'failed' as const } : null,
  }));
  const made = services(projection('succeeded', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  const { container } = await mount({ sessionId: 'session_a', live: false, sessionRunning: false });
  await act(async () => {
    await seen?.compaction?.request();
  });
  await clock.fire();
  expect(seen?.compaction?.phase).toBe('failed');
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    messages.RunStatus.compactPhase.failed,
  );
  expect(seen?.sessionSummary).toBeNull();
  expect(clock.pending()).toBe(0);
});

it('a lost compaction is reported as failed rather than waited on forever', async () => {
  const clock = manualTimers();
  const read = vi.fn(async () => ({ compaction: null, outcome: null }));
  const made = services(projection('succeeded', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  await mount({ sessionId: 'session_a', live: false, sessionRunning: false });
  await act(async () => {
    await seen?.compaction?.request();
  });
  await clock.fire();
  expect(seen?.compaction?.phase).toBe('failed');
});

it('stops reading the old session and never applies its result after switching', async () => {
  const clock = manualTimers();
  const read = vi.fn(async (sessionId: string, commandId?: string) =>
    sessionId === 'session_a' && commandId
      ? { compaction: { ...view, commandId }, outcome: { commandId, phase: 'completed' as const } }
      : { compaction: null, outcome: null },
  );
  const made = services(projection('succeeded', 'succeeded'), read, clock.timers);
  fixture.services = made.services;
  const view0 = await mount({ sessionId: 'session_a', live: false, sessionRunning: false });
  await act(async () => {
    await seen?.compaction?.request();
  });
  expect(clock.pending()).toBe(1);
  await view0.repaint({ sessionId: 'session_b', live: false, sessionRunning: false });
  expect(clock.pending()).toBe(0);
  await clock.fire();
  expect(read.mock.calls.some(([, commandId]) => commandId !== undefined)).toBe(false);
  expect(seen?.sessionSummary).toBeNull();
  expect(seen?.compaction?.pending).toBe(false);
  expect(seen?.compaction?.phase).toBeNull();
});
