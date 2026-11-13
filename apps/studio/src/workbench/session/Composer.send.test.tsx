// @vitest-environment jsdom
import type { TextAttachment } from '@corral/contracts';
import type { RunProjection, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { createTextAttachment, emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../../commandRegistry.ts';
import { changePreferences } from '../preferences.ts';
import { writeComposerDraft } from '../sessionDraft.ts';
import { Composer } from './Composer.tsx';

// features/composer-flow.md "전송", "합류 대상", "대기 요청과 넘겨받기": what the composer sends
// while a run goes, where it goes, and that the server, not the page, starts queued requests.

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  navigate: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({ sessionRoute: {}, runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
  useNavigate: () => fixture.navigate,
  useRouter: () => ({
    invalidate: fixture.invalidate,
    state: { location: { href: '/sessions/session' } },
  }),
}));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../useModels.ts', () => ({
  useModelProfiles: () => null,
  useTeamRoles: () => [],
}));
vi.mock('../useMentionSearch.ts', () => ({ useMentionSearch: () => async () => [] }));

// jsdom has no Web Animations; the kit's menus and scroll areas ask for them.
Element.prototype.getAnimations ??= () => [];

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setCommands('composer', null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const baseSession: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: null,
  auto: { modelProfile: 'model-a' },
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 3,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries: [],
};
const running: RunSummary = {
  runId: 'run_live',
  status: 'running',
  corralId: 'auto',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-13T00:00:00Z',
};
const ended: RunSummary = { ...running, status: 'succeeded' };

function execution(id: string, nodeId: string, status: string) {
  return {
    executionId: id,
    nodeId,
    taskId: `task_${id}`,
    attemptNo: 1,
    status,
    activity: null,
    waitingOn: null,
    modelCallIds: [],
    error: null,
  } as never;
}

function projection(executions: Record<string, string> = { exec_writer: 'active' }) {
  const value = emptyProjection('run_live');
  value.status = 'running';
  value.executionOrder = Object.keys(executions);
  for (const [id, status] of Object.entries(executions))
    value.executions[id] = execution(id, id.replace('exec_', ''), status);
  return value;
}

function definition() {
  const corral = linearCorral(['writer', 'review']);
  return {
    ...corral,
    nodes: corral.nodes.map((node) => ({
      ...node,
      label: node.id === 'writer' ? 'Writer' : node.id === 'review' ? 'Review' : node.label,
    })),
  };
}

type RunState = {
  runId: string;
  projection: RunProjection | null;
  definition: ReturnType<typeof definition> | null;
  streamError: string | null;
  missingRunId: string | null;
  open: (runId: string) => Promise<void>;
};

