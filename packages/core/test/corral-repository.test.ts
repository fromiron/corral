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
