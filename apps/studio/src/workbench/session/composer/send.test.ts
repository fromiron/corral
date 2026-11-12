import type { TextAttachment } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';
import { describe, expect, it, vi } from 'vitest';
import { createPendingSessionCommands } from '../../../pendingCommands.ts';
import {
  type AutoRequest,
  type PendingCommand,
  type SendDeps,
  type SendInput,
  sendRequest,
} from './send.ts';

// Characterization of the composer's three send paths: the exact arguments each one hands the
// services (a new request, a queued request, an instruction to a running execution).

const session: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: null,
  auto: null,
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-10-21T00:00:00Z',
  updatedAt: '2026-10-21T00:00:00Z',
  archivedAt: null,
  entries: [],
};
const running: RunSummary = {
  runId: 'run_live',
  status: 'running',
  corralId: 'team',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-10-21T00:00:00Z',
};
const attachment: TextAttachment = {
  kind: 'text_attachment',
  name: 'notes.md',
  mime: 'text/markdown',
  bytes: 5,
  sha256: `sha256:${'a'.repeat(64)}`,
  text: 'notes',
};

function harness(overrides: Partial<SendDeps> = {}) {
  const startAuto = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
    runId: 'run_new',
    receipt: { commandId: 'cmd_fixed', accepted: true },
    autoRoute: null,
  }));
  const sendCommand = vi.fn(async (_command: unknown) => ({ commandId: 'cmd_fixed' }));
  const addSessionEntry = vi.fn(async (_sessionId: string, _entry: unknown) => ({
    ok: true as const,
    session,
  }));
  const startExplain = vi.fn();
  const store = createPendingSessionCommands();
  const pending = { current: null as PendingCommand | null };
  const ids = ['cmd_fixed', 'cmd_second'];
  const deps = {
    services: {
      mode: 'server',
      live: true,
      startAuto,
      startExplain,
      transport: { sendCommand },
      repository: { addSessionEntry },
    },
    session,
    choice: { modelProfile: 'model-a' },
    teamMode: 'none',
    throughRunId: 'run_old',
    missingTeam: false,
    messages: {
      selectedTeamMissing: 'team missing',
      noResult: 'no result',
      failed: (message: string) => `failed: ${message}`,
    },
    commands: { sessionId: 'session', pending, store, newId: () => ids.shift() ?? 'cmd_more' },
    autoRequest: { current: null as AutoRequest | null },
    onChoosingAuto: vi.fn(),
    onTitleChange: vi.fn(),
    team: null,
    ownActive: null,
    latest: null,
    runMode: 'live',
    setBusy: vi.fn(),
    setError: vi.fn(),
    setRefusal: vi.fn(),
    invalidate: vi.fn(async () => {}),
    onChange: vi.fn(),
    clearDraft: vi.fn(),
    ...overrides,
  } as unknown as SendDeps;
  return { deps, startAuto, sendCommand, addSessionEntry, startExplain, store, pending };
}

const input = (overrides: Partial<SendInput> = {}): SendInput => ({
  body: 'Write the plan',
  intent: 'next',
  steerTarget: '',
  references: [],
  attachments: [],
  images: [],
  permissionMode: undefined,
  revision: 7,
  ...overrides,
});

