import type { ImageAttachment, TextAttachment } from '@corral/contracts';
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
  autoStart: true,
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
const image: ImageAttachment = {
  kind: 'image_attachment',
  imageId: 'image',
  name: 'next.png',
  mime: 'image/png',
  bytes: 1,
  sha256: 'c'.repeat(64),
  width: 1,
  height: 1,
};
const attachment: TextAttachment = {
  kind: 'text_attachment',
  name: 'notes.md',
  mime: 'text/markdown',
  bytes: 5,
  sha256: `sha256:${'a'.repeat(64)}`,
  text: 'notes',
};

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
    commands: {
      sessionId: 'session',
      pending,
      store,
      newId: () => ids.shift() ?? 'cmd_more',
      sending: { current: false },
    },
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
  delivery: null,
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
      start: { choice: { modelProfile: 'model-a' }, team: 'none', mode: 'live' },
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
      start: {
        permissionMode: 'accept_edits',
        choice: { modelProfile: 'model-a' },
        team: { corralId: 'team' },
        mode: 'live',
      },
    });
  });

  it('a refused new request is recorded with its reason, and the refusal says so', async () => {
    const h = harness();
    h.startAuto.mockResolvedValueOnce({
      runId: null,
      receipt: {
        commandId: 'cmd_fixed',
        accepted: false,
        error: { code: 'TARGET_NOT_FOUND', message: 'no such model profile: writer' },
      },
      autoRoute: null,
    } as never);
    await sendRequest(h.deps, input());
    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ state: 'refused', detail: 'no such model profile: writer' }),
    );
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'no such model profile: writer', recorded: true }),
    );
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

  it('queues a request with its references, attachments, images and permission mode, starting nothing', async () => {
    const h = harness();
    const references = [{ kind: 'folder' as const, path: 'docs' }];
    await sendRequest(
      h.deps,
      input({
        intent: 'queue',
        references,
        attachments: [attachment],
        images: [image],
        permissionMode: 'ask',
      }),
    );

    expect(h.addSessionEntry).toHaveBeenCalledTimes(1);
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      intent: 'queue',
      text: 'Write the plan',
      state: 'queued',
      references,
      attachments: [attachment],
      images: [image],
      permissionMode: 'ask',
      // The server starts it with this snapshot when the run ends (features/composer-flow.md).
      start: {
        permissionMode: 'ask',
        choice: { modelProfile: 'model-a' },
        team: 'none',
        mode: 'live',
      },
    });
    expect(h.startAuto).not.toHaveBeenCalled();
    expect(h.sendCommand).not.toHaveBeenCalled();
    // Sent with the request, its images leave the box (features/composer-flow.md "합류 대상").
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, false);
  });

  it('sends an instruction to the chosen execution for its next request boundary', async () => {
    const h = harness({ ownActive: running });
    await sendRequest(
      h.deps,
      input({ intent: 'steer', delivery: 'next_request', steerTarget: 'exec_1', body: 'Shorter' }),
    );

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
    // Text attachments ride an instruction; images only a new or next request.
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, true);
  });

  it('sends a reply quote the way it sends any text attachment, to a new or a queued request', async () => {
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
    await sendRequest(
      h.deps,
      input({
        intent: 'steer',
        delivery: 'interrupt',
        steerTarget: 'exec_1',
        body: 'Shorter',
        attachments: [attachment],
      }),
    );

    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ state: 'refused', detail: 'The execution ended', refusal: error }),
    );
    // Its message is in the conversation and says why: the composer does not say it again.
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith({
      message: 'The execution ended',
      code: 'TARGET_ENDED',
      owner: 'runtime',
      recorded: true,
    });
    expect(h.deps.clearDraft).not.toHaveBeenCalled();
  });

  it('interrupts with the interrupt delivery and the same attachments, never the images', async () => {
    const h = harness({ ownActive: running });
    h.sendCommand.mockResolvedValueOnce({
      commandId: 'cmd_fixed',
      status: 'queued',
      requestedBoundary: 'immediate',
    } as never);
    const outcome = await sendRequest(
      h.deps,
      input({
        intent: 'steer',
        delivery: 'interrupt',
        steerTarget: 'exec_1',
        body: 'Look at session.ts',
        attachments: [attachment],
        images: [image],
      }),
    );
    expect(h.sendCommand).toHaveBeenCalledWith({
      schemaVersion: '0.1',
      commandId: 'cmd_fixed',
      runId: 'run_live',
      type: 'steer',
      payload: {
        targetExecutionId: 'exec_1',
        text: 'Look at session.ts',
        delivery: 'interrupt',
        attachments: [attachment],
      },
    });
    // The instruction's record keeps the attachments; a session entry of an instruction does not.
    expect(h.addSessionEntry).toHaveBeenCalledWith('session', {
      intent: 'steer',
      text: 'Look at session.ts',
      state: 'sent',
      runId: 'run_live',
      executionId: 'exec_1',
      detail: null,
      refusal: null,
      commandId: 'cmd_fixed',
    });
    expect(outcome).toEqual({ sent: true, lowered: false });
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, true);
  });

  it('carries a reply quote on a join', async () => {
    const h = harness({ ownActive: running });
    await sendRequest(
      h.deps,
      input({
        intent: 'steer',
        delivery: 'next_request',
        steerTarget: 'exec_1',
        attachments: [quote],
      }),
    );
    expect(h.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ delivery: 'next_request', attachments: [quote] }),
      }),
    );
  });

  it('takes an interrupt the runtime lowered to the next request as sent, and says it was lowered', async () => {
    const h = harness({ ownActive: running });
    h.sendCommand.mockResolvedValueOnce({
      commandId: 'cmd_fixed',
      status: 'queued',
      requestedBoundary: 'next_request',
    } as never);
    const outcome = await sendRequest(
      h.deps,
      input({ intent: 'steer', delivery: 'interrupt', steerTarget: 'exec_1' }),
    );
    expect(outcome).toEqual({ sent: true, lowered: true });
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith(null);
    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ intent: 'steer', state: 'sent' }),
    );
    expect(h.deps.clearDraft).toHaveBeenCalledWith(7, false, true);
  });

  it('keeps the draft and its attachments when an instruction is lost, and resends it under one command', async () => {
    const h = harness({ ownActive: running });
    h.sendCommand.mockRejectedValueOnce(new Error('connection reset'));
    const join = input({
      intent: 'steer',
      delivery: 'next_request',
      steerTarget: 'exec_1',
      attachments: [attachment],
    });
    const outcome = await sendRequest(h.deps, join);
    expect(outcome).toEqual({ sent: false, lowered: false });
    expect(h.deps.clearDraft).not.toHaveBeenCalled();
    expect(h.addSessionEntry).not.toHaveBeenCalled();
    expect(h.deps.setRefusal).toHaveBeenLastCalledWith({
      message: 'connection reset',
      network: true,
    });
    await sendRequest(h.deps, join);
    expect(h.sendCommand).toHaveBeenCalledTimes(2);
    expect(h.sendCommand.mock.calls[1]?.[0]).toEqual(h.sendCommand.mock.calls[0]?.[0]);
  });

  it('a join and an interrupt of the same text are two commands', async () => {
    const h = harness({ ownActive: running });
    h.sendCommand.mockRejectedValueOnce(new Error('connection reset'));
    await sendRequest(
      h.deps,
      input({ intent: 'steer', delivery: 'next_request', steerTarget: 'exec_1' }),
    );
    await sendRequest(
      h.deps,
      input({ intent: 'steer', delivery: 'interrupt', steerTarget: 'exec_1' }),
    );
    const ids = h.sendCommand.mock.calls.map(
      (call) => (call[0] as { commandId: string }).commandId,
    );
    expect(ids).toEqual(['cmd_fixed', 'cmd_second']);
  });

  it('a lost join sent again with another attachment is another command', async () => {
    const h = harness({ ownActive: running });
    h.sendCommand.mockRejectedValueOnce(new Error('connection reset'));
    const join = { intent: 'steer', delivery: 'next_request', steerTarget: 'exec_1' } as const;
    await sendRequest(h.deps, input({ ...join, attachments: [attachment] }));
    const other = { ...attachment, text: 'other notes', sha256: `sha256:${'b'.repeat(64)}` };
    await sendRequest(h.deps, input({ ...join, attachments: [other] }));
    const ids = h.sendCommand.mock.calls.map(
      (call) => (call[0] as { commandId: string }).commandId,
    );
    expect(ids).toEqual(['cmd_fixed', 'cmd_second']);
  });

  it('sends one command when the same send is pressed twice', async () => {
    const h = harness({ ownActive: running });
    const join = input({ intent: 'steer', delivery: 'next_request', steerTarget: 'exec_1' });
    await Promise.all([sendRequest(h.deps, join), sendRequest(h.deps, join)]);
    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    expect(h.addSessionEntry).toHaveBeenCalledTimes(1);
  });

  it('never sends an instruction without its delivery', async () => {
    const h = harness({ ownActive: running });
    await sendRequest(h.deps, input({ intent: 'steer', steerTarget: 'exec_1' }));
    expect(h.sendCommand).not.toHaveBeenCalled();
  });
});
