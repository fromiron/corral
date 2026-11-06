import type { RunSummary, WorkSession } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { loadRunIdentities, runIdentity, runIdentityText } from './runIdentity.ts';

const first: RunSummary = {
  runId: 'run_first',
  sessionId: 'session',
  corralId: 'conversation_internal',
  projectId: 'project',
  status: 'succeeded',
  startedAt: '2026-10-30T01:00:00Z',
};
const second = { ...first, runId: 'run_second', startedAt: '2026-10-30T02:00:00Z' };
const session = {
  sessionId: 'session',
  title: 'Release notes',
  entries: [
    { runId: first.runId, intent: 'next', text: 'Original request' },
    { runId: first.runId, intent: 'steer', text: 'Later instruction' },
    { runId: second.runId, intent: 'next', text: 'Original request' },
  ],
} as WorkSession;

it('distinguishes identical requests by chronological session run number and never replaces them with later instructions', async () => {
  const getDefinition = vi.fn();
  const identities = await loadRunIdentities(
    [second, first],
    [second, first],
    [session],
    getDefinition,
  );
  expect(identities[first.runId]).toEqual({
    name: 'Original request',
    sessionName: 'Release notes',
    number: 1,
  });
  expect(identities[second.runId]?.number).toBe(2);
  expect(getDefinition).not.toHaveBeenCalled();
});

it('uses only the pinned run definition for an unlinked run and remains truthful if it cannot be read', async () => {
  const run = { ...first, sessionId: null };
  const definition = linearCorral(['writer']);
  definition.input.brief = '';
  definition.sourceTeam = { corralId: 'team', name: 'Original team', revision: 1 };
  expect(runIdentity(run, [run], [], definition).name).toBe('Original team');
  const identities = await loadRunIdentities([run], [run], [], async () => {
    throw new Error('gone');
  });
  const identity = identities[run.runId];
  if (!identity) throw new Error('Run identity missing');
  expect(runIdentityText(identity, 'Run', (number) => `Run #${number}`)).toBe('Run');
});

it('keeps private request text out of ordinary command palette labels and searchable titles', async () => {
  const getDefinition = vi.fn();
  const identities = await loadRunIdentities([first], [first], [session], getDefinition, false);
  expect(identities[first.runId]?.name).toBe('Release notes');
  expect(JSON.stringify(identities)).not.toContain('Original request');
  expect(getDefinition).not.toHaveBeenCalled();
});
