// @vitest-environment jsdom
import type { ImageAttachment, RunReference, TextAttachment } from '@corral/contracts';
import type { RunProjection, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { createTextAttachment, emptyProjection, queuedSessionCommandId } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../../commandRegistry.ts';
import { changePreferences } from '../preferences.ts';
import { editRequest } from '../RefusalHelp.tsx';
import { readComposerDraft, writeComposerDraft } from '../sessionDraft.ts';
import { Composer } from './Composer.tsx';
import { menuSends } from './composer/SendControls.tsx';

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

function projection(
  executions: Record<string, string> = { exec_writer: 'active' },
  runId = 'run_live',
  status: RunProjection['status'] = 'running',
) {
  const value = emptyProjection(runId);
  value.status = status;
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
  pendingCommandIds: string[];
  sendCommand: (command: Record<string, unknown>) => Promise<unknown>;
};

async function mount({
  active = running as RunSummary | null,
  executions = { exec_writer: 'active' } as Record<string, string>,
  session = baseSession,
  queued = [] as SessionEntry[],
  sendKey,
  mode = 'server',
  runState = {},
  folderAccess,
  workspaces = null,
}: {
  active?: RunSummary | null;
  executions?: Record<string, string>;
  session?: WorkSession;
  queued?: SessionEntry[];
  sendKey?: 'enter' | 'mod-enter';
  mode?: 'server' | 'browser';
  /** The run's record as the store holds it at first. */
  runState?: Partial<RunState>;
  folderAccess?: 'copy' | 'unlinked';
  /** The server's files and images; none in a browser demo. */
  workspaces?: Record<string, unknown> | null;
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
  // The run's command path, as the run store keeps it: an id, the command pending until its
  // receipt, then the transport.
  let issued = 0;
  const storeSend = vi.fn(async (command: Record<string, unknown>) => {
    const commandId = `cmd_run_${++issued}`;
    store.setState({ pendingCommandIds: [...store.getState().pendingCommandIds, commandId] });
    try {
      return await sendCommand({
        ...command,
        schemaVersion: '0.1',
        commandId,
        runId: store.getState().runId,
      });
    } finally {
      store.setState({
        pendingCommandIds: store.getState().pendingCommandIds.filter((id) => id !== commandId),
      });
    }
  });
  const store: StoreApi<RunState> = createStore<RunState>(() => ({
    runId: 'run_live',
    projection: projection(executions),
    definition: definition(),
    streamError: null,
    missingRunId: null,
    events: [],
    open: vi.fn(async () => {}),
    pendingCommandIds: [],
    sendCommand: storeSend,
    ...runState,
  }));
  const sendCommand = vi.fn(async (command: { commandId: string } & Record<string, unknown>) => ({
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
    mode,
    live: true,
    workspaceId: 'host',
    workspaces,
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
            {...(folderAccess ? { folderAccess } : {})}
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
  const keyCount = () => container.querySelectorAll('[data-slot="composer-key"]').length;
  // The menu beside Send, opened, and one of its items or the target list's.
  const openSendMenu = async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send as"]')?.click(),
    );
  };
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find(
      (node) => node.textContent?.includes(label),
    );
  const pickTarget = async (label: string) => {
    await act(async () => targetButton()?.click());
    await act(async () => menuItem(label)?.click());
  };
  // A frame passes, so focus given back after a menu closes has landed.
  const frame = async () =>
    act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const targetButton = () =>
    container.querySelector<HTMLButtonElement>('[data-slot="composer-target"]');
  return {
    container,
    store,
    sendCommand,
    storeSend,
    repository,
    startAuto,
    render,
    type,
    press,
    keysLine,
    keyCount,
    targetButton,
    box,
    openSendMenu,
    menuItem,
    pickTarget,
    frame,
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
  it('is a fixed badge while it is the only one, and opens the list when there is a choice', async () => {
    const one = await mount();
    const fixed = one.container.querySelector('[data-slot="composer-target"]');
    expect(fixed?.textContent).toContain('Writer');
    expect(fixed?.tagName).toBe('SPAN');
    expect(fixed?.querySelector('button, [tabindex]')).toBeNull();
    const several = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    const trigger = several.container.querySelectorAll('[data-slot="composer-target"]')[0];
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.getAttribute('aria-label')).toBe(
      messages.Composer.targetLabel.replace('{name}', 'Writer'),
    );
    // The opening mark, as the tool line's other choices have.
    expect(trigger?.querySelectorAll('svg')).toHaveLength(2);
  });

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
    // Only the keys usable now: the blocked join and interrupt are not offered, a next request is.
    const keys = f.keysLine()?.textContent ?? '';
    expect(keys).toContain(messages.Composer.keyHint.queue);
    expect(keys).not.toContain(messages.Composer.keyHint.join);
    expect(keys).not.toContain(messages.Composer.keyHint.interrupt);
  });

  it.each([
    ['joins', running, { exec_writer: 'active' }, true],
    // A saved next request carries its images: the server starts it with them.
    ['saves a next request', running, { exec_writer: 'succeeded' }, false],
    ['starts a new request', null, {}, false],
  ] as const)(
    'says images apply to a new request only while the send key %s',
    async (_, active, executions, shown) => {
      const image = {
        kind: 'image_attachment' as const,
        imageId: 'img_0123456789abcdef',
        name: 'screen.png',
        mime: 'image/png' as const,
        bytes: 120,
        sha256: 'a'.repeat(64),
        width: 10,
        height: 10,
      };
      const draft = {
        text: 'Look at this screen',
        intent: null,
        target: null,
        targetLabel: null,
        references: [],
        images: [image],
      };
      const held = messages.Composer.heldForNew.replace('{items}', messages.Composer.held.images);
      writeComposerDraft('session', draft);
      const f = await mount({ active, executions });
      expect(f.container.textContent?.includes(held)).toBe(shown);
    },
  );

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
    // With nothing written while the run goes, Stop takes Send's place (composer-flow.md "활동 바").
    expect(f.container.querySelector('button[aria-label="Send"]')).toBeNull();
    expect(
      f.container.querySelector(`button[aria-label="${messages.Activity.stop}"]`),
    ).not.toBeNull();
    await f.type('Keep going');
    const send = f.container.querySelector('button[aria-label="Send"]');
    expect(send).not.toBeNull();
    expect(send?.getAttribute('aria-description')).toContain(messages.Composer.sendAs.join);
    expect(f.container.querySelector('[data-testid="composer-stop"]')).toBeNull();
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

const saved: SessionEntry = {
  entryId: 'entry_saved',
  intent: 'queue',
  text: 'Write the summary after',
  createdAt: '2026-11-13T00:00:00Z',
  state: 'queued',
  runId: null,
  executionId: null,
  detail: null,
  permissionMode: 'accept_edits',
  start: {
    permissionMode: 'accept_edits',
    choice: { modelProfile: 'model-a' },
    team: 'none',
    mode: 'live',
  },
};

const lastEntry = (repository: { addSessionEntry: ReturnType<typeof vi.fn> }) =>
  repository.addSessionEntry.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

describe('a queued request taken back to edit', () => {
  it('during a run, goes again as a next request with its permission mode, never as a join', async () => {
    const f = await mount({ queued: [saved] });
    const edit = f.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${messages.Sessions.editQueuedMessage.replace('{text}', saved.text)}"]`,
    );
    expect(edit).not.toBeNull();
    await act(async () => edit?.click());
    expect(f.box().value).toBe(saved.text);
    // The send key says what it does now, on the key line and on Send.
    expect(f.container.querySelector('[data-slot="composer-key"]')?.textContent).toContain(
      messages.Composer.keyHint.queue,
    );
    expect(
      f.container.querySelector('button[aria-label="Send"]')?.getAttribute('aria-description'),
    ).toContain(messages.Composer.sendAs.queue);
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({
      intent: 'queue',
      state: 'queued',
      text: saved.text,
      permissionMode: 'accept_edits',
      start: { permissionMode: 'accept_edits', choice: { modelProfile: 'model-a' } },
    });
  });
});

describe('auto start', () => {
  it('has no switch in the browser demo, which has no server to start a saved request', async () => {
    const f = await mount({ queued: [saved], mode: 'browser' });
    expect(
      f.container.querySelector(`section[aria-label="${messages.Sessions.queueHeading}"]`)
        ?.textContent,
    ).toContain(saved.text);
    expect(f.container.querySelector('[role="switch"]')).toBeNull();
  });

  it('shows the saved value at once and saves the next change on the revision it got', async () => {
    const f = await mount({ queued: [saved] });
    const toggle = () => f.container.querySelector<HTMLElement>('[role="switch"]');
    await act(async () => toggle()?.click());
    // The session the page holds still says revision 3 and on; the save said 4 and off.
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle()?.click());
    expect(f.repository.updateSession).toHaveBeenLastCalledWith('session', {
      autoStart: true,
      expectedRevision: 4,
    });
  });
});

