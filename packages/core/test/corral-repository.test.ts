import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
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
const layoutNodes = () => clone((researchLayout as unknown as CanvasLayout).nodes);
const viewport = { x: 0, y: 0, zoom: 1 };

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
  it('[TC-LLM-005-F] migrates browser definitions once and keeps the original revision in the receipt', async () => {
    const { store, repo } = setup();
    const saved = await repo.save({
      definition: team(),
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: null,
    });
    if (!saved.ok) throw new Error(saved.message);
    const reopen = () =>
      createKeyValueCorralRepository(store, {
        clock: new FakeClock(),
        newCorralId: () => 'unused',
      });
    expect((await reopen().get(saved.record.corralId))?.definition.executionPolicy).toEqual({
      version: 2,
    });
    expect((await reopen().get(saved.record.corralId))?.definitionRevision).toBe(
      saved.record.definitionRevision + 1,
    );
    const receipt = [...store.data.entries()].find(([key]) => key.includes('cr052'));
    expect(receipt && JSON.parse(receipt[1]).before).toEqual(saved.record);
  });
  it('[TC-UX-007-N] a failed storage write preserves the pending title and retry records one request', async () => {
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
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error('create failed');
    for (const key of store.data.keys())
      if (key.includes(created.record.corralId)) store.setItem(key, '{"broken":');
    await expect(repo.get(created.record.corralId)).rejects.toThrow(/cannot be read/);
  });
});
