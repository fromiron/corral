import { CorralDefinition } from '@corral/contracts';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { createKeyValueCorralRepository, type KeyValueStore } from '../src/index.ts';
import { describeCorralRepositoryContract } from '../src/testing/index.ts';

class MapStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const team = () => CorralDefinition.parse(researchTeam);

function setup() {
  const store = new MapStore();
  const ids = new SequentialIdFactory();
  const repo = createKeyValueCorralRepository(store, {
    clock: new FakeClock(),
    newCorralId: () => ids.next('run').replace('run', 'corral'),
  });
  return { store, repo };
}

describeCorralRepositoryContract('key-value (browser)', () => setup().repo);

describe('key-value corral repository', () => {
  it('a failed storage write preserves the pending title and retry records one request', async () => {
    const { store, repo } = setup();
    const created = await repo.createSession({
      projectId: 'default',
      title: 'New session',
      autoTitle: true,
    });
    if (!created.ok) throw new Error(created.message);
    const originalWrite = store.setItem.bind(store);
    store.setItem = () => {
      throw new Error('storage is full');
    };
    const entry = {
      intent: 'next' as const,
      text: 'Persist this title atomically',
      state: 'started' as const,
      commandId: 'title_retry',
    };
    const failed = await repo.addSessionEntry(created.session.sessionId, entry);
    expect(failed).toMatchObject({ ok: false, error: 'storage_unavailable' });
    expect(await repo.getSession(created.session.sessionId)).toMatchObject({
      title: 'New session',
      autoTitle: true,
      entries: [],
    });
    store.setItem = originalWrite;
    const saved = await repo.addSessionEntry(created.session.sessionId, entry);
    expect(saved.ok && saved.session.title).toBe(entry.text);
    await repo.addSessionEntry(created.session.sessionId, entry);
    expect((await repo.getSession(created.session.sessionId))?.entries).toHaveLength(1);
  });

  it('refuses stored data it cannot read instead of guessing', async () => {
    const { store, repo } = setup();
    const created = await repo.save({
      definition: team(),
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error('create failed');
    for (const key of store.data.keys())
      if (key.includes(created.record.corralId)) store.setItem(key, '{"broken":');
    await expect(repo.get(created.record.corralId)).rejects.toThrow(/cannot be read/);
  });
});

it('preserves structured refusal diagnostics when a session is reopened', async () => {
  const { repo } = setup();
  const made = await repo.createSession({ projectId: 'default', title: 'diagnostics' });
  if (!made.ok) throw new Error(made.message);
  const refusal = {
    code: 'RUN_ALREADY_ACTIVE' as const,
    message: 'termination unconfirmed',
    owner: {
      kind: 'terminal' as const,
      id: 'owner',
      sessionId: made.session.sessionId,
      state: 'uncertain' as const,
    },
  };
  const appended = await repo.addSessionEntry(made.session.sessionId, {
    intent: 'next',
    text: 'try',
    state: 'refused',
    detail: refusal.message,
    refusal,
  });
  expect(appended.ok).toBe(true);
  expect((await repo.getSession(made.session.sessionId))?.entries[0]?.refusal).toEqual(refusal);
});