describe('while the run’s record is read', () => {
  // The store still holds another run's record: where an instruction goes is not known yet.
  const another = {
    runId: 'run_other',
    projection: projection({ exec_other: 'active' }, 'run_other'),
  };

  it('keeps the target and the keys in their place, empty', async () => {
    const f = await mount({ runState: another });
    expect(f.keyCount()).toBe(0);
    expect(f.keysLine()).not.toBeNull();
    expect(f.container.textContent).not.toContain(messages.Composer.targetNone);
    expect(f.targetButton()).toBeNull();
    expect(f.container.querySelector('[data-slot="composer-target-pending"]')).not.toBeNull();
  });

  it('shows no request settings: what a send is is not known yet', async () => {
    const f = await mount({ runState: another });
    const settings = () => [
      f.container.querySelector('[aria-label="Team"]'),
      f.container.querySelector(`[aria-label="${messages.Composer.permissionMode.label}"]`),
    ];
    expect(settings()).toEqual([null, null]);
    // Send's place keeps its button: Stop while nothing is written, Send once something is.
    expect(f.container.querySelector('[data-testid="composer-stop"]')).not.toBeNull();
    await f.type('Keep going');
    expect(f.container.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(settings()).toEqual([null, null]);
    // A next request, the send key's fallback, does show them once nothing can take a join.
    await act(async () =>
      f.store.setState({ runId: 'run_live', projection: projection({ exec_writer: 'succeeded' }) }),
    );
    expect(settings().every(Boolean)).toBe(true);
  });

  it('the send key sends nothing, and nothing is sent once it is read', async () => {
    const f = await mount({ runState: another });
    await f.type('Keep going');
    await f.press();
    await f.press({ ctrlKey: true });
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
    await act(async () => f.store.setState({ runId: 'run_live', projection: projection() }));
    expect(f.keyCount()).toBe(3);
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
    expect(f.box().value).toBe('Keep going');
  });

  it('Alt+Enter still saves a next request', async () => {
    const f = await mount({ runState: another });
    await f.type('After this run');
    await f.press({ altKey: true });
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'queue', text: 'After this run' });
  });

  it('a record that cannot be read takes a next request with the send key', async () => {
    const f = await mount({ runState: { projection: null, streamError: 'lost' } });
    expect(f.container.textContent).toContain(messages.Composer.targetNone);
    await f.type('After this run');
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'queue', text: 'After this run' });
  });
});

