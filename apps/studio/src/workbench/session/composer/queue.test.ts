import type { DirectiveView, SessionEntry, WorkSession } from '@corral/core';
import { createTextAttachment, emptyProjection, queuedSessionCommandId } from '@corral/core';
import { describe, expect, it, vi } from 'vitest';
import { createPendingSessionCommands } from '../../../pendingCommands.ts';
import * as queue from './queue.ts';
import { type QueueDeps, startQueued } from './queue.ts';
import type { AutoRequest, PendingCommand } from './send.ts';

// features/composer-flow.md "대기 요청과 넘겨받기": the server starts queued requests. A person
// can still start one now; that start is the same command with the same body as the server's,
// so the two reach one run.

const entry: SessionEntry = {
  entryId: 'entry_1',
  intent: 'queue',
  text: 'Run the tests too',
  createdAt: '2026-11-13T00:00:00Z',
  state: 'queued',
  runId: null,
  executionId: null,
  detail: null,
  permissionMode: 'ask',
  start: {
    permissionMode: 'ask',
    choice: { modelProfile: 'model-a' },
    team: 'auto',
    mode: 'live',
  },
};
const session: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: null,
  auto: null,
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries: [entry],
};

function deps(overrides: Partial<QueueDeps> = {}) {
  const startAuto = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
    runId: 'run_new',
    receipt: { commandId: 'x', accepted: true },
    autoRoute: null,
  }));
  const value = {
    services: {
      mode: 'server',
      live: true,
      startAuto,
      repository: {
        getSession: vi.fn(async () => session),
        updateSessionEntry: vi.fn(async () => ({ ok: true, session })),
        addSessionEntry: vi.fn(async () => ({ ok: true, session })),
      },
    },
    session,
    // The person changed the model and team after queuing; the saved snapshot still wins.
    choice: { modelProfile: 'model-b' },
    teamMode: 'none',
    throughRunId: 'run_old',
    missingTeam: false,
    messages: { selectedTeamMissing: 'missing', failed: (message: string) => message },
    commands: {
      sessionId: 'session',
      pending: { current: null as PendingCommand | null },
      store: createPendingSessionCommands(),
      newId: () => 'cmd_new',
      sending: { current: false },
    },
    autoRequest: { current: null as AutoRequest | null },
    onChoosingAuto: vi.fn(),
    teamKey: 'none',
    busy: false,
    active: false,
    autoSaving: { current: false },
    savedRequestUnavailable: false,
    setBusy: vi.fn(),
    setError: vi.fn(),
    invalidate: vi.fn(async () => {}),
    onChange: vi.fn(),
    ...overrides,
  } as unknown as QueueDeps;
  return { deps: value, startAuto };
}

describe('starting a queued request', () => {
  it('starts it now with the snapshot it was saved with, as the server would', async () => {
    const h = deps();
    await startQueued(h.deps, entry);
    expect(h.startAuto).toHaveBeenCalledTimes(1);
    expect(h.startAuto.mock.calls[0]?.[0]).toEqual({
      permissionMode: 'ask',
      choice: { modelProfile: 'model-a' },
      team: 'auto',
      mode: 'live',
      commandId: queuedSessionCommandId('session', entry),
      sessionId: 'session',
      brief: 'Run the tests too',
      conversation: { throughRunId: 'run_old' },
    });
  });

  it('does not start one while a run goes', async () => {
    const h = deps({ active: true });
    await startQueued(h.deps, entry);
    expect(h.startAuto).not.toHaveBeenCalled();
  });

  it('sent again after a failed run, it is a new request with today’s choices, and records them', async () => {
    const h = deps();
    await startQueued(h.deps, entry, true);
    expect(h.startAuto).toHaveBeenCalledTimes(1);
    expect(h.startAuto.mock.calls[0]?.[0]).toMatchObject({
      permissionMode: 'ask',
      choice: { modelProfile: 'model-b' },
      team: 'none',
      brief: 'Run the tests too',
    });
    expect(h.deps.services.repository.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        intent: 'next',
        start: {
          permissionMode: 'ask',
          choice: { modelProfile: 'model-b' },
          team: 'none',
          mode: 'live',
        },
      }),
    );
  });

  it('has no client auto-start: the server starts the queue when a run ends', () => {
    expect('useAutoStart' in queue).toBe(false);
    expect('autoStartEntry' in queue).toBe(false);
  });
});

// features/composer-flow.md "보낸 메시지의 메타 줄": "다시 보내기" sends the message's words and
// its text attachments. A join's attachments live in its directive, in the run's record.
describe('sending a join again', () => {
  it('takes the attachments the join carried', async () => {
    const notes = createTextAttachment('notes.txt', 'text/plain', 'Look at the cache first.');
    const join: SessionEntry = {
      entryId: 'entry_join',
      intent: 'steer',
      text: 'Run the tests too',
      createdAt: '2026-11-13T00:00:00Z',
      state: 'sent',
      runId: 'run_old',
      executionId: 'exec',
      commandId: 'cmd_join',
      detail: null,
    };
    const projection = emptyProjection('run_old');
    projection.directives.directive_join = {
      directiveId: 'directive_join',
      commandId: 'cmd_join',
      status: 'not_delivered',
      attachments: [notes],
    } as DirectiveView;
    const start = vi.fn(async (_entry: SessionEntry) => {});
    await queue.resendQueued(
      {
        services: { transport: { getSnapshot: async () => ({ projection }) } } as never,
        sessionId: 'session',
        entries: [join],
        runs: [],
        active: false,
        busy: false,
        autoRequest: { current: null },
        pending: { current: null },
        state: { current: { sessionId: 'session', active: false, pending: false } },
        commandKey: () => 'key',
        resolvePendingMessage: '',
        setError: () => {},
        start,
      },
      'entry_join',
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({ text: join.text, attachments: [notes] });
  });
});