describe('composer send paths', () => {
  it('starts a new request through the auto start with the conversation so far', async () => {
    const h = harness();
    await sendRequest(h.deps, input());

    expect(h.startAuto).toHaveBeenCalledTimes(1);
    expect(h.startAuto.mock.calls[0]?.[0]).toEqual({
      commandId: 'cmd_fixed',
      brief: 'Write the plan',
      choice: { modelProfile: 'model-a' },
      sessionId: 'session',
      team: 'none',
      mode: 'live',
      conversation: { throughRunId: 'run_old' },
    });
    expect(h.startAuto.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      intent: 'next',
      text: 'Write the plan',
      state: 'started',
      runId: 'run_new',
      detail: null,
      refusal: null,
      commandId: 'cmd_fixed',
    });
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, false);
    expect(h.store.get('session')).toBeUndefined();
    expect(h.deps.setBusy).toHaveBeenNthCalledWith(1, true);
    expect(h.deps.setBusy).toHaveBeenLastCalledWith(false);
  });

  it('carries the permission mode, a saved team and the attachments of a new request', async () => {
    const h = harness({ session: { ...session, corralId: 'team' } } as Partial<SendDeps>);
    await sendRequest(
      { ...h.deps, team: { corralId: 'team' } as SendDeps['team'] },
      input({ attachments: [attachment], permissionMode: 'accept_edits' }),
    );

    expect(h.startAuto.mock.calls[0]?.[0]).toEqual({
      permissionMode: 'accept_edits',
      commandId: 'cmd_fixed',
      brief: 'Write the plan',
      choice: { modelProfile: 'model-a' },
      references: [attachment],
      sessionId: 'session',
      team: { corralId: 'team' },
      mode: 'live',
      conversation: { throughRunId: 'run_old' },
    });
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      permissionMode: 'accept_edits',
      intent: 'next',
      text: 'Write the plan',
      state: 'started',
      runId: 'run_new',
      detail: null,
      refusal: null,
      commandId: 'cmd_fixed',
      attachments: [attachment],
    });
  });

  it('retries a lost new request with the same command and the same start body', async () => {
    const h = harness();
    h.startAuto.mockRejectedValueOnce(new Error('connection reset'));
    await sendRequest(h.deps, input());
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith({
      message: 'connection reset',
      network: true,
    });
    expect(h.addSessionEntry).not.toHaveBeenCalled();
    expect(h.store.get('session')?.commandId).toBe('cmd_fixed');

    await sendRequest({ ...h.deps, throughRunId: 'run_newer' }, input());
    expect(h.startAuto).toHaveBeenCalledTimes(2);
    expect(h.startAuto.mock.calls[1]?.[0]).toEqual(h.startAuto.mock.calls[0]?.[0]);
    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ commandId: 'cmd_fixed', state: 'started' }),
    );
  });

  it('queues a request with its text attachments and permission mode, starting nothing', async () => {
    const h = harness();
    await sendRequest(
      h.deps,
      input({ intent: 'queue', attachments: [attachment], permissionMode: 'ask' }),
    );

    expect(h.addSessionEntry).toHaveBeenCalledTimes(1);
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      intent: 'queue',
      text: 'Write the plan',
      state: 'queued',
      attachments: [attachment],
      permissionMode: 'ask',
    });
    expect(h.startAuto).not.toHaveBeenCalled();
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, true);
  });

  it('sends an instruction to the chosen execution for its next request boundary', async () => {
    const h = harness({ ownActive: running });
    await sendRequest(h.deps, input({ intent: 'steer', steerTarget: 'exec_1', body: 'Shorter' }));

    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    expect(h.sendCommand).toHaveBeenCalledWith({
      schemaVersion: '0.1',
      commandId: 'cmd_fixed',
      runId: 'run_live',
      type: 'steer',
      payload: { targetExecutionId: 'exec_1', text: 'Shorter', delivery: 'next_request' },
    });
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      intent: 'steer',
      text: 'Shorter',
      state: 'sent',
      runId: 'run_live',
      executionId: 'exec_1',
      detail: null,
      refusal: null,
      commandId: 'cmd_fixed',
    });
    expect(h.startAuto).not.toHaveBeenCalled();
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, true, true);
  });

  it('sends a reply quote the way it sends any text attachment, to a new or a queued request', async () => {
    const quote: TextAttachment = {
      ...attachment,
      name: 'quote.txt',
      mime: 'text/plain',
      provenance: {
        kind: 'reply',
        runId: 'run_old',
        modelCallId: 'call_1',
        start: 0,
        end: 5,
        prefix: '',
        suffix: ' and more',
      },
    };
    const fresh = harness();
    await sendRequest(fresh.deps, input({ attachments: [quote] }));
    expect(fresh.startAuto.mock.calls[0]?.[0]).toMatchObject({ references: [quote] });
    expect(fresh.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ state: 'started', attachments: [quote] }),
    );
    const queued = harness();
    await sendRequest(queued.deps, input({ intent: 'queue', attachments: [quote] }));
    expect(queued.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ state: 'queued', attachments: [quote] }),
    );
  });

  it('records a refused instruction and keeps the draft', async () => {
    const h = harness({ ownActive: running });
    const error = { code: 'TARGET_ENDED', message: 'The execution ended', owner: 'runtime' };
    h.sendCommand.mockResolvedValueOnce({ commandId: 'cmd_fixed', error } as never);
    await sendRequest(h.deps, input({ intent: 'steer', steerTarget: 'exec_1', body: 'Shorter' }));

    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ state: 'refused', detail: 'The execution ended', refusal: error }),
    );
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith({
      message: 'The execution ended',
      code: 'TARGET_ENDED',
      owner: 'runtime',
    });
    expect(h.deps.clearDraft).not.toHaveBeenCalled();
  });
});