describe('a run its record says ended, before the run list does', () => {
  it('leaves the composer idle at once: a new request through that run', async () => {
    const f = await mount();
    await f.type('Next part');
    await act(async () =>
      f.store.setState({
        projection: projection({ exec_writer: 'succeeded' }, 'run_live', 'succeeded'),
      }),
    );
    expect(f.container.textContent).not.toContain(messages.Composer.targetNone);
    expect(f.targetButton()).toBeNull();
    expect(f.keyCount()).toBe(1);
    expect(f.keysLine()?.textContent).toContain(messages.Composer.keyHint.new);
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.startAuto).toHaveBeenCalledTimes(1);
    expect(f.startAuto.mock.calls[0]?.[0]).toMatchObject({
      brief: 'Next part',
      conversation: { throughRunId: 'run_live' },
    });
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'next', state: 'started' });
  });
});

describe('the send menu', () => {
  it('sends what its item says: Interrupt interrupts', async () => {
    const f = await mount();
    await f.type('Stop and look at session.ts');
    await f.openSendMenu();
    await act(async () => f.menuItem(messages.Composer.sendAs.interrupt)?.click());
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
  });

  it.each([
    ['cannot be cut', { exec_writer: 'waiting_children' }, ['interrupt']],
    ['none can take an instruction', { exec_writer: 'succeeded' }, ['join', 'interrupt']],
  ] as const)('offers only the sends usable now when the target %s', async (_, executions, off) => {
    const f = await mount({ executions });
    await f.type('Shorter');
    await f.openSendMenu();
    for (const choice of ['join', 'interrupt', 'queue'] as const)
      expect(
        f.menuItem(messages.Composer.sendAs[choice])?.getAttribute('aria-disabled') === 'true',
        choice,
      ).toBe((off as readonly string[]).includes(choice));
  });

  it('is not offered while nothing runs: every send is a new request', async () => {
    const f = await mount({ active: null });
    expect(
      f.container.querySelector<HTMLButtonElement>('button[aria-label="Send as"]')?.disabled,
    ).toBe(true);
    expect(menuSends('idle')).toEqual({ join: false, interrupt: false, queue: false });
  });

  it('gives the focus back to the box after Escape and after a send', async () => {
    const f = await mount();
    await f.type('Shorter');
    await f.openSendMenu();
    expect(f.menuItem(messages.Composer.sendAs.join)).toBeDefined();
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await f.frame();
    expect(document.activeElement).toBe(f.box());
    await f.openSendMenu();
    await act(async () => f.menuItem(messages.Composer.sendAs.join)?.click());
    await f.frame();
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'next_request' });
    expect(document.activeElement).toBe(f.box());
  });

  it.each([
    ['Alt+Enter', 'key'],
    ['the send menu’s Next request', 'menu'],
  ] as const)('with a fixed target whose run ended, %s starts a new request', async (_, how) => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.type('Check the edge case');
    await f.render(ended);
    expect(f.container.querySelector('[data-testid="intent-blocked"]')).not.toBeNull();
    if (how === 'key') await f.press({ altKey: true });
    else {
      await f.openSendMenu();
      await act(async () => f.menuItem(messages.Composer.sendAs.queue)?.click());
    }
    expect(f.startAuto).toHaveBeenCalledTimes(1);
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'next', text: 'Check the edge case' });
  });
});

describe('a fixed target', () => {
  it('lasts for the run it was picked in: a new run goes to its lead', async () => {
    const both = { exec_writer: 'active', exec_review: 'active' };
    const f = await mount({ executions: both });
    await f.pickTarget('Review');
    await act(async () =>
      f.store.setState({ runId: 'run_two', projection: projection(both, 'run_two') }),
    );
    await f.render({ ...running, runId: 'run_two' });
    await f.type('Start with the outline');
    await f.press();
    expect(f.sendCommand.mock.calls.at(-1)?.[0]).toMatchObject({
      runId: 'run_two',
      payload: { targetExecutionId: 'exec_writer' },
    });
  });

  it('is let go when the text is cleared', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.type('Check');
    await f.type('');
    await act(async () =>
      f.store.setState({
        projection: projection({ exec_writer: 'active', exec_review: 'succeeded' }),
      }),
    );
    await f.type('Check the edge case');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ targetExecutionId: 'exec_writer' });
  });

  it('is let go once sent', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.type('Check the edge case');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ targetExecutionId: 'exec_review' });
    await act(async () =>
      f.store.setState({
        projection: projection({ exec_writer: 'active', exec_review: 'succeeded' }),
      }),
    );
    await f.type('And the docs');
    await f.press();
    expect(f.sendCommand).toHaveBeenCalledTimes(2);
    expect(steerPayload(f.sendCommand)).toMatchObject({ targetExecutionId: 'exec_writer' });
  });

  it('picked in the list gives the focus back to the box', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.frame();
    expect(f.targetButton()?.textContent).toContain('Review');
    expect(document.activeElement).toBe(f.box());
  });

  it('that ended: Alt+Enter saves a next request', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.type('Check the edge case');
    await act(async () =>
      f.store.setState({
        projection: projection({ exec_writer: 'active', exec_review: 'succeeded' }),
      }),
    );
    await f.press({ altKey: true });
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'queue', text: 'Check the edge case' });
  });

  it('that ended: the notice’s next request lets it go, back in the box, and the send key saves it', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await f.pickTarget('Review');
    await f.type('Check the edge case');
    await act(async () =>
      f.store.setState({
        projection: projection({ exec_writer: 'active', exec_review: 'succeeded' }),
      }),
    );
    const banner = () => f.container.querySelector('[data-testid="intent-blocked"]');
    const next = [...(banner()?.querySelectorAll('button') ?? [])].find(
      (node) => node.textContent === messages.Composer.switchTo.next,
    );
    // A click focuses the button it presses; jsdom does not, so the test does.
    await act(async () => {
      next?.focus();
      next?.click();
    });
    expect(banner()).toBeNull();
    expect(document.activeElement).toBe(f.box());
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'queue', text: 'Check the edge case' });
  });
});

