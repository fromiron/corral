import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../../examples/research-team.layout.json' with { type: 'json' };
import { definitionHash } from '../definition-hash.ts';
import type { CorralRepository } from '../repository/index.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const team = () => CorralDefinition.parse(researchTeam);
const layoutNodes = () => clone((researchLayout as unknown as CanvasLayout).nodes);
const viewport = { x: 0, y: 0, zoom: 1 };

/**
 * Behaviour every CorralRepository must share (C-009, C-011): the browser store and the
 * server's SQLite store. Corral ids come from the repository (`corral_…`).
 */
export function describeCorralRepositoryContract(
  name: string,
  makeRepository: () => CorralRepository,
) {
  describe(`CorralRepository contract: ${name}`, () => {
    it('[TC-CAN-002-H] saving a layout move bumps only the layout revision', async () => {
      const repo = makeRepository();
      const created = await repo.save({
        definition: team(),
        layout: { nodes: layoutNodes(), viewport },
        expectedDefinitionRevision: null,
      });
      if (!created.ok) throw new Error(created.message);
      expect(created.record).toMatchObject({ definitionRevision: 1, layoutRevision: 1 });
      expect(created.record.corralId).toMatch(/^corral_/);
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
      const repo = makeRepository();
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
      const repo = makeRepository();
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

    it('saves work in progress that is not runnable yet', async () => {
      const repo = makeRepository();
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
}
