import type { VoiceTranscript } from '@corral/client';
import type { WorkSession } from '@corral/core';
import { describe, expect, it, vi } from 'vitest';
import { createPendingSessionCommands } from '../../../pendingCommands.ts';
import type { AutoRequest, PendingCommand } from './send.ts';
import { performVoice, type VoiceDeps } from './voice.ts';

// features/composer-flow.md "대기 요청과 넘겨받기": a spoken next request, like a typed one, is
// saved with the start the server begins it with; a new request records the start it was sent
// with.

const session: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: null,
  auto: { modelProfile: 'model-a' },
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 1,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries: [],
};

function deps(overrides: Partial<VoiceDeps> = {}) {
  const addSessionEntry = vi.fn(async (_sessionId: string, _entry: unknown) => ({
    ok: true,
    session,
  }));
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
      transport: { sendCommand: vi.fn() },
      repository: { addSessionEntry },
    },
    session,
    choice: { modelProfile: 'model-a' },
    teamMode: 'none',
    throughRunId: null,
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
    onTitleChange: vi.fn(),
    hostId: 'host',
    ownActive: null,
    targets: [],
    permissionMode: 'accept_edits',
    voiceSubmitting: { current: false },
    autoSaving: { current: false },
    mounted: { current: true },
    setBusy: vi.fn(),
    onSent: undefined,
    invalidate: vi.fn(async () => {}),
    onChange: vi.fn(),
    ...overrides,
  } as unknown as VoiceDeps;
  return { deps: value, addSessionEntry, startAuto };
}

const utterance = (delivery?: VoiceTranscript['delivery']): VoiceTranscript => ({
  text: 'Then write the summary',
  commandId: 'voice_1',
  target: { hostId: 'host', sessionId: 'session' },
  ...(delivery ? { delivery } : {}),
});

const start = {
  permissionMode: 'accept_edits',
  choice: { modelProfile: 'model-a' },
  team: 'none',
  mode: 'live',
};

describe('a spoken request', () => {
  it('queued, is saved with the start the server begins it with', async () => {
    const h = deps();
    expect(await performVoice(h.deps, utterance('queue'))).toEqual({ status: 'queued' });
    expect(h.startAuto).not.toHaveBeenCalled();
    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ intent: 'queue', state: 'queued', start }),
    );
  });

  it('sent as a new request, records the start it was sent with', async () => {
    const h = deps();
    expect(await performVoice(h.deps, utterance('next'))).toEqual({ status: 'accepted' });
    expect(h.startAuto).toHaveBeenCalledTimes(1);
    expect(h.addSessionEntry).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ intent: 'next', state: 'started', start }),
    );
  });
});