describe('the tool line', () => {
  it.each([
    ['nothing runs', null, {}, 1],
    ['the target cannot be cut', running, { exec_writer: 'waiting_children' }, 2],
    ['the target can be cut', running, { exec_writer: 'active' }, 3],
  ] as const)('lists each usable key once when %s', async (_, active, executions, count) => {
    const f = await mount({ active, executions });
    expect(f.keyCount()).toBe(count);
  });

  it('says nothing of a target while nothing runs', async () => {
    const f = await mount({ active: null });
    expect(f.targetButton()).toBeNull();
    expect(f.container.textContent).not.toContain(messages.Composer.targetNone);
  });

  it.each([
    ['joining', running, false],
    ['starting a new request', null, true],
  ] as const)('offers the team only for a request: %s', async (_, active, shown) => {
    const f = await mount({ active });
    expect(Boolean(f.container.querySelector('[aria-label="Team"]'))).toBe(shown);
  });
});

describe('the composer', () => {
  it('says when an interrupt was read at the next request instead', async () => {
    const f = await mount();
    await f.type('Stop');
    await f.press({ ctrlKey: true });
    expect(f.container.textContent).toContain(messages.Composer.lowered);
  });

  it('sends a lost interrupt again as an interrupt', async () => {
    const f = await mount();
    f.sendCommand.mockRejectedValueOnce(new Error('connection reset'));
    await f.type('Stop');
    await f.press({ ctrlKey: true });
    const retry = [...f.container.querySelectorAll('button')].find(
      (node) => node.textContent === messages.Refusal.retry,
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(f.sendCommand).toHaveBeenCalledTimes(2);
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
  });

  it('sends nothing but spaces with no key', async () => {
    const f = await mount();
    await f.type('   ');
    for (const init of [{}, { ctrlKey: true }, { altKey: true }]) await f.press(init);
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
  });

  it('sends nothing with any key while a command is being chosen', async () => {
    const f = await mount();
    await f.type('/zzz');
    expect(f.box().getAttribute('aria-expanded')).toBe('true');
    for (const init of [{}, { ctrlKey: true }, { altKey: true }]) await f.press(init);
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
  });

  it('a send chosen with /interrupt lasts one send', async () => {
    const f = await mount();
    await f.type('/');
    const option = [...document.querySelectorAll('[role="option"]')].find((node) =>
      node.textContent?.includes('/interrupt'),
    );
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await f.type('Stop');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'interrupt' });
    await f.type('Then go on');
    await f.press();
    expect(f.sendCommand).toHaveBeenCalledTimes(2);
    expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'next_request' });
  });

  it.each([
    ['nothing runs', null, {}, ['/next'], ['/interrupt', '/steer']],
    [
      'the target cannot be cut',
      running,
      { exec_writer: 'waiting_children' },
      ['/next', '/steer'],
      ['/interrupt'],
    ],
  ] as const)(
    'lists the sends usable now as commands when %s',
    async (_, active, executions, on, off) => {
      const f = await mount({ active, executions });
      await f.type('/');
      const listed = [...document.querySelectorAll('[role="option"]')].map(
        (node) => node.textContent ?? '',
      );
      for (const name of on)
        expect(
          listed.some((text) => text.includes(name)),
          name,
        ).toBe(true);
      for (const name of off)
        expect(
          listed.some((text) => text.includes(name)),
          name,
        ).toBe(false);
    },
  );

  it.each([
    ['joins', running, { exec_writer: 'active' }, true],
    // A saved next request carries its references: the server starts it with them.
    ['saves a next request', running, { exec_writer: 'succeeded' }, false],
    ['starts a new request', null, {}, false],
  ] as const)(
    'says references apply to a new request only while the send key %s',
    async (_, active, executions, shown) => {
      writeComposerDraft('session', {
        text: 'Read @README.md first',
        intent: null,
        target: null,
        targetLabel: null,
        references: [
          {
            id: 'file:readme',
            kind: 'file',
            label: 'README.md',
            reference: { kind: 'file', path: 'README.md' },
          },
        ],
      } as never);
      const held = messages.Composer.heldForNew.replace(
        '{items}',
        messages.Composer.held.references,
      );
      const f = await mount({ active, executions });
      expect(f.container.textContent?.includes(held)).toBe(shown);
    },
  );
});