async function mount({
  active = running as RunSummary | null,
  executions = { exec_writer: 'active' } as Record<string, string>,
  session = baseSession,
  queued = [] as SessionEntry[],
  sendKey,
}: {
  active?: RunSummary | null;
  executions?: Record<string, string>;
  session?: WorkSession;
  queued?: SessionEntry[];
  sendKey?: 'enter' | 'mod-enter';
} = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  changePreferences({ sendKey: sendKey ?? 'enter' });
  const store: StoreApi<RunState> = createStore<RunState>(() => ({
    runId: 'run_live',
    projection: projection(executions),
    definition: definition(),
    streamError: null,
    missingRunId: null,
    open: vi.fn(async () => {}),
  }));
  const sendCommand = vi.fn(async (command: { commandId: string }) => ({
    commandId: command.commandId,
    runId: 'run_live',
    status: 'queued',
    acceptedSeq: 4,
    target: 'execution:exec_writer',
    requestedBoundary: 'next_request',
    relatedEventIds: [],
  }));
  let current = session;
  const repository = {
    getSession: vi.fn(async () => ({ ...current, entries: [...current.entries, ...queued] })),
    get: vi.fn(async () => null),
    addSessionEntry: vi.fn(async (_sessionId: string, _entry: unknown) => ({
      ok: true,
      session: current,
    })),
    updateSessionEntry: vi.fn(async () => ({ ok: true, session: current })),
    updateSession: vi.fn(async (_sessionId: string, change: { autoStart?: boolean }) => {
      current = { ...current, ...change, revision: current.revision + 1 };
      return { ok: true, session: current };
    }),
  };
  const startAuto = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
    runId: 'run_new',
    receipt: { commandId: 'x', accepted: true },
    autoRoute: null,
  }));
  fixture.services = {
    repository,
    transport: {
      sendCommand,
      getSnapshot: vi.fn(async () => ({ projection: store.getState().projection, seq: 1 })),
      getRunDefinition: vi.fn(async () => definition()),
    },
    runFor: () => store,
    retainRun: () => () => {},
    mode: 'server',
    live: true,
    workspaceId: 'host',
    workspaces: null,
    voice: null,
    startAuto,
    startExplain: vi.fn(),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (run: RunSummary | null, next: WorkSession = current) => {
    current = next;
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Composer
            session={next}
            team={null}
            corrals={[]}
            runs={run ? [run] : []}
            active={run}
            selectedRunId={run?.runId ?? null}
            queued={queued}
            onChange={() => {}}
            reference={null}
            onReferenceUsed={() => {}}
          />
        </IntlProvider>,
      ),
    );
  };
  await render(active);
  const box = () => container.querySelector('textarea') as HTMLTextAreaElement;
  const type = async (value: string) => {
    await act(async () => {
      box().focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        box(),
        value,
      );
      box().setSelectionRange(value.length, value.length);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = async (init: KeyboardEventInit = {}) => {
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      );
    });
    await act(async () => {});
  };
  const keysLine = () => container.querySelector('[data-slot="composer-keys"]');
  const targetButton = () =>
    container.querySelector<HTMLButtonElement>('[data-slot="composer-target"]');
  return {
    container,
    store,
    sendCommand,
    repository,
    startAuto,
    render,
    type,
    press,
    keysLine,
    targetButton,
  };
}

const steerPayload = (sendCommand: ReturnType<typeof vi.fn>) =>
  (sendCommand.mock.calls.at(-1)?.[0] as { payload: Record<string, unknown> } | undefined)?.payload;

describe('sending while a run goes', () => {
  it('the send key joins the execution writing the answer at its next request', async () => {
    const f = await mount();
    expect(f.targetButton()?.textContent).toContain('Writer');
    await f.type('Run the tests too');
    await f.press();
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(f.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: 'steer',
      runId: 'run_live',
      payload: {
        targetExecutionId: 'exec_writer',
        text: 'Run the tests too',
        delivery: 'next_request',
      },
    });
    expect(f.startAuto).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ intent: 'steer', state: 'sent', executionId: 'exec_writer' }),
    );
  });

  it('the interrupt key interrupts, Alt+Enter queues a next request', async () => {
    const f = await mount();
    await f.type('Look at session.ts');
    await f.press({ ctrlKey: true });
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
    await f.type('Then write the summary');
    await f.press({ altKey: true });
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(f.repository.addSessionEntry).toHaveBeenLastCalledWith(
      'session',
      expect.objectContaining({
        intent: 'queue',
        state: 'queued',
        text: 'Then write the summary',
        start: { choice: { modelProfile: 'model-a' }, team: 'none', mode: 'live' },
      }),
    );
  });

  it('with Mod+Enter as the send key, Mod+Shift+Enter interrupts', async () => {
    const f = await mount({ sendKey: 'mod-enter' });
    await f.type('Shorter');
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    await f.press({ ctrlKey: true, shiftKey: true });
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
  });

  it('offers no interrupt to a target that cannot be cut: its interrupt key joins', async () => {
    const f = await mount({ executions: { exec_writer: 'waiting_children' } });
    expect(f.keysLine()?.textContent).not.toContain(messages.Composer.keyHint.interrupt);
    await f.type('Shorter');
    await f.press({ ctrlKey: true });
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'next_request' });
  });

  it('says a waiting target reads the instruction after the decision', async () => {
    const f = await mount({ executions: { exec_writer: 'waiting_approval' } });
    expect(f.targetButton()?.textContent).toContain(
      messages.Composer.targetAwaiting.replace('{name}', 'Writer'),
    );
    await f.type('Use the smaller fix');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({
      targetExecutionId: 'exec_writer',
      delivery: 'next_request',
    });
  });

  it('queues with every key while nothing can take an instruction, and says why', async () => {
    const f = await mount({ executions: { exec_writer: 'succeeded' } });
    expect(f.targetButton()).toBeNull();
    expect(f.container.textContent).toContain(messages.Composer.targetNone);
    await f.type('Next thing');
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ intent: 'queue', state: 'queued' }),
    );
  });

  it('carries a text attachment on a join', async () => {
    const attachment: TextAttachment = createTextAttachment('notes.md', 'text/markdown', 'notes');
    writeComposerDraft('session', {
      text: 'Use these notes',
      intent: null,
      target: null,
      targetLabel: null,
      references: [],
      attachments: [attachment],
    });
    const f = await mount();
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({
      delivery: 'next_request',
      attachments: [attachment],
    });
  });

  it('/interrupt chooses an interrupt for the next send only', async () => {
    const f = await mount();
    await f.type('/');
    const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
      node.textContent?.includes('/interrupt'),
    );
    expect(option, document.body.textContent ?? '').toBeDefined();
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await f.type('Stop and look at session.ts');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
  });
});

