import type { Clock, LibraryAgentRole } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentLibrary, AgentLibraryResult, CorralRepository } from '../repository/index.ts';

const role: LibraryAgentRole = {
  name: 'Writer',
  prompt: 'Write the summary.',
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: [],
  outputContract: 'draft',
  reasoning: { mode: 'fixed', level: 'low' },
  skills: [],
};
const create = { role, operationId: 'create_writer' };
function saved(result: AgentLibraryResult) {
  if (!result.ok) throw new Error(result.message);
  return result.agent;
}

export function describeAgentLibraryContract(
  name: string,
  setup: () => {
    agents: AgentLibrary;
    projects: Pick<CorralRepository, 'createProject' | 'updateProject'>;
    clock: Pick<Clock, 'nowIso'> & { advance(ms: number): void };
  },
) {
  describe(`AgentLibrary contract: ${name}`, () => {
    it('starts empty, creates independent originals and lists them in stable creation order', async () => {
      const { agents, clock } = setup();
      expect(await agents.list('default')).toEqual([]);
      expect(await agents.get('default', 'agent_missing')).toBeNull();
      const first = saved(await agents.create('default', create));
      expect(first).toEqual({
        agentId: expect.stringMatching(/^agent_/),
        projectId: 'default',
        role,
        revision: 1,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        archivedAt: null,
      });
      clock.advance(1000);
      const second = saved(await agents.create('default', { role, operationId: 'duplicate' }));
      expect(second.agentId).not.toBe(first.agentId);
      expect(await agents.get('default', first.agentId)).toEqual(first);
      expect(await agents.list('default')).toEqual([first, second]);
    });

    it('replays the first response for equal content even after later edits, never overwriting them', async () => {
      const { agents, clock } = setup();
      const first = await agents.create('default', create);
      const { agentId } = saved(first);
      clock.advance(1000);
      const equivalent: LibraryAgentRole = { ...role, reasoning: { level: 'low', mode: 'fixed' } };
      expect(await agents.create('default', { ...create, role: equivalent })).toEqual(first);
      expect(
        saved(await agents.update('default', agentId, { role: equivalent, expectedRevision: 1 })),
      ).toEqual(saved(first));
      const changedRole = { ...role, prompt: 'Write the final answer.' };
      const changed = saved(
        await agents.update('default', agentId, { role: changedRole, expectedRevision: 1 }),
      );
      expect(changed).toEqual({
        ...saved(first),
        revision: 2,
        updatedAt: clock.nowIso(),
        role: changedRole,
      });
      expect(await agents.create('default', create)).toEqual(first);
      expect(await agents.create('default', { ...create, role: changedRole })).toMatchObject({
        ok: false,
        error: 'operation_conflict',
      });
      expect(
        await agents.update('default', agentId, { role, archived: true, expectedRevision: 1 }),
      ).toMatchObject({ ok: false, error: 'revision_conflict' });
      expect(await agents.list('default')).toEqual([changed]);
    });

    it('archives and restores without changing the role or its revision', async () => {
      const { agents, clock } = setup();
      const first = saved(await agents.create('default', create));
      clock.advance(1000);
      const archive = { archived: true, expectedRevision: 1 };
      const archived = saved(await agents.update('default', first.agentId, archive));
      expect(archived).toEqual({ ...first, archivedAt: clock.nowIso(), updatedAt: clock.nowIso() });
      expect(await agents.list('default')).toEqual([archived]);
      clock.advance(1000);
      const restored = saved(
        await agents.update('default', first.agentId, { ...archive, archived: false }),
      );
      expect(restored).toEqual({ ...first, updatedAt: clock.nowIso() });
      expect(await agents.get('default', first.agentId)).toEqual(restored);
    });

    it('isolates reads, writes and operation IDs by project, and refuses creation outside active projects', async () => {
      const { projects, agents } = setup();
      const other = await projects.createProject({ name: 'Other' });
      if (!other.ok) throw new Error(other.message);
      const { projectId, revision } = other.project;
      const first = saved(await agents.create('default', create));
      expect(await agents.get(projectId, first.agentId)).toBeNull();
      expect(await agents.list(projectId)).toEqual([]);
      expect(
        await agents.update(projectId, first.agentId, { expectedRevision: 1, archived: true }),
      ).toMatchObject({ ok: false, error: 'not_found' });
      expect(await agents.get('default', first.agentId)).toEqual(first);
      const second = saved(
        await agents.create(projectId, { ...create, role: { ...role, name: 'Other' } }),
      );
      expect(second.agentId).not.toBe(first.agentId);
      expect(await agents.list(projectId)).toEqual([second]);
      expect(
        await projects.updateProject(projectId, { archived: true, expectedRevision: revision }),
      ).toMatchObject({ ok: true });
      for (const target of [projectId, 'missing']) {
        expect(await agents.create(target, { ...create, operationId: 'again' })).toMatchObject({
          ok: false,
          error: 'not_found',
        });
      }
      expect(await agents.list(projectId)).toEqual([second]);
    });

    it('rejects invalid direct writes without creating a receipt or changing a record', async () => {
      const { agents } = setup();
      const invalid = { ...create, role: { ...role, id: 'team_only' } };
      expect(await agents.create('default', invalid)).toMatchObject({
        ok: false,
        error: 'invalid',
      });
      const first = saved(await agents.create('default', create));
      expect(await agents.update('default', first.agentId, { expectedRevision: 1 })).toMatchObject({
        ok: false,
        error: 'invalid',
      });
      expect(await agents.list('default')).toEqual([first]);
    });
  });
}