// composer-flow.md "활동 바": with nothing written while the run goes, Send's place is Stop, which
// asks first only while two or more executions work.
describe('Stop in Send’s place', () => {
  const stop = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]');
  const cancels = (sendCommand: ReturnType<typeof vi.fn>) =>
    sendCommand.mock.calls.filter(([command]) => (command as { type?: string }).type === 'cancel');
  // The line's words now, not those fading out after a change.
  const line = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-activity-bar] > div [data-activity-text]')].at(-1);
  const confirmButton = () =>
    [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === messages.Reins.confirmCancelRun,
    );

  it('stops a run with one working execution at once', async () => {
    const f = await mount();
    expect(stop(f.container)?.getAttribute('aria-label')).toBe(messages.Activity.stop);
    // What a send would do is not read out on Stop.
    expect(stop(f.container)?.hasAttribute('aria-description')).toBe(false);
    // Only Send's place: the send menu keeps its own beside it.
    expect(f.container.querySelector('[data-slot="composer-send-menu"]')).not.toBeNull();
    await act(async () => stop(f.container)?.click());
    expect(cancels(f.sendCommand)).toHaveLength(1);
    expect(cancels(f.sendCommand)[0]?.[0]).toMatchObject({ runId: 'run_live', type: 'cancel' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('asks first while two executions work, and sends nothing until confirmed', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await act(async () => stop(f.container)?.click());
    expect(cancels(f.sendCommand)).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      messages.Reins.cancelRun,
    );
  });

  it('is not there while nothing runs', async () => {
    const f = await mount({ active: null });
    expect(stop(f.container)).toBeNull();
    expect(f.container.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });

  it('takes Send’s place while only spaces are written', async () => {
    const f = await mount();
    await f.type('   ');
    expect(stop(f.container)).not.toBeNull();
    expect(f.container.querySelector('button[aria-label="Send"]')).toBeNull();
  });

  it('counts only executions still open: one working beside one done stops at once', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'succeeded' } });
    await act(async () => stop(f.container)?.click());
    expect(cancels(f.sendCommand)).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('asks first while it is not known yet how many executions work', async () => {
    const f = await mount({
      runState: {
        runId: 'run_other',
        projection: projection({ exec_other: 'active' }, 'run_other'),
      },
    });
    await act(async () => stop(f.container)?.click());
    expect(cancels(f.sendCommand)).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      messages.Reins.cancelRun,
    );
  });

  it('opens the run’s record before it sends to it', async () => {
    const f = await mount({
      runState: {
        runId: 'run_other',
        projection: projection({ exec_other: 'active' }, 'run_other'),
      },
    });
    const open = vi.fn(async (runId: string) => {
      f.store.setState({ runId, projection: projection({ exec_writer: 'active' }) });
    });
    f.store.setState({ open } as never);
    await act(async () => stop(f.container)?.click());
    await act(async () => confirmButton()?.click());
    expect(open).toHaveBeenCalledWith('run_live');
    expect(cancels(f.sendCommand)).toHaveLength(1);
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(
      f.storeSend.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('says on the bar a run command the run refused, where a refusal is said, and can be pressed again', async () => {
    const f = await mount();
    f.sendCommand.mockResolvedValueOnce({ error: { message: 'The run changed' } } as never);
    await act(async () => stop(f.container)?.click());
    const refused = messages.Approvals.refused.replace('{message}', 'The run changed');
    expect(line(f.container)?.textContent).toContain(refused);
    // Said once, on the line, not again under the input.
    expect(f.container.textContent?.split(refused).length).toBe(2);
    expect(stop(f.container)?.disabled).toBe(false);
    // Pressed again, it is sent again and the line lets the refusal go as it is pressed, before
    // the answer comes.
    let answer = () => {};
    f.sendCommand.mockImplementationOnce(
      (command: { commandId: string }) =>
        new Promise((done) => {
          answer = () =>
            done({ commandId: command.commandId, runId: 'run_live', status: 'accepted' } as never);
        }),
    );
    await act(async () => stop(f.container)?.click());
    expect(cancels(f.sendCommand)).toHaveLength(2);
    expect(line(f.container)?.textContent ?? '').not.toContain(refused);
    await act(async () => answer());
    expect(line(f.container)?.textContent ?? '').not.toContain(refused);
  });

  it('says on the bar a run command whose answer was lost, in its own words', async () => {
    const f = await mount();
    f.sendCommand.mockRejectedValueOnce(new Error('Failed to fetch'));
    await act(async () => stop(f.container)?.click());
    expect(line(f.container)?.textContent).toContain(messages.Activity.commandUnconfirmed);
    expect(f.container.textContent).not.toContain('Failed to fetch');
    expect(stop(f.container)?.disabled).toBe(false);
  });

  it('lets a lost answer go once the run’s state says the command reached it', async () => {
    const f = await mount();
    f.sendCommand.mockRejectedValueOnce(new Error('Failed to fetch'));
    await act(async () => stop(f.container)?.click());
    expect(line(f.container)?.textContent).toContain(messages.Activity.commandUnconfirmed);
    // The run is being cancelled after all: Stop cannot be pressed, and nothing asks for it.
    await f.render({ ...running, status: 'cancelling' });
    expect(stop(f.container)?.disabled).toBe(true);
    expect(line(f.container)?.textContent ?? '').not.toContain(
      messages.Activity.commandUnconfirmed,
    );
  });

  it('lets a lost answer go with its run: nothing says it under the input', async () => {
    const f = await mount();
    f.sendCommand.mockRejectedValueOnce(new Error('Failed to fetch'));
    await act(async () => stop(f.container)?.click());
    expect(line(f.container)?.textContent).toContain(messages.Activity.commandUnconfirmed);
    await f.render(null);
    expect(f.container.textContent).not.toContain(messages.Activity.commandUnconfirmed);
    expect(
      [...f.container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toEqual(expect.not.arrayContaining([expect.stringMatching(/./)]));
  });

  it('lets a lost answer go when its run ended before the answer was lost', async () => {
    const f = await mount();
    let lose = () => {};
    f.sendCommand.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          lose = () => fail(new Error('Failed to fetch'));
        }),
    );
    await act(async () => stop(f.container)?.click());
    await f.render(null);
    await act(async () => lose());
    expect(f.container.textContent).not.toContain(messages.Activity.commandUnconfirmed);
    expect(
      [...f.container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toEqual(expect.not.arrayContaining([expect.stringMatching(/./)]));
  });

  it('says a refusal under the input once its run is no longer going', async () => {
    const f = await mount();
    f.sendCommand.mockResolvedValueOnce({ error: { message: 'The run changed' } } as never);
    await act(async () => stop(f.container)?.click());
    const refused = messages.Approvals.refused.replace('{message}', 'The run changed');
    expect(line(f.container)?.textContent).toContain(refused);
    await f.render(null);
    // Said once, by the composer, not lost with the run's line.
    expect(f.container.textContent?.split(refused).length).toBe(2);
    expect(line(f.container)?.textContent ?? '').not.toContain(refused);
  });

  it('cannot be pressed while the run is being cancelled', async () => {
    const f = await mount({ active: { ...running, status: 'cancelling' } });
    expect(stop(f.container)?.disabled).toBe(true);
  });

  it('goes by the run’s command path and sends one cancel however often it is pressed', async () => {
    const f = await mount();
    let release = () => {};
    f.sendCommand.mockImplementationOnce(
      (command: { commandId: string }) =>
        new Promise((done) => {
          release = () =>
            done({ commandId: command.commandId, runId: 'run_live', status: 'accepted' } as never);
        }),
    );
    // Two presses before the page draws again, and one after.
    await act(async () => {
      stop(f.container)?.click();
      stop(f.container)?.click();
    });
    expect(stop(f.container)?.disabled).toBe(true);
    await act(async () => stop(f.container)?.click());
    expect(f.storeSend).toHaveBeenCalledTimes(1);
    expect(cancels(f.sendCommand)).toHaveLength(1);
    await act(async () => release());
    expect(stop(f.container)?.disabled).toBe(false);
  });

  it.each([
    ['a click', 'click'],
    ['the send key', 'key'],
  ] as const)(
    'is not pressed by the press that sent with %s: it waits a moment',
    async (_name, how) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const f = await mount();
        await f.type('Keep it short');
        if (how === 'key') await f.press();
        else
          await act(async () =>
            f.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click(),
          );
        expect(steerPayload(f.sendCommand)).toMatchObject({ delivery: 'next_request' });
        // Stop is in Send's place at once, but the same place pressed again does not stop.
        expect(stop(f.container)?.disabled).toBe(true);
        await act(async () => stop(f.container)?.click());
        expect(cancels(f.sendCommand)).toHaveLength(0);
        await act(async () => vi.advanceTimersByTime(599));
        expect(stop(f.container)?.disabled).toBe(true);
        await act(async () => vi.advanceTimersByTime(1));
        expect(stop(f.container)?.disabled).toBe(false);
        await act(async () => stop(f.container)?.click());
        expect(cancels(f.sendCommand)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

// composer-flow.md "활동 바": the open bar's roles take the join target, and its run controls
// send by the run's command path.
describe('the activity bar', () => {
  const openBar = async (container: HTMLElement) =>
    act(async () => container.querySelector<HTMLButtonElement>('[data-activity-toggle]')?.click());
  const barButton = (container: HTMLElement, words: string, within = '[data-activity-bar]') =>
    [...container.querySelectorAll<HTMLButtonElement>(`${within} button`)].find(
      (button) => button.textContent === words,
    );
  const commands = (sendCommand: ReturnType<typeof vi.fn>, type: string) =>
    sendCommand.mock.calls.filter(([command]) => (command as { type?: string }).type === type);

  it('pauses with Pause and resumes with Resume, through the run’s command path', async () => {
    const f = await mount();
    await openBar(f.container);
    await act(async () => barButton(f.container, messages.Activity.pause)?.click());
    expect(commands(f.sendCommand, 'pause')).toHaveLength(1);
    expect(commands(f.sendCommand, 'resume')).toHaveLength(0);
    await act(async () =>
      f.store.setState({ projection: projection({ exec_writer: 'active' }, 'run_live', 'paused') }),
    );
    await act(async () => barButton(f.container, messages.Activity.resume)?.click());
    expect(commands(f.sendCommand, 'resume')).toHaveLength(1);
    expect(commands(f.sendCommand, 'pause')).toHaveLength(1);
    expect(f.storeSend).toHaveBeenCalledTimes(2);
  });

  it('joins from a role row: the target moves there, the box takes the focus, the row says so', async () => {
    const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
    await openBar(f.container);
    const row = () => '[data-activity-role="exec_review"]';
    const join = barButton(f.container, messages.Activity.join, row());
    // Pressed with the focus on it, as a click or a key gives it.
    join?.focus();
    await act(async () => join?.click());
    expect(document.activeElement).toBe(f.box());
    expect(f.container.querySelector(row())?.textContent).toContain(messages.Activity.joinTarget);
    await f.type('Check the tests');
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ targetExecutionId: 'exec_review' });
  });
});

// features/composer-flow.md "합류 대상": images and references ride a new request and a next
// request; a join or an interrupt leaves them in the box with one line.
const IMAGE: ImageAttachment = {
  kind: 'image_attachment',
  imageId: 'img_0123456789abcdef',
  name: 'screen.png',
  mime: 'image/png',
  bytes: 120,
  sha256: 'a'.repeat(64),
  width: 10,
  height: 10,
};
const NOTE = createTextAttachment('notes.txt', 'text/plain', 'Keep it short.');
const HELD = messages.Composer.heldForNew.split('{items}')[0] ?? '';
const FILE_REF: RunReference = { kind: 'file', path: 'src/a.ts', lines: { start: 2, end: 4 } };
const withReferences = () =>
  writeComposerDraft('session', {
    text: 'Look at @src/a.ts:L2-L4 here',
    intent: null,
    target: null,
    targetLabel: null,
    references: [
      {
        id: 'file:src/a.ts:2-4',
        kind: 'file',
        label: 'src/a.ts',
        lines: { start: 2, end: 4 },
        reference: FILE_REF,
      },
    ],
    attachments: [NOTE],
    images: [IMAGE],
  });

describe('what a next request carries', () => {
  it('records its images and references with the request and clears them from the box', async () => {
    withReferences();
    const f = await mount({ executions: { exec_writer: 'succeeded' } });
    expect(f.container.textContent).not.toContain(HELD);
    await f.press();
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({
      intent: 'queue',
      state: 'queued',
      text: 'Look at @src/a.ts:L2-L4 here',
      references: [FILE_REF],
      attachments: [NOTE],
      images: [IMAGE],
    });
    const left = readComposerDraft('session');
    expect(left.images ?? []).toEqual([]);
    expect(left.references).toEqual([]);
    expect(left.attachments ?? []).toEqual([]);
  });

  it('a new request starts with them in the order a saved request starts with', async () => {
    withReferences();
    const f = await mount({ active: null });
    await f.press();
    expect(
      (f.startAuto.mock.calls[0]?.[0] as { references?: unknown } | undefined)?.references,
    ).toEqual([FILE_REF, NOTE, IMAGE]);
    expect(lastEntry(f.repository)).toMatchObject({
      intent: 'next',
      references: [FILE_REF],
      images: [IMAGE],
    });
  });

  it('Start now starts a saved request with the body the server would send', async () => {
    const entry: SessionEntry = {
      ...saved,
      text: 'Look at @src/a.ts:L2-L4 here',
      references: [FILE_REF],
      attachments: [NOTE],
      images: [IMAGE],
    };
    const f = await mount({ active: null, queued: [entry] });
    const start = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === messages.Sessions.startNow,
    );
    await act(async () => start?.click());
    await act(async () => {});
    expect(f.startAuto).toHaveBeenCalledTimes(1);
    expect(f.startAuto.mock.calls[0]?.[0]).toEqual({
      ...saved.start,
      commandId: queuedSessionCommandId('session', entry),
      sessionId: 'session',
      brief: entry.text,
      references: [FILE_REF, NOTE, IMAGE],
    });
  });

  it('a join leaves the images in the box, says so, and sends only the text attachment', async () => {
    withReferences();
    const f = await mount();
    expect(f.container.textContent).toContain(
      messages.Composer.heldForNew.replace(
        '{items}',
        `${messages.Composer.held.references} and ${messages.Composer.held.images}`,
      ),
    );
    await f.press();
    expect(steerPayload(f.sendCommand)).toMatchObject({ attachments: [NOTE] });
    expect(steerPayload(f.sendCommand)).not.toHaveProperty('images');
    const recorded = lastEntry(f.repository);
    expect(recorded).toMatchObject({ intent: 'steer' });
    expect(recorded).not.toHaveProperty('images');
    expect(recorded).not.toHaveProperty('references');
    expect(readComposerDraft('session').images).toEqual([IMAGE]);
  });

  it.each([
    ['a file range', 'Compare @src/a.ts:L2-L4 now', [FILE_REF]],
    ['a folder', 'Read @docs/ first', [{ kind: 'folder', path: 'docs' }]],
    [
      'a result and a run',
      'Use @result:1 from @"Run #1" please',
      [
        { kind: 'result', runId: 'run_old', artifactVersionId: 'art_1' },
        { kind: 'run', runId: 'run_live' },
      ],
    ],
  ] as [string, string, RunReference[]][])(
    'taken back to edit, comes back with its images and %s, and goes again the same',
    async (_, text, references) => {
      const entry: SessionEntry = {
        ...saved,
        text,
        references,
        attachments: [NOTE],
        images: [IMAGE],
      };
      const f = await mount({ queued: [entry] });
      const edit = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.getAttribute('aria-label') ===
          messages.Sessions.editQueuedMessage.replace('{text}', text),
      );
      expect(edit).toBeDefined();
      await act(async () => edit?.click());
      expect(f.box().value).toBe(text);
      const draft = readComposerDraft('session');
      expect(draft.images).toEqual([IMAGE]);
      expect(draft.references.map((item) => item.reference)).toEqual(references);
      // Taken back as a next request, nothing is held for a new one.
      expect(f.container.textContent).not.toContain(HELD);
      await f.press();
      expect(lastEntry(f.repository)).toMatchObject({
        intent: 'queue',
        text,
        permissionMode: 'accept_edits',
        references,
        attachments: [NOTE],
        images: [IMAGE],
      });
    },
  );
});

it('the tool line keeps the folder notice before where a send goes, and voice right before Send', async () => {
  const f = await mount({ folderAccess: 'copy' });
  // Written, so Send holds its place (while a run goes and nothing is written, Stop does).
  await f.type('Look at session.ts');
  const line = [
    ...f.container.querySelectorAll<HTMLElement>(
      '[data-testid="folder-access"], [data-slot="composer-target"], button',
    ),
  ];
  const notice = line.findIndex((node) => node.dataset.testid === 'folder-access');
  const target = line.findIndex((node) => node.dataset.slot === 'composer-target');
  expect(notice).toBeGreaterThanOrEqual(0);
  expect(notice).toBeLessThan(target);
  const voice = line.findIndex(
    (node) => node.getAttribute('aria-label') === messages.LiveVoice.title,
  );
  const send = line.findIndex((node) => node.getAttribute('aria-label') === 'Send');
  expect(voice).toBeGreaterThan(target);
  expect(voice).toBeLessThan(send);
});

it('a menu opened again before the focus comes back stays open, and the box does not take the focus', async () => {
  const f = await mount({ executions: { exec_writer: 'active', exec_review: 'active' } });
  // Closed by a pick, and opened again before the next frame.
  // Frames are held from the close until the menu is open again: the frame the close planned
  // comes after the reopening, as on a loaded machine.
  await act(async () => f.targetButton()?.click());
  await vi.waitFor(() => expect(f.menuItem('Review')).toBeDefined());
  const held: FrameRequestCallback[] = [];
  const realFrame = window.requestAnimationFrame;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    held.push(callback);
    return 0;
  });
  await act(async () => f.menuItem('Review')?.click());
  expect(f.targetButton()?.textContent).toContain('Review');
  await act(async () => f.targetButton()?.click());
  await vi.waitFor(() => expect(f.targetButton()?.getAttribute('aria-expanded')).toBe('true'));
  vi.stubGlobal('requestAnimationFrame', realFrame);
  expect(held.length).toBeGreaterThan(0);
  // The box never takes the focus from the open menu, not even for a moment.
  let taken = false;
  f.box().addEventListener('focus', () => {
    taken = true;
  });
  await act(async () => {
    for (const callback of held.splice(0)) callback(performance.now());
  });
  for (let frames = 0; frames < 5; frames++) await f.frame();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(f.targetButton()?.getAttribute('aria-expanded')).toBe('true');
  expect(taken).toBe(false);
  expect(document.activeElement).not.toBe(f.box());
});

