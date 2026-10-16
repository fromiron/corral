import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../../examples/research-team.layout.json' with { type: 'json' };
import { definitionHash } from '../definition-hash.ts';
import { type CorralRepository, DEFAULT_PROJECT_ID } from '../repository/index.ts';

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
    describe('projects (CR-010)', () => {
      const create = (repo: CorralRepository, projectId?: string) =>
        repo.save({
          definition: team(),
          layout: { nodes: layoutNodes(), viewport },
          expectedDefinitionRevision: null,
          ...(projectId ? { projectId } : {}),
        });

      it('[WBTST-001] starts with the default project, and new Corrals belong to it', async () => {
        const repo = makeRepository();
        const projects = await repo.listProjects();
        expect(projects.map((p) => [p.projectId, p.name, p.archivedAt])).toEqual([
          [DEFAULT_PROJECT_ID, '', null],
        ]);
        const created = await create(repo);
        if (!created.ok) throw new Error(created.message);
        expect(created.record.projectId).toBe(DEFAULT_PROJECT_ID);
        expect((await repo.list())[0]?.projectId).toBe(DEFAULT_PROJECT_ID);
      });

      it('[WBTST-001] creates projects without a folder, told apart by id even with one name', async () => {
        const repo = makeRepository();
        const a = await repo.createProject({ name: '  Docs  ', description: 'Writing' });
        const b = await repo.createProject({ name: 'Docs' });
        if (!a.ok || !b.ok) throw new Error('create failed');
        expect(a.project).toMatchObject({ name: 'Docs', description: 'Writing', revision: 1 });
        expect(a.project.projectId).toMatch(/^project_/);
        expect(b.project.projectId).not.toBe(a.project.projectId);
        const ids = (await repo.listProjects()).map((p) => p.projectId);
        expect(ids[0]).toBe(DEFAULT_PROJECT_ID);
        expect(ids.slice(1).sort()).toEqual([a.project.projectId, b.project.projectId].sort());
        expect(await repo.createProject({ name: '   ' })).toMatchObject({
          ok: false,
          error: 'invalid',
        });
      });

      it('creates a Corral in the project asked for, and its copy stays there', async () => {
        const repo = makeRepository();
        const project = await repo.createProject({ name: 'Research' });
        if (!project.ok) throw new Error(project.message);
        const created = await create(repo, project.project.projectId);
        if (!created.ok) throw new Error(created.message);
        expect(created.record.projectId).toBe(project.project.projectId);
        const copy = await repo.duplicate(created.record.corralId, 'Copy');
        if (!copy.ok) throw new Error(copy.message);
        expect(copy.record.projectId).toBe(project.project.projectId);
        // A later save keeps the project.
        const saved = await repo.save({
          definition: { ...created.record.definition, name: 'Renamed' },
          layout: { nodes: layoutNodes(), viewport },
          expectedDefinitionRevision: 1,
        });
        expect(saved.ok && saved.record.projectId).toBe(project.project.projectId);
        expect(await create(repo, 'project_missing')).toMatchObject({
          ok: false,
          error: 'not_found',
        });
      });

      it('renames and archives with a revision, and never archives the default', async () => {
        const repo = makeRepository();
        const created = await repo.createProject({ name: 'Old' });
        if (!created.ok) throw new Error(created.message);
        const id = created.project.projectId;
        const renamed = await repo.updateProject(id, { name: 'New', expectedRevision: 1 });
        expect(renamed).toMatchObject({ ok: true, project: { name: 'New', revision: 2 } });
        expect(await repo.updateProject(id, { name: 'Stale', expectedRevision: 1 })).toMatchObject({
          ok: false,
          error: 'revision_conflict',
        });
        const archived = await repo.updateProject(id, { archived: true, expectedRevision: 2 });
        expect(archived.ok && archived.project.archivedAt).toBeTruthy();
        // Archived is hidden, not deleted: it is still listed, and Corrals cannot be made there.
        expect((await repo.listProjects()).some((p) => p.projectId === id)).toBe(true);
        expect(await create(repo, id)).toMatchObject({ ok: false, error: 'not_found' });
        const restored = await repo.updateProject(id, { archived: false, expectedRevision: 3 });
        expect(restored.ok && restored.project.archivedAt).toBeNull();
        expect(
          await repo.updateProject(DEFAULT_PROJECT_ID, { archived: true, expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        expect(
          await repo.updateProject('project_missing', { name: 'x', expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'not_found' });
      });

      it('moves a Corral to another project, but not to a missing or archived one', async () => {
        const repo = makeRepository();
        const created = await create(repo);
        const target = await repo.createProject({ name: 'Target' });
        const archived = await repo.createProject({ name: 'Archived' });
        if (!created.ok || !target.ok || !archived.ok) throw new Error('setup failed');
        await repo.updateProject(archived.project.projectId, {
          archived: true,
          expectedRevision: 1,
        });
        const corralId = created.record.corralId;
        const moved = await repo.moveCorral(corralId, target.project.projectId);
        expect(moved.ok && moved.record.projectId).toBe(target.project.projectId);
        expect(moved.ok && moved.record.definitionRevision).toBe(1);
        expect((await repo.get(corralId))?.projectId).toBe(target.project.projectId);
        expect(await repo.moveCorral(corralId, archived.project.projectId)).toMatchObject({
          ok: false,
          error: 'not_found',
        });
        expect(await repo.moveCorral(corralId, 'project_missing')).toMatchObject({
          ok: false,
          error: 'not_found',
        });
        expect(await repo.moveCorral('corral_missing', DEFAULT_PROJECT_ID)).toMatchObject({
          ok: false,
          error: 'not_found',
        });
      });
    });
  });
}
