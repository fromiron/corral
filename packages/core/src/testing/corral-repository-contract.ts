import { type CanvasLayout, CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../../examples/research-team.layout.json' with { type: 'json' };
import { createTextAttachment } from '../attachments.ts';
import { definitionHash } from '../definition-hash.ts';
import { type CorralRepository, DEFAULT_PROJECT_ID } from '../repository/index.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const team = () => CorralDefinition.parse(researchTeam);
const layoutNodes = () => clone((researchLayout as unknown as CanvasLayout).nodes);
const viewport = { x: 0, y: 0, zoom: 1 };

/**
 * Behaviour every CorralRepository must share: the browser store and the
 * server's SQLite store. Corral ids come from the repository (`corral_…`).
 */
export function describeCorralRepositoryContract(
  name: string,
  makeRepository: () => CorralRepository,
) {
  describe(`CorralRepository contract: ${name}`, () => {
    it('saving a layout move bumps only the layout revision', async () => {
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
    describe('projects', () => {
      const create = (repo: CorralRepository, projectId?: string) =>
        repo.save({
          definition: team(),
          layout: { nodes: layoutNodes(), viewport },
          expectedDefinitionRevision: null,
          ...(projectId ? { projectId } : {}),
        });

      it('starts with the default project, and new Corrals belong to it', async () => {
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

      it('creates projects without a folder, told apart by id even with one name', async () => {
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
    describe('work sessions', () => {
      it('an opted-in title is finalized once with the first request and persists', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({
          projectId: 'default',
          title: 'New session',
          autoTitle: true,
        });
        if (!created.ok) throw new Error(created.message);
        const id = created.session.sessionId;
        expect((await repo.getSession(id))?.autoTitle).toBe(true);
        const request = {
          intent: 'next' as const,
          text: '  Compare the storage options\nKeep the sources.  ',
          state: 'started' as const,
          commandId: 'title_first',
          runId: 'run_first',
        };
        const first = await repo.addSessionEntry(id, request);
        if (!first.ok) throw new Error(first.message);
        expect(first.session).toMatchObject({
          title: 'Compare the storage options',
          autoTitle: false,
          revision: 2,
        });
        const duplicate = await repo.addSessionEntry(id, request);
        expect(duplicate).toEqual(first);
        await repo.addSessionEntry(id, {
          intent: 'next',
          text: 'A different follow-up',
          state: 'refused',
        });
        await repo.updateSessionEntry(id, first.session.entries[0]?.entryId ?? '', {
          state: 'undelivered',
        });
        expect((await repo.getSession(id))?.title).toBe('Compare the storage options');
        expect((await repo.listSessions('default'))[0]?.title).toBe('Compare the storage options');
        expect(await repo.updateSession(id, { title: 'Stale', expectedRevision: 1 })).toMatchObject(
          { ok: false, error: 'revision_conflict' },
        );
      });

      it('explicit, renamed and legacy titles survive later requests even when named New session', async () => {
        const repo = makeRepository();
        for (const autoTitle of [false, true]) {
          const made = await repo.createSession({
            projectId: 'default',
            title: 'New session',
            ...(autoTitle ? { autoTitle: true } : {}),
          });
          if (!made.ok) throw new Error(made.message);
          if (autoTitle) {
            const renamed = await repo.updateSession(made.session.sessionId, {
              title: 'New session',
              expectedRevision: 1,
            });
            expect(renamed.ok && renamed.session.autoTitle).toBe(false);
          }
          await repo.addSessionEntry(made.session.sessionId, {
            intent: 'next',
            text: 'Do not overwrite my name',
            state: 'started',
          });
          expect((await repo.getSession(made.session.sessionId))?.title).toBe('New session');
        }
      });

      it('invalid requests do not consume automatic naming; queued Unicode text is bounded without splitting characters', async () => {
        const repo = makeRepository();
        const made = await repo.createSession({
          projectId: 'default',
          title: '새 세션',
          autoTitle: true,
        });
        if (!made.ok) throw new Error(made.message);
        const id = made.session.sessionId;
        expect(
          await repo.addSessionEntry(id, { intent: 'next', text: ' ', state: 'started' }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        expect((await repo.getSession(id))?.autoTitle).toBe(true);
        const result = await repo.addSessionEntry(id, {
          intent: 'queue',
          text: '🙂'.repeat(80),
          state: 'queued',
          commandId: 'unicode_title',
        });
        expect(result.ok && result.session.title).toBe('🙂'.repeat(60));
        expect(
          await repo.addSessionEntry(id, {
            intent: 'queue',
            text: 'changed',
            state: 'queued',
            commandId: 'unicode_title',
          }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        expect((await repo.getSession(id))?.title).toBe('🙂'.repeat(60));
      });

      it('creates sessions from a purpose alone, pins, archives, and keeps entries', async () => {
        const repo = makeRepository();
        const project = await repo.createProject({ name: 'P' });
        if (!project.ok) throw new Error(project.message);
        const projectId = project.project.projectId;
        const a = await repo.createSession({
          projectId,
          title: '',
          objective: 'Compare two DBs\nmore',
        });
        const b = await repo.createSession({ projectId, title: 'Second' });
        if (!a.ok || !b.ok) throw new Error('create failed');
        expect(a.session).toMatchObject({ title: 'Compare two DBs', pinned: false, revision: 1 });
        expect(await repo.createSession({ projectId, title: ' ' })).toMatchObject({
          ok: false,
          error: 'invalid',
        });
        expect(
          await repo.createSession({ projectId: 'project_missing', title: 'x' }),
        ).toMatchObject({
          ok: false,
          error: 'not_found',
        });

        const pinned = await repo.updateSession(a.session.sessionId, {
          pinned: true,
          expectedRevision: 1,
        });
        expect(pinned.ok && pinned.session.pinned).toBe(true);
        expect((await repo.listSessions(projectId)).map((x) => x.sessionId)[0]).toBe(
          a.session.sessionId,
        );
        expect(
          await repo.updateSession(a.session.sessionId, { title: 'x', expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'revision_conflict' });
        expect(await repo.listSessions('default')).toEqual([]);

        const added = await repo.addSessionEntry(b.session.sessionId, {
          intent: 'queue',
          text: 'Then summarise it',
          state: 'queued',
        });
        if (!added.ok) throw new Error(added.message);
        const entry = added.session.entries[0];
        expect(entry).toMatchObject({
          intent: 'queue',
          text: 'Then summarise it',
          state: 'queued',
        });
        const started = await repo.updateSessionEntry(b.session.sessionId, entry?.entryId ?? '', {
          state: 'started',
          runId: 'run_1',
        });
        expect(started.ok && started.session.entries[0]).toMatchObject({
          text: 'Then summarise it',
          state: 'started',
          runId: 'run_1',
        });
        const reread = await repo.getSession(b.session.sessionId);
        expect(reread?.entries).toHaveLength(1);
        const archived = await repo.updateSession(b.session.sessionId, {
          archived: true,
          expectedRevision: reread?.revision ?? 0,
        });
        expect(archived.ok && archived.session.archivedAt).toBeTruthy();
        expect((await repo.getSession(b.session.sessionId))?.entries).toHaveLength(1);
      });

      it('does not replace a settled queued entry with a late conflicting outcome', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({ projectId: 'default', title: 'Queue' });
        if (!created.ok) throw new Error(created.message);
        const id = created.session.sessionId;
        const saved = await repo.addSessionEntry(id, {
          intent: 'queue',
          text: 'Once',
          state: 'queued',
        });
        if (!saved.ok) throw new Error(saved.message);
        const entryId = saved.session.entries[0]?.entryId ?? '';
        const outcome = { state: 'started' as const, runId: 'winner', detail: null, refusal: null };
        const started = await repo.updateSessionEntry(id, entryId, outcome);
        expect(started.ok).toBe(true);
        expect(await repo.updateSessionEntry(id, entryId, outcome)).toEqual(started);
        for (const change of [
          { state: 'refused' as const, runId: null, detail: 'Other tab lost' },
          { state: 'started' as const, runId: 'different' },
          { state: 'dismissed' as const },
        ])
          expect(await repo.updateSessionEntry(id, entryId, change)).toMatchObject({
            ok: false,
            error: 'revision_conflict',
          });
        expect((await repo.getSession(id))?.entries[0]).toMatchObject(outcome);
      });

      it('retains a confirmed first run when its start receipt arrives after a non-start outcome', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({ projectId: 'default', title: 'Queue race' });
        if (!created.ok) throw new Error(created.message);
        const id = created.session.sessionId;
        for (const state of ['refused', 'dismissed'] as const) {
          const saved = await repo.addSessionEntry(id, {
            intent: 'queue',
            text: state,
            state: 'queued',
          });
          if (!saved.ok) throw new Error(saved.message);
          const entryId = saved.session.entries.at(-1)?.entryId ?? '';
          expect((await repo.updateSessionEntry(id, entryId, { state })).ok).toBe(true);
          const started = await repo.updateSessionEntry(id, entryId, {
            state: 'started',
            runId: `run_${state}`,
          });
          expect(started.ok && started.session.entries.at(-1)).toMatchObject({
            state: 'started',
            runId: `run_${state}`,
          });
        }
      });

      it('new sessions are auto; the auto model and reasoning save with a revision; a team keeps its team', async () => {
        const repo = makeRepository();
        const auto = await repo.createSession({ projectId: 'default', title: 'Quick question' });
        if (!auto.ok) throw new Error(auto.message);
        expect(auto.session).toMatchObject({ corralId: null, auto: null });
        const chosen = await repo.updateSession(auto.session.sessionId, {
          auto: { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'high' } },
          expectedRevision: 1,
        });
        expect(chosen.ok && chosen.session.auto).toEqual({
          modelProfile: 'model-b',
          reasoning: { mode: 'fixed', level: 'high' },
        });
        expect((await repo.getSession(auto.session.sessionId))?.auto).toEqual({
          modelProfile: 'model-b',
          reasoning: { mode: 'fixed', level: 'high' },
        });
        const entry = await repo.addSessionEntry(auto.session.sessionId, {
          intent: 'next',
          text: 'What is a run?',
          state: 'started',
          runId: 'run_1',
          auto: { template: 'single', source: 'model' },
        });
        expect(entry.ok && entry.session.entries[0]?.auto).toEqual({
          template: 'single',
          source: 'model',
        });
        const team = await repo.createSession({
          projectId: 'default',
          title: 'With a team',
          corralId: 'corral_x',
        });
        expect(team.ok && team.session).toMatchObject({ corralId: 'corral_x', auto: null });
      });

      it('a meeting keeps its participants and rounds; a work session never becomes one', async () => {
        const repo = makeRepository();
        const config = {
          version: 1 as const,
          participants: [
            { participantId: 'a', name: 'A', prompt: 'One view.', modelProfile: 'model-a' },
            { participantId: 'b', name: 'B', prompt: 'Another view.', modelProfile: 'model-b' },
          ],
          secretary: { modelProfile: 'model-a' },
        };
        const made = await repo.createSession({
          projectId: 'default',
          title: 'Meet',
          meeting: config,
        });
        if (!made.ok) throw new Error(made.message);
        expect(made.session.meeting).toEqual({ config, rounds: [], queued: null });
        const round = {
          roundId: 'round_1',
          commandId: 'c1',
          kind: 'all' as const,
          message: 'Hello',
          basedOnRoundId: null,
          rebuttalNo: null,
          participantIds: ['a', 'b'],
          answers: [
            { participantId: 'a', runId: 'run_1', state: 'started' as const, detail: null },
            { participantId: 'b', runId: null, state: 'refused' as const, detail: 'no model' },
          ],
          createdAt: '2026-10-23T00:00:00.000Z',
          stoppedAt: null,
        };
        const meeting = { config, rounds: [round], queued: null };
        const saved = await repo.updateSession(made.session.sessionId, {
          meeting,
          expectedRevision: 1,
        });
        expect(saved.ok).toBe(true);
        expect((await repo.getSession(made.session.sessionId))?.meeting).toEqual(meeting);
        expect(
          await repo.updateSession(made.session.sessionId, { meeting, expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'revision_conflict' });
        expect(
          await repo.addSessionEntry(made.session.sessionId, {
            intent: 'next',
            text: 'x',
            state: 'started',
          }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        const work = await repo.createSession({ projectId: 'default', title: 'Work' });
        if (!work.ok) throw new Error(work.message);
        expect(work.session.meeting).toBeUndefined();
        expect(
          await repo.updateSession(work.session.sessionId, { meeting, expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        expect(
          await repo.createSession({
            projectId: 'default',
            title: 'Bad',
            meeting: { ...config, participants: [config.participants[0]!] },
          }),
        ).toMatchObject({ ok: false, error: 'invalid' });
      });

      it('a stale revision or a malformed auto choice saves nothing', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({ projectId: 'default', title: 'S' });
        if (!created.ok) throw new Error(created.message);
        const id = created.session.sessionId;
        await repo.updateSession(id, { auto: { modelProfile: 'model-a' }, expectedRevision: 1 });
        expect(
          await repo.updateSession(id, { auto: { modelProfile: 'model-b' }, expectedRevision: 1 }),
        ).toMatchObject({ ok: false, error: 'revision_conflict' });
        for (const bad of [
          { modelProfile: '' },
          { modelProfile: 'model-a', reasoning: { mode: 'fixed', level: 'huge' } },
          { modelProfile: 'model-a', tools: ['shell'] },
        ]) {
          expect(
            await repo.updateSession(id, { auto: bad as never, expectedRevision: 2 }),
          ).toMatchObject({ ok: false, error: 'invalid' });
        }
        expect((await repo.getSession(id))?.auto).toEqual({ modelProfile: 'model-a' });
      });

      it('an auto session can let the start model choose the reasoning', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({ projectId: 'default', title: 'S' });
        if (!created.ok) throw new Error(created.message);
        const saved = await repo.updateSession(created.session.sessionId, {
          auto: { modelProfile: 'model-a', reasoning: { mode: 'route' } },
          expectedRevision: 1,
        });
        expect(saved.ok && saved.session.auto).toEqual({
          modelProfile: 'model-a',
          reasoning: { mode: 'route' },
        });
        const request = {
          commandId: 'cmd_record_once',
          taskScope: 'review_only' as const,
          attachments: [createTextAttachment('notes.txt', 'text/plain', 'Private source')],
          intent: 'next' as const,
          text: 'Hi',
          state: 'started' as const,
          auto: {
            template: 'single' as const,
            source: 'model' as const,
            reasoning: 'low' as const,
          },
        };
        const entry = await repo.addSessionEntry(created.session.sessionId, request);
        const duplicate = await repo.addSessionEntry(created.session.sessionId, request);
        expect(duplicate.ok && duplicate.session.entries).toHaveLength(1);
        expect(duplicate.ok && duplicate.session.entries[0]?.attachments).toEqual(
          request.attachments,
        );
        expect(
          await repo.addSessionEntry(created.session.sessionId, { ...request, text: 'Changed' }),
        ).toMatchObject({ ok: false });
        expect(entry.ok && entry.session.entries[0]?.auto).toEqual({
          template: 'single',
          source: 'model',
          reasoning: 'low',
        });
      });

      it('a queued text snapshot keeps its source through duplicate acceptance and start', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({
          projectId: 'default',
          title: 'Captured context',
        });
        if (!created.ok) throw new Error(created.message);
        const attachment = {
          ...createTextAttachment('check.txt', 'text/plain', 'fixture check output'),
          provenance: {
            kind: 'check' as const,
            hostId: 'host',
            projectId: 'default',
            sessionId: created.session.sessionId,
            verificationId: 'verify_fixture',
            commandId: 'check_fixture',
            tree: 'a'.repeat(40),
          },
        };
        const request = {
          commandId: 'cmd_queue_snapshot',
          intent: 'queue' as const,
          text: 'Use this captured output',
          state: 'queued' as const,
          attachments: [attachment],
        };
        const saved = await repo.addSessionEntry(created.session.sessionId, request);
        expect(saved.ok).toBe(true);
        if (!saved.ok) throw new Error(saved.message);
        const entry = saved.session.entries[0];
        if (!entry) throw new Error('queued entry missing');
        expect(entry.attachments).toEqual([attachment]);
        expect((await repo.addSessionEntry(created.session.sessionId, request)).ok).toBe(true);
        expect((await repo.getSession(created.session.sessionId))?.entries).toHaveLength(1);
        const next = await repo.updateSessionEntry(created.session.sessionId, entry.entryId, {
          state: 'started',
          runId: 'run_fixture',
        });
        expect(next.ok && next.session.entries[0]?.attachments).toEqual([attachment]);
        expect(
          await repo.addSessionEntry(created.session.sessionId, {
            ...request,
            attachments: [
              { ...attachment, provenance: { ...attachment.provenance, tree: 'b'.repeat(40) } },
            ],
          }),
        ).toMatchObject({ ok: false });
        for (const intent of ['steer', 'explain'] as const)
          expect(
            await repo.addSessionEntry(created.session.sessionId, {
              ...request,
              commandId: `cmd_${intent}`,
              intent,
            }),
          ).toMatchObject({ ok: false });
        expect(
          await repo.addSessionEntry(created.session.sessionId, {
            ...request,
            commandId: 'cmd_queue_image',
            images: [
              {
                kind: 'image_attachment',
                imageId: 'image_fixture',
                name: 'image.png',
                mime: 'image/png',
                bytes: 1,
                sha256: 'a'.repeat(64),
                width: 1,
                height: 1,
              },
            ],
          }),
        ).toMatchObject({ ok: false });
      });

      it('a queued auto request keeps its routing explanation and reasoning when started', async () => {
        const repo = makeRepository();
        const created = await repo.createSession({ projectId: 'default', title: 'Auto queue' });
        if (!created.ok) throw new Error(created.message);
        const id = created.session.sessionId;
        const queued = await repo.addSessionEntry(id, {
          commandId: 'queue_with_work_style',
          harness: { profileId: 'trusted_tools', revision: 3 },
          intent: 'queue',
          text: 'Write a reply',
          state: 'queued',
        });
        if (!queued.ok) throw new Error(queued.message);
        expect((await repo.getSession(id))?.entries[0]?.harness).toEqual({
          profileId: 'trusted_tools',
          revision: 3,
        });
        expect(
          await repo.addSessionEntry(id, {
            commandId: 'queue_with_work_style',
            intent: 'queue',
            text: 'Write a reply',
            state: 'queued',
            harness: { profileId: 'trusted_tools', revision: 4 },
          }),
        ).toMatchObject({ ok: false, error: 'invalid' });
        const auto = {
          harness: { profileId: 'trusted_tools', revision: 3 },
          template: 'single' as const,
          source: 'model' as const,
          reason: 'A short question',
          modelProfile: 'model-a',
          requestedReasoning: { mode: 'route' as const },
          reasoning: 'medium' as const,
          reasoningSource: 'fallback' as const,
        };
        const updated = await repo.updateSessionEntry(
          id,
          queued.session.entries[0]?.entryId ?? '',
          {
            state: 'started',
            runId: 'run_auto_queue',
            auto,
          },
        );
        expect(updated.ok && updated.session.entries[0]?.auto).toEqual(auto);
        expect((await repo.getSession(id))?.entries[0]?.auto).toEqual(auto);
      });
    });
  });
}