// features/composer-flow.md "합류 대상": images and references can be added while a run goes.
describe('adding images while a run goes', () => {
  const imageInput = (f: { container: HTMLElement }) =>
    f.container.querySelector<HTMLInputElement>(
      `input[type="file"][aria-label="${messages.Composer.attachImages}"]`,
    );
  // The picker turns a picked file into a PNG and saves it; jsdom has no canvas, so both are faked.
  const uploads = () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 10, close() {} }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['png'], { type: 'image/png' }));
    });
    return { uploadImage: vi.fn(async () => IMAGE), imageUrl: () => '' };
  };
  const attach = async (f: { container: HTMLElement }) => {
    const input = imageInput(f);
    if (!input) throw new Error('no image input');
    const file = new File(['x'], 'screen.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => {});
  };
  afterEach(() => vi.restoreAllMocks());
  // The "+" menu's image item, which opens the picker.
  const imageItemEnabled = async (f: { container: HTMLElement }) => {
    const trigger = f.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${messages.Composer.attachmentActions}"]`,
    );
    await act(async () => trigger?.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes(messages.Composer.attachImages),
    );
    expect(item).toBeDefined();
    const enabled =
      item?.getAttribute('aria-disabled') !== 'true' && !item?.hasAttribute('data-disabled');
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    return enabled;
  };

  it.each([
    ['with a target to join', { exec_writer: 'active' }],
    ['with nothing to join', { exec_writer: 'succeeded' }],
  ] as const)('can be added %s', async (_, executions) => {
    const f = await mount({ executions, workspaces: uploads() });
    expect(imageInput(f)?.disabled).toBe(false);
    expect(await imageItemEnabled(f)).toBe(true);
    await attach(f);
    expect(readComposerDraft('session').images).toEqual([IMAGE]);
  });

  it('can be added to a queued request taken back to edit', async () => {
    const f = await mount({ queued: [saved], workspaces: uploads() });
    const edit = [...f.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.getAttribute('aria-label') ===
        messages.Sessions.editQueuedMessage.replace('{text}', saved.text),
    );
    await act(async () => edit?.click());
    expect(imageInput(f)?.disabled).toBe(false);
    expect(await imageItemEnabled(f)).toBe(true);
  });

  it('a next request takes the added image and clears it from the box', async () => {
    const f = await mount({ workspaces: uploads() });
    await f.type('Look at this');
    await attach(f);
    await f.press({ altKey: true });
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(lastEntry(f.repository)).toMatchObject({ intent: 'queue', images: [IMAGE] });
    expect(readComposerDraft('session').images ?? []).toEqual([]);
  });

  it('a join leaves the added image in the box and says it waits for a new request', async () => {
    const f = await mount({ workspaces: uploads() });
    await f.type('Look at this');
    await attach(f);
    expect(f.container.textContent).toContain(
      messages.Composer.heldForNew.replace('{items}', messages.Composer.held.images),
    );
    await f.press();
    expect(steerPayload(f.sendCommand)).not.toHaveProperty('images');
    expect(readComposerDraft('session').images).toEqual([IMAGE]);
  });
});

