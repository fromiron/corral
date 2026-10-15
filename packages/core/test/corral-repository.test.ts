import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
import {
  createKeyValueCorralRepository,
  definitionHash,
  type KeyValueStore,
} from '../src/index.ts';

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

describe('corral repository', () => {
  it('[TC-CAN-002-H] saving a layout move bumps only the layout revision', async () => {
    const { repo } = setup();
    const created = await repo.save({
      definition: team(),
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error(created.message);
    expect(created.record).toMatchObject({ definitionRevision: 1, layoutRevision: 1 });
    expect(created.record.corralId).toBe('corral_0001');
    expect(created.record.definition.id).toBe('corral_0001');
    expect(created.record.definitionHash).toBe(definitionHash(created.record.definition));

    const moved = layoutNodes();
    (moved.research as { x: number }).x += 200;
    const saved = created.record.definition;
    const afterMove = await repo.save({
      definition: saved,
      layout: { nodes: moved, viewport },
      expectedDefinitionRevision: 1,
    });
    if (!afterMove.ok) throw new Error(afterMove.message);
    expect(afterMove.record).toMatchObject({ definitionRevision: 1, layoutRevision: 2 });
    expect(afterMove.changed).toEqual({ definition: false, layout: true });

    const edited = clone(saved);
    (edited.roles[0] as { prompt: string }).prompt += ' Use primary sources only.';
    const afterEdit = await repo.save({
      definition: edited,
      layout: { nodes: moved, viewport },
      expectedDefinitionRevision: 1,
    });
    if (!afterEdit.ok) throw new Error(afterEdit.message);
    expect(afterEdit.record).toMatchObject({ definitionRevision: 2, layoutRevision: 2 });
  });

  it('refuses a save based on an older definition revision (two tabs)', async () => {
    const { repo } = setup();
    const created = await repo.save({
      definition: team(),
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error('create failed');
    const edited = { ...created.record.definition, name: 'Edited in tab A' };
    await repo.save({
      definition: edited,
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: 1,
    });
    const stale = await repo.save({
      definition: created.record.definition,
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: 1,
    });
    expect(stale).toMatchObject({ ok: false, error: 'revision_conflict' });
  });

  it('lists, reads, duplicates under a new id, and removes', async () => {
    const { repo } = setup();
    const created = await repo.save({
      definition: team(),
      layout: { nodes: layoutNodes(), viewport },
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error('create failed');
    const copy = await repo.duplicate(created.record.corralId, 'Research copy');
    if (!copy.ok) throw new Error(copy.message);
    expect(copy.record.corralId).not.toBe(created.record.corralId);
    expect(copy.record.definition.id).toBe(copy.record.corralId);
    expect(copy.record.layout.corralId).toBe(copy.record.corralId);
    expect(copy.record).toMatchObject({
      name: 'Research copy',
      definitionRevision: 1,
      layoutRevision: 1,
    });

    expect((await repo.list()).map((c) => c.name).sort()).toEqual(
      ['Research copy', team().name].sort(),
    );
    await repo.remove(created.record.corralId);
    expect(await repo.get(created.record.corralId)).toBeNull();
    expect(await repo.list()).toHaveLength(1);
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

  it('saves work in progress that is not runnable yet', async () => {
    const { repo } = setup();
    const empty = {
      ...team(),
      entryNodeId: '',
      roles: [],
      nodes: [],
      controlEdges: [],
      capabilityLinks: [],
    };
    const result = await repo.save({
      definition: empty,
      layout: { nodes: {}, viewport },
      expectedDefinitionRevision: null,
    });
    expect(result.ok).toBe(true);
  });
});
