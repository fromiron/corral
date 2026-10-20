import { expect, it } from 'vitest';
import { createStartRecovery } from '../src/recovery.ts';

it('[TC-ABS-014-H] an explicit retry recovers only the exact unresolved saved request in this host', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const original = {
    commandId: 'cmd_original',
    schemaVersion: '0.1',
    corralId: 'corral_one',
    definitionRevision: 3,
    mode: 'mock',
    startFrom: { runId: 'run_previous', artifactVersionId: 'artifact_one' },
    harnessOverrides: { profileId: 'profile_one' },
  };
  createStartRecovery(storage, 'host_one').pending('/runs', original);
  const fresh = { ...original, commandId: 'cmd_new' };
  const journal = createStartRecovery(storage, 'host_one');
  expect(journal.prepare('/runs', fresh)).toEqual(original);
  expect(createStartRecovery(storage, 'host_other').prepare('/runs', fresh)).toEqual(fresh);
  for (const changed of [
    { ...fresh, definitionRevision: 4 },
    { ...fresh, mode: 'live' },
    { ...fresh, corralId: 'corral_two' },
    { ...fresh, startFrom: { ...fresh.startFrom, artifactVersionId: 'artifact_two' } },
    { ...fresh, harnessOverrides: { profileId: 'profile_two' } },
  ])
    expect(journal.prepare('/runs', changed)).toEqual(changed);
  expect(journal.prepare('/runs/auto', fresh)).toEqual(fresh);
  journal.confirmed(original.commandId);
  expect(journal.prepare('/runs', fresh)).toEqual(fresh);
});