// features/composer-flow.md "대기 요청과 넘겨받기": every way back into the box brings the same.
describe('a request taken back into the box', () => {
  const RUN_REF: RunReference = { kind: 'run', runId: 'run_live' };
  const text = 'Compare @src/a.ts:L2-L4 with @"Run #1" please';
  const sent: SessionEntry = {
    entryId: 'entry_sent',
    intent: 'next',
    text,
    createdAt: '2026-11-13T00:00:00Z',
    state: 'refused',
    runId: null,
    executionId: null,
    detail: 'No',
    references: [FILE_REF, RUN_REF],
    attachments: [NOTE],
    images: [IMAGE],
  };
  const comesBack = () => {
    const draft = readComposerDraft('session');
    expect(draft.text).toBe(text);
    expect(draft.references.map((item) => item.reference)).toEqual([FILE_REF, RUN_REF]);
    expect(draft.attachments).toEqual([NOTE]);
    expect(draft.images).toEqual([IMAGE]);
  };

  it('to be edited, its chips, images and text attachments come back and go again the same', async () => {
    const f = await mount({ active: ended });
    await act(async () => editRequest(sent.text, sent));
    comesBack();
    await f.press();
    expect(
      (f.startAuto.mock.calls[0]?.[0] as { references?: unknown } | undefined)?.references,
    ).toEqual([FILE_REF, RUN_REF, NOTE, IMAGE]);
  });

  it('recalled with the up arrow, its chips, images and text attachments come back', async () => {
    const f = await mount({
      active: ended,
      session: { ...baseSession, entries: [sent] },
    });
    await act(async () => {
      f.box().focus();
      f.box().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
    });
    expect(f.box().value).toBe(text);
    comesBack();
  });
});

