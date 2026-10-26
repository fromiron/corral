import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessProfile, SkillEvaluationRequest } from '@corral/contracts';
import { autoDefinition, Coordinator, executeOnce, InProcessTransport } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { HarnessService } from '../src/harness/service.ts';
import { SkillQualityService } from '../src/harness/skill-quality.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'corral-skill-eval-'));
  const db = openDatabase(':memory:');
  const clock = new FakeClock();
  const harness = new HarnessService({
    root: join(root, 'resources'),
    db,
    clock,
    inspect: async () => ({
      name: 'writing',
      version: '1.0.0',
      license: 'MIT',
      packagePath: null,
      extensions: [],
      skills: [{ name: 'writing', description: 'For writing tasks', entry: 'skills/SKILL.md' }],
    }),
  });
  const make = async (content: string) => {
    const review = await harness.reviewDocument({
      kind: 'skill',
      name: 'Writing',
      content: `---\nname: writing\ndescription: For writing tasks\n---\n${content}`,
    });
    const saved = harness.install(review.reviewId);
    harness.trust(saved.hash, true);
    return { resourceHash: saved.hash, kind: 'skill' as const, entry: 'skills/SKILL.md' };
  };
  const baseline = await make('Keep the answer brief.');
  const candidate = await make('Keep the answer brief and clear.');
  const profile: HarnessProfile = {
    name: 'Personal',
    policy: 'strict',
    allowedTools: ['read', 'write_artifact', 'submit_result'],
    startupCommands: [],
    resources: [{ ...baseline, required: true, skillMode: 'auto' }],
  };
  harness.saveProfile('personal', 0, profile);
  harness.setDefault('personal', 'default', 0, { profileId: 'personal', revision: 1 });
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    reply: () => 'fixture output',
  });
  const coordinator = new Coordinator({
    clock,
    ids: new SequentialIdFactory(),
    harnesses: harness,
    agents: {
      start: async (input, host) => {
        if (input.harness)
          await host.reportHarness!({
            ok: true,
            snapshotHash: input.harness.snapshotHash,
            tools: input.harness.allowedTools.map((name) => ({
              name,
              source: 'corral',
              schemaHash: 'b'.repeat(64),
              exposure: 'direct',
              sideEffect: 'none',
            })),
            diagnostics: [],
          });
        return scripted.start(input, {
          ...host,
          prepareModelRequest: () =>
            host.prepareModelRequest({
              purpose: 'turn',
              directiveIds: [],
              contextHash: 'c'.repeat(64),
              contextBytes: 10,
              sections: [],
            }),
        });
      },
    },
  });
  const service = new SkillQualityService({ db, clock, harness, coordinator });
  cleanups.push(async () => {
    await service.close();
    await harness.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request: SkillEvaluationRequest = {
    operationId: 'evaluate',
    candidate,
    baseline,
    mode: 'mock',
    modelProfile: 'model',
    fixtures: [
      {
        id: 'positive',
        brief: 'Write a note',
        expected: { kind: 'exact', text: 'fixture output' },
        shouldActivate: true,
        phase: 'calibration',
      },
      {
        id: 'negative',
        brief: 'Calculate 2+2',
        expected: { kind: 'exact', text: 'fixture output' },
        shouldActivate: false,
        phase: 'holdout',
      },
    ],
  };
  return { service, harness, coordinator, request, profile, db, root, clock };
}
it('initialization failure records terminal evidence and archives its private profiles', async () => {
  const f = await fixture();
  vi.spyOn(f.harness, 'sealEvaluationDefinition').mockImplementationOnce(() => {
    throw new Error('injected seal failure');
  });
  expect(() => f.service.start(f.request)).toThrow('injected seal failure');
  expect(f.service.get(f.request.operationId).status).toBe('failed');
  expect(
    f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM harness_profile_management WHERE archived_at IS NULL AND profile_id LIKE 'eval_%'",
      )
      .get(),
  ).toEqual({ n: 0 });
  expect(f.service.start(f.request).status).toBe('failed');
  expect(f.service.get(f.request.operationId).runIds).toEqual([]);
});
it('a failed evidence callback cancels its owned run', async () => {
  const f = await fixture();
  let id = '';
  await expect(
    executeOnce(
      new InProcessTransport(f.coordinator),
      autoDefinition({
        id: 'callback-failure',
        template: 'single',
        brief: 'Test',
        choice: { modelProfile: 'model' },
        fileTools: false,
      }),
      'mock',
      {
        signal: new AbortController().signal,
        onStart(runId) {
          id = runId;
          throw new Error('evidence write failed');
        },
      },
    ),
  ).rejects.toThrow('evidence write failed');
  expect(f.coordinator.getSnapshot(id).projection.status).toBe('cancelled');
});
it('compares immutable revisions through the existing eval runtime without changing defaults', async () => {
  const f = await fixture();
  const first = f.service.start(f.request);
  expect(f.service.start(f.request).id).toBe(first.id);
  const done = await f.service.wait(first.id);
  expect(done.status).toBe('completed');
  expect(done.results).toHaveLength(4);
  expect(new Set(done.runIds).size).toBe(4);
  expect(done.results.every((row) => row.correct)).toBe(true);
  expect(done.results.every((row) => row.activationPassed === null)).toBe(true);
  const snapshots = done.runIds.map((id) => f.coordinator.getRunSnapshot(id)!);
  expect(
    snapshots.map((snapshot) =>
      Object.values(snapshot.harnesses!)[0]!.resources.map((resource) => resource.hash),
    ),
  ).toEqual([
    [f.request.baseline!.resourceHash],
    [f.request.candidate.resourceHash],
    [f.request.baseline!.resourceHash],
    [f.request.candidate.resourceHash],
  ]);
  expect(new Set(done.results.map((row) => JSON.stringify(row.modelHashes))).size).toBe(1);
  expect(f.harness.store.getDefault('personal', 'default').binding?.revision).toBe(1);
  expect(() => f.service.start({ ...f.request, modelProfile: 'changed' })).toThrow(/operation/);
});
it('reviews all changes, adopts one new default revision, and rolls back without modifying old snapshots', async () => {
  const f = await fixture();
  f.service.start(f.request);
  const done = await f.service.wait(f.request.operationId);
  const preview = f.service.preview(f.request.candidate, f.request.baseline);
  expect(preview.changes).toContainEqual({
    path: 'skills/SKILL.md',
    change: 'changed',
    category: 'source',
  });
  const contents = f.service.compareFile(
    f.request.candidate,
    f.request.baseline,
    'skills/SKILL.md',
  );
  expect(contents.before?.text).toContain('Keep the answer brief.');
  expect(contents.after?.text).toContain('Keep the answer brief and clear.');
  expect(() =>
    f.service.compareFile(f.request.candidate, f.request.baseline, '../outside'),
  ).toThrow();
  const input = {
    operationId: 'adopt',
    evaluationId: done.id,
    reviewed: true as const,
    target: {
      scope: 'personal' as const,
      scopeId: 'default',
      expectedRevision: 1,
      binding: { profileId: 'personal', revision: 1 },
    },
  };
  const adopted = f.service.adopt(input);
  expect(f.service.adoptions(f.request.candidate)).toEqual([adopted]);
  expect(f.service.adopt(input)).toEqual(adopted);
  expect(f.harness.store.getDefault('personal', 'default').binding).toEqual(adopted.binding);
  expect(f.harness.store.getProfile(input.target.binding)?.resources[0]?.resourceHash).toBe(
    f.request.baseline?.resourceHash,
  );
  const restored = f.service.rollback({
    operationId: 'rollback',
    adoptionId: adopted.id,
    expectedRevision: adopted.defaultRevision,
  });
  expect(restored.binding).toEqual(input.target.binding);
  expect(
    f.service.rollback({
      operationId: 'rollback',
      adoptionId: adopted.id,
      expectedRevision: adopted.defaultRevision,
    }),
  ).toEqual(restored);
});
it('cancelled or incomplete evidence cannot be adopted and duplicate cancellation never starts a run', async () => {
  const f = await fixture();
  f.service.start(f.request);
  f.service.cancel(f.request.operationId);
  const done = await f.service.wait(f.request.operationId);
  expect(done.status).toBe('cancelled');
  expect(
    done.runIds.every((id) =>
      ['cancelled', 'succeeded', 'failed'].includes(
        f.coordinator.getSnapshot(id).projection.status,
      ),
    ),
  ).toBe(true);
  const frozen = f.service.get(done.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.service.get(done.id)).toEqual(frozen);
  f.service.cancel(done.id);
  expect(() =>
    f.service.adopt({
      operationId: 'no',
      evaluationId: done.id,
      reviewed: true,
      target: {
        scope: 'personal',
        scopeId: 'default',
        expectedRevision: 1,
        binding: { profileId: 'personal', revision: 1 },
      },
    }),
  ).toThrow(/completed/);
});
it('restart marks orphaned evaluation evidence interrupted and terminal evidence is immutable', async () => {
  const f = await fixture();
  f.service.start(f.request);
  const complete = await f.service.wait(f.request.operationId);
  const orphan = {
    ...complete,
    id: 'orphan',
    request: { ...complete.request, operationId: 'orphan' },
    status: 'running',
    endedAt: null,
  };
  f.db
    .prepare('INSERT INTO skill_evaluations VALUES (?, ?, ?)')
    .run(orphan.id, orphan.requestHash, JSON.stringify(orphan));
  const restarted = new SkillQualityService(f);
  expect(restarted.get('orphan').status).toBe('interrupted');
  expect(restarted.get(complete.id)).toEqual(complete);
  expect(() =>
    f.db
      .prepare('UPDATE skill_evaluations SET view_json = ? WHERE id = ?')
      .run(JSON.stringify(orphan), 'orphan'),
  ).toThrow(/immutable/);
});
it('rollback preserves newer defaults and rejects revoked baseline trust', async () => {
  const f = await fixture();
  f.service.start(f.request);
  await f.service.wait(f.request.operationId);
  const adopted = f.service.adopt({
    operationId: 'adoption',
    evaluationId: 'evaluate',
    reviewed: true,
    target: {
      scope: 'personal',
      scopeId: 'default',
      expectedRevision: 1,
      binding: { profileId: 'personal', revision: 1 },
    },
  });
  const rollback = {
    operationId: 'rollback',
    adoptionId: adopted.id,
    expectedRevision: adopted.defaultRevision,
  };
  f.harness.trust(f.request.baseline!.resourceHash, false);
  expect(() => f.service.rollback(rollback)).toThrow(/trust/);
  f.harness.trust(f.request.baseline!.resourceHash, true);
  f.harness.setDefault('personal', 'default', adopted.defaultRevision, null);
  expect(() => f.service.rollback(rollback)).toThrow(/revision/);
  expect(f.harness.store.getDefault('personal', 'default').binding).toBeNull();
  expect(f.service.get('evaluate').status).toBe('completed');
});
it('reviews license, references, scripts, permissions and binary changes without executing them', async () => {
  const f = await fixture();
  const copy = async (version: number) => {
    const source = join(f.root, `source-${version}`);
    for (const folder of ['skills', 'references', 'scripts'])
      mkdirSync(join(source, folder), { recursive: true });
    for (const path of ['LICENSE', 'references/guide.md', 'scripts/check.sh'])
      writeFileSync(join(source, path), String(version));
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'writing', version: `${version}.0.0` }),
    );
    writeFileSync(
      join(source, 'skills/SKILL.md'),
      '---\nname: writing\ndescription: Write clearly\n---\nKeep it short.',
    );
    writeFileSync(join(source, 'binary'), Buffer.from([0, version]));
    writeFileSync(join(source, version === 1 ? 'removed.txt' : 'added.txt'), 'text');
    const review = await f.harness.reviewPackage('local', source);
    const saved = f.harness.install(review.reviewId);
    f.harness.trust(saved.hash, true);
    return { resourceHash: saved.hash, kind: 'skill' as const, entry: 'skills/SKILL.md' };
  };
  const baseline = await copy(1),
    candidate = await copy(2);
  const preview = f.service.preview(candidate, baseline);
  expect(new Set(preview.changes.map((change) => change.category))).toEqual(
    new Set(['license', 'reference', 'script', 'permissions', 'source']),
  );
  expect(preview.changes).toContainEqual({
    path: 'removed.txt',
    change: 'removed',
    category: 'source',
  });
  expect(preview.changes).toContainEqual({
    path: 'added.txt',
    change: 'added',
    category: 'source',
  });
  expect(preview.licenseChanged).toBe(true);
  expect(f.service.compareFile(candidate, baseline, 'binary')).toMatchObject({
    before: { bytes: 2, text: null },
    after: { bytes: 2, text: null },
  });
});
it('user edits and trust revocation block stale adoption and rollback', async () => {
  const f = await fixture();
  f.service.start(f.request);
  await f.service.wait(f.request.operationId);
  const target = {
    scope: 'personal' as const,
    scopeId: 'default',
    expectedRevision: 1,
    binding: { profileId: 'personal', revision: 1 },
  };
  f.harness.saveProfile('personal', 1, { ...f.profile, name: 'User edit' });
  expect(() =>
    f.service.adopt({ operationId: 'stale', evaluationId: 'evaluate', reviewed: true, target }),
  ).toThrow(/revision/);
  f.harness.trust(f.request.candidate.resourceHash, false);
  expect(() =>
    f.service.adopt({ operationId: 'untrusted', evaluationId: 'evaluate', reviewed: true, target }),
  ).toThrow(/trust/);
});