describe('the target', () => {
  it('is fixed once a chosen target has text; when it ends, sending is blocked, never moved', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await act(async () => f.targetButton()?.click());
    const review = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(
      (node) => node.textContent?.includes('Review'),
    ) as HTMLElement | undefined;
    expect(review, document.body.textContent ?? '').toBeDefined();
    await act(async () => review?.click());
    await f.type('Check the edge case');
    await act(async () => {
      f.store.setState({
        projection: projection({ exec_writer: 'active', exec_review: 'succeeded' }),
      });
    });
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
    expect(f.container.querySelector('[data-testid="intent-blocked"]')).not.toBeNull();
  });

  it('a draft without a chosen target joins the lead when a run starts', async () => {
    const f = await mount({ active: null });
    await f.type('Keep going');
    await f.render(running);
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ targetExecutionId: 'exec_writer' });
  });

  it('a draft without a chosen target is a new request when the run ends', async () => {
    const g = await mount({ active: running });
    await g.type('Next part');
    await g.render(ended);
    await g.press();
    expect(g.startAuto).toHaveBeenCalledTimes(1);
  });
});

describe('the key line', () => {
  it('is there with only Send while nothing runs, and with the three keys while a run goes', async () => {
    const f = await mount({ active: null });
    expect(f.keysLine()?.textContent).toContain(messages.Composer.keyHint.new);
    expect(f.keysLine()?.textContent).not.toContain(messages.Composer.keyHint.join);
    await f.render(running);
    for (const kind of ['join', 'interrupt', 'queue'] as const)
      expect(f.keysLine()?.textContent).toContain(messages.Composer.keyHint[kind]);
  });

  it('keeps the send button named Send and describes the send', async () => {
    const f = await mount();
    const send = f.container.querySelector('button[aria-label="Send"]');
    expect(send).not.toBeNull();
    expect(send?.getAttribute('aria-description')).toContain(messages.Composer.sendAs.join);
  });
});

describe('queued requests', () => {
  const queuedEntry: SessionEntry = {
    entryId: 'entry_1',
    intent: 'queue',
    text: 'Run the tests too',
    createdAt: '2026-11-13T00:00:00Z',
    state: 'queued',
    runId: null,
    executionId: null,
    detail: null,
    start: { choice: { modelProfile: 'model-a' }, team: 'none', mode: 'live' },
  };

  it('are not started by the page when the run ends: the server starts them', async () => {
    const f = await mount({ queued: [queuedEntry] });
    await f.render(ended);
    await f.render(null);
    await act(async () => {});
    expect(f.startAuto).not.toHaveBeenCalled();
  });

  it('auto start is the session setting, saved with the session and read back', async () => {
    const f = await mount({ queued: [queuedEntry] });
    const toggle = f.container.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle?.click());
    expect(f.repository.updateSession).toHaveBeenCalledWith('session', {
      autoStart: false,
      expectedRevision: 3,
    });
    await f.render(running, { ...baseSession, autoStart: false, revision: 4 });
    expect(f.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(
      Object.keys(window.localStorage).some((key) => key.startsWith('corral:auto-queue')),
    ).toBe(false);
  });

  it('a new request records the start the server would use', async () => {
    const f = await mount({ active: null });
    await f.type('First request');
    await f.press();
    expect(f.repository.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        intent: 'next',
        start: { choice: { modelProfile: 'model-a' }, team: 'none', mode: 'live' },
      }),
    );
  });
});