// features/composer-flow.md "합류 대상": a request carries 20 references and attachments in all.
describe('a request with too many references', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      id: `file:f${n}`,
      kind: 'file' as const,
      label: `f${n}.ts`,
      reference: { kind: 'file' as const, path: `f${n}.ts` },
    }));
  const draftOf = (count: number) =>
    writeComposerDraft('session', {
      text: many(count)
        .map((item) => `@${item.label}`)
        .join(' '),
      intent: null,
      target: null,
      targetLabel: null,
      references: many(count),
      attachments: [NOTE],
    });
  const notice = messages.Composer.tooManyItems.replace('{max}', '20').replace('{over}', '1');

  it.each([
    ['a new request', null, {}],
    ['a next request', running, { exec_writer: 'succeeded' }],
  ] as const)('says so before %s is sent, and sends nothing', async (_, active, executions) => {
    draftOf(20);
    const f = await mount({ active, executions });
    expect(f.container.textContent).toContain(notice);
    await f.press();
    expect(f.startAuto).not.toHaveBeenCalled();
    expect(f.repository.addSessionEntry).not.toHaveBeenCalled();
    expect(readComposerDraft('session').references).toHaveLength(20);
  });

  it('sends at the limit', async () => {
    draftOf(19);
    const f = await mount({ active: null });
    expect(f.container.textContent).not.toContain(messages.Composer.tooManyItems.split('{')[0]);
    await f.press();
    expect(f.startAuto).toHaveBeenCalledTimes(1);
  });
});
