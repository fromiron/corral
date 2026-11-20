import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentAdapter, processChannel, sdkProcessChannel, WorkerTool } from '@corral/adapter-pi';
import type { HarnessProfile, RoleSkillRef } from '@corral/contracts';
import { Coordinator, InMemoryRunStore, InProcessTransport, waitForProjection } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { roleSkillCases } from '../../../packages/core/test/harness-role-skill-cases.ts';
import { HarnessService } from '../src/harness/service.ts';

const root = mkdtempSync(join(tmpdir(), 'corral-role-skills-'));
const db = openDatabase(':memory:');
const service = new HarnessService({ root: join(root, 'data'), db, clock: new FakeClock() });
const refs: Record<string, RoleSkillRef> = {
  missing: { resourceHash: '0'.repeat(64), entry: 'SKILL.md' },
};
const minimal = { profileId: 'role-skills-minimal', revision: 1 };
const bound = { profileId: 'writer', revision: 1 };
const profile: HarnessProfile = {
  name: 'Writer',
  policy: 'trusted-native',
  allowedTools: ['read', 'ask'],
  startupCommands: [],
  resources: [],
};

async function install(bundle: string, names: string[], previousHash?: string) {
  const source = join(root, bundle);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      pi: { skills: ['./skills'], extensions: ['./hook.ts'] },
    }),
  );
  writeFileSync(join(source, 'hook.ts'), 'export default () => {};');
  for (const name of names) {
    mkdirSync(join(source, 'skills', name), { recursive: true });
    writeFileSync(
      join(source, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill.\n---\n${bundle}`,
    );
  }
  const review = await service.reviewPackage('local', source, previousHash);
  const resource = service.install(review.reviewId);
  // Install trusts every package; only a person's revocation leaves one untrusted.
  if (bundle === 'untrusted') service.trust(resource.hash, false);
  for (const skill of resource.skills)
    refs[bundle === 'library' ? skill.name : bundle] = {
      resourceHash: resource.hash,
      entry: skill.entry,
    };
  return resource.hash;
}

beforeAll(async () => {
  await install('library', ['first', 'second', 'required', 'mandatory', 'explicit', 'optional']);
  await install('conflict', ['required']);
  const old = await install('old', ['edited']);
  await install('new', ['edited'], old);
  await install('untrusted', ['untrusted']);
  await service.managePackage(await install('disabled', ['disabled']), 0, 'disabled', 'disable');
  service.saveProfile(bound.profileId, 0, profile);
}, 60000);
beforeEach(() => {
  db.exec('SAVEPOINT role_case');
});
afterEach(() => {
  db.exec('ROLLBACK TO role_case; RELEASE role_case');
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function defaults() {
  service.saveProfile('personal', 0, {
    ...profile,
    policy: 'strict',
    resources: ['required', 'mandatory', 'explicit', 'optional'].map((name) => ({
      ...refs[name]!,
      kind: 'skill',
      required: name === 'required',
      skillMode: name === 'mandatory' || name === 'explicit' ? name : 'auto',
    })),
  });
  service.setDefault('personal', 'default', 0, { profileId: 'personal', revision: 1 });
  service.saveProfile('project', 0, { ...profile, allowedTools: ['read'] });
  service.setDefault('project', 'default', 0, { profileId: 'project', revision: 1 });
}

it.each(roleSkillCases)('$title', (row) => {
  if (row.defaults) defaults();
  if (row.problem === 'execution_policy_required') {
    service.saveProfile('native', 0, {
      ...profile,
      resources: [
        {
          resourceHash: refs.first!.resourceHash,
          entry: 'hook.ts',
          kind: 'extension',
          required: true,
        },
      ],
    });
    service.setDefault('personal', 'default', 0, { profileId: 'native', revision: 1 });
  }
  const definition = linearCorral(['writer']);
  const role = definition.roles[0]!;
  if (row.bound) role.harness = bound;
  if (row.skills) role.skills = row.skills.map((key) => refs[key]!);
  const result = service.preview(role, 'default');
  const resolve = () => service.resolve(role.harness, definition, role.id);
  if (row.problem) {
    const problem = {
      roleId: role.id,
      reason: row.problem === 'execution_policy_required' ? row.problem : 'unusable_skills',
      entries: (role.skills ?? []).map((ref) => ({ ...ref, reason: row.problem })),
    };
    expect(result).toEqual({ snapshot: null, problem });
    expect(resolve).toThrow(expect.objectContaining({ problem }));
    return;
  }
  expect(resolve()).toEqual(result.snapshot);
  if (!row.expected) {
    expect(result).toEqual({ snapshot: null, problem: null });
    expect(service.store.getProfile(minimal)).toBeNull();
    return;
  }
  const snapshot = result.snapshot!;
  expect(snapshot.binding).toEqual(row.bound ? bound : minimal);
  const others = row.others ?? [];
  expect(snapshot.resources).toHaveLength(row.expected.length + others.length);
  if (role.harness && !role.skills) {
    // A binding preview and the bound role's run resolve the same way, library skills included.
    expect(result).toEqual(service.preview(role.harness, 'default'));
    for (const resource of snapshot.resources)
      expect(resource).not.toHaveProperty('selectedByRole');
  }
  for (const key of row.expected) {
    expect(snapshot.resources).toContainEqual(
      expect.objectContaining({
        hash: refs[key]!.resourceHash,
        entry: refs[key]!.entry,
        required: key === 'mandatory' || key === 'required',
        skillMode: key === 'mandatory' || key === 'explicit' ? key : 'auto',
        ...(row.skills?.includes(key) ? { selectedByRole: true } : {}),
      }),
    );
  }
  for (const key of others) {
    const resource = snapshot.resources.find(
      (item) => item.hash === refs[key]!.resourceHash && item.entry === refs[key]!.entry,
    );
    expect(resource, key).toMatchObject({ required: false, skillMode: 'auto' });
    expect(resource).not.toHaveProperty('selectedByRole');
  }
  const names = snapshot.resources.map((resource) => resource.skillName);
  expect(new Set(names).size).toBe(names.length);
  if (row.defaults) {
    expect(snapshot.allowedTools).toEqual(['read']);
    expect(snapshot.policy).toBe('strict');
    expect(snapshot.layers?.map((layer) => layer.scope)).toEqual(['personal', 'project', 'role']);
  }
});

it('pins separate skill selections per role, creates only one immutable minimal base and no defaults', async () => {
  const definition = linearCorral(['writer', 'editor']);
  const [writer, editor] = definition.roles;
  writer!.skills = [refs.first!, refs.first!];
  editor!.skills = [refs.second!];
  const snapshots = definition.roles.map((role) => service.preview(role, 'default').snapshot!);
  expect(
    snapshots.map((s) => s.resources.filter((r) => r.selectedByRole).map((r) => r.skillName)),
  ).toEqual([['first'], ['second']]);
  expect(snapshots[0]!.resources.filter((r) => r.skillName === 'first')).toHaveLength(1);
  expect(snapshots[0]!.snapshotHash).not.toBe(snapshots[1]!.snapshotHash);
  expect(service.store.listProfiles().map((p) => p.profileId)).toEqual([
    minimal.profileId,
    bound.profileId,
  ]);
  expect(
    service.store.getProfile(minimal)?.allowedTools.toSorted(),
    'When the broker vocabulary changes, add a new minimal-policy revision; do not edit revision 1.',
  ).toEqual([...WorkerTool.options, 'read'].sort());
  expect(service.store.getProfile(minimal)).toMatchObject({
    policy: 'strict',
    startupCommands: [],
    resources: [],
    checkIds: [],
    lspServerIds: [],
    mcpServerIds: [],
  });
  for (const scope of ['personal', 'project'] as const)
    expect(service.store.getDefault(scope, 'default').revision).toBe(0);
  const runtime = await service.runtimeResources({ harness: snapshots[0]!, inputs: [] });
  expect(runtime).toMatchObject({ extensions: [], startupCommands: [] });
  expect(runtime.skills).toContainEqual(
    expect.objectContaining({ name: 'first', mode: 'auto', content: '' }),
  );
  expect(service.readSkill(snapshots[0]!, 'skills/first/SKILL.md').resourceHash).toBe(
    refs.first!.resourceHash,
  );
  // A library skill the role did not pick is bound in its snapshot, so it can be read.
  expect(service.readSkill(snapshots[0]!, 'skills/second/SKILL.md').resourceHash).toBe(
    refs.second!.resourceHash,
  );
  expect(() => service.readSkill(snapshots[0]!, 'skills/untrusted/SKILL.md')).toThrow('not bound');
});

it('returns each unusable exact ref once and never reports unselected optional entries', () => {
  defaults();
  const gone = { ...refs.first!, entry: 'skills/lost/SKILL.md' };
  const role = {
    id: 'writer',
    skills: [refs.untrusted!, refs.disabled!, gone, refs.conflict!, gone],
  };
  expect(service.preview(role, 'default')).toEqual({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'unusable_skills',
      entries: [
        { ...refs.untrusted, reason: 'untrusted' },
        { ...refs.disabled, reason: 'disabled' },
        { ...gone, reason: 'missing' },
        { ...refs.conflict, reason: 'name_conflict' },
      ],
    },
  });
});

it('never uses an unrelated preexisting profile with the reserved ID as a minimal policy', () => {
  service.store.saveProfile(minimal.profileId, 0, profile);
  expect(() => service.preview({ id: 'writer', skills: [] }, 'default')).toThrow();
});

it('records the selection even when an inherited required skill was already effective', () => {
  defaults();
  const first = service.preview({ id: 'writer', skills: [] }, 'default').snapshot!;
  const picked = service.preview({ id: 'writer', skills: [refs.required!] }, 'default').snapshot!;
  expect(picked.resources).toHaveLength(first.resources.length);
  expect(
    picked.resources.find((resource) => resource.entry === refs.required!.entry)?.selectedByRole,
  ).toBe(true);
  expect(picked.snapshotHash).not.toBe(first.snapshotHash);
});

it('does not accept an inherited extension as a selected skill with the same hash and entry', () => {
  const ref = { resourceHash: refs.first!.resourceHash, entry: 'hook.ts' };
  service.saveProfile('native', 0, {
    ...profile,
    resources: [{ ...ref, kind: 'extension', required: true }],
  });
  expect(
    service.preview(
      { id: 'writer', harness: { profileId: 'native', revision: 1 }, skills: [ref] },
      'default',
    ),
  ).toEqual({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'unusable_skills',
      entries: [{ ...ref, reason: 'missing' }],
    },
  });
});

it('refuses a removed selected package without invalidating a previous snapshot', async () => {
  const role = { id: 'writer', skills: [refs.first!] };
  const pinned = service.preview(role, 'default').snapshot!;
  await service.managePackage(refs.first!.resourceHash, 0, 'removed', 'remove-package');
  expect(service.preview(role, 'default')).toEqual({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'unusable_skills',
      entries: [{ ...refs.first, reason: 'missing' }],
    },
  });
  expect((await service.runtimeResources({ harness: pinned, inputs: [] })).skills[0]?.hash).toBe(
    refs.first!.resourceHash,
  );
});

it('reports unusable entries even when a default also requires an explicit execution policy', () => {
  service.saveProfile('native', 0, {
    ...profile,
    resources: [
      {
        resourceHash: refs.first!.resourceHash,
        entry: 'hook.ts',
        kind: 'extension',
        required: true,
      },
    ],
  });
  service.setDefault('personal', 'default', 0, { profileId: 'native', revision: 1 });
  expect(service.preview({ id: 'writer', skills: [refs.missing!] }, 'default')).toEqual({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'execution_policy_required',
      entries: [{ ...refs.missing, reason: 'missing' }],
    },
  });
});

it('starts the SDK role without the optional default extension or its startup command', async () => {
  service.saveProfile('native', 0, {
    ...profile,
    startupCommands: ['/e:init'],
    allowedTools: ['read', 'write_artifact', 'submit_result'],
    resources: [
      {
        resourceHash: refs.first!.resourceHash,
        entry: 'hook.ts',
        kind: 'extension',
        required: false,
      },
    ],
  });
  service.setDefault('project', 'default', 0, { profileId: 'native', revision: 1 });
  const definition = linearCorral(['writer']);
  const role = definition.roles[0]!;
  role.skills = [refs.first!];
  const preview = service.preview(role, 'default').snapshot!;
  expect(preview.resources.some((ref) => ref.kind === 'extension')).toBe(false);
  expect(preview.resources.filter((ref) => ref.selectedByRole)).toHaveLength(1);
  expect(await service.runtimeResources({ harness: preview, inputs: [] })).toMatchObject({
    extensions: [],
    startupCommands: [],
  });
  expect(preview.startupCommandPolicy).toBe('none');
  expect(service.resolve(undefined, definition, role.id)).toEqual(preview);
  const pinned = service.preview({ ...role, harness: bound }, 'default').snapshot!;
  expect(pinned.resources.filter((ref) => ref.kind === 'extension')).toHaveLength(1);
  expect(pinned).not.toHaveProperty('startupCommandPolicy');
  expect((await service.runtimeResources({ harness: pinned, inputs: [] })).startupCommands).toEqual(
    ['/e:init'],
  );
  const fixture = join(
    import.meta.dirname,
    '../../../packages/adapter-pi/test/fixtures/harness-role-worker.ts',
  );
  const store = new InMemoryRunStore();
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      store,
      harnesses: service,
      models: {
        resolve: (profile) => ({
          ok: true,
          snapshot: { profile, provider: 'faux', modelId: 'faux-1', auth: 'api_key' },
        }),
      },
      agents: new PiAgentAdapter({
        spawn: () => processChannel(fixture),
        spawnSdk: () => sdkProcessChannel(fixture),
        harness: (input) => service.runtimeResources(input),
        credentials: async () => 'fixture-access-token',
      }),
    }),
  );
  const { runId } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'launch',
    definition,
    mode: 'live',
  });
  expect(runId).toBeTruthy();
  const final = await waitForProjection(transport, runId!, (run) =>
    ['succeeded', 'failed', 'cancelled'].includes(run.status),
  );
  expect(final.status).toBe('succeeded');
  expect(store.readEvents(runId!, 0).some((event) => event.type === 'harness.loaded')).toBe(true);
});

it('one unusable library skill neither blocks a start nor enters the snapshot', async () => {
  const broken = await install('broken', ['fragile']);
  const retired = await install('retired', ['retired']);
  const off = await install('off', ['off']);
  const revoked = await install('revoked', ['revoked']);
  writeFileSync(
    join(root, 'data', 'resources', `sha256-${broken}`, 'skills/fragile/SKILL.md'),
    'x',
  );
  service.archiveEntry({ ...refs.retired!, kind: 'skill' }, 0, true, 'archive-retired');
  await service.managePackage(off, 0, 'disabled', 'disable-off');
  service.trust(revoked, false);
  for (const role of [
    { id: 'writer', skills: [refs.second!] },
    { id: 'writer', skills: [] },
    { id: 'writer', harness: bound },
  ]) {
    const snapshot = service.preview(role, 'default').snapshot!;
    const hashes = snapshot.resources.map((resource) => resource.hash);
    for (const hash of [broken, retired, off, revoked, refs.untrusted!.resourceHash])
      expect(hashes).not.toContain(hash);
    expect(hashes).toContain(refs.first!.resourceHash);
  }
  expect(service.store.getResource(retired)?.trustedAt).not.toBeNull();
});

it('an integrity mismatch revokes trust and still refuses a start for a picked skill', async () => {
  const hash = await install('tampered', ['tampered']);
  const role = { id: 'writer', skills: [refs.tampered!] };
  expect(service.preview(role, 'default').snapshot).not.toBeNull();
  writeFileSync(join(root, 'data', 'resources', `sha256-${hash}`, 'skills/tampered/SKILL.md'), 'x');
  expect(service.preview(role, 'default')).toEqual({
    snapshot: null,
    problem: {
      roleId: 'writer',
      reason: 'unusable_skills',
      entries: [{ ...refs.tampered, reason: 'untrusted' }],
    },
  });
  expect(service.store.getResource(hash)?.trustedAt).toBeNull();
});

it('two installed versions of a pack yield one entry per name and no refusal', async () => {
  await install('copy', ['first', 'second']);
  const snapshot = service.preview({ id: 'writer', skills: [refs.second!] }, 'default').snapshot!;
  const named = (name: string) => snapshot.resources.filter((r) => r.skillName === name);
  expect(named('second')).toEqual([expect.objectContaining({ hash: refs.second!.resourceHash })]);
  // The picked name wins; among the others, the most recently installed copy is bound.
  expect(named('first')).toEqual([expect.objectContaining({ hash: refs.copy!.resourceHash })]);
});

it('installing another usable skill changes the snapshot hash of every resolved role', async () => {
  const roles = [
    { id: 'writer', skills: [refs.second!] },
    { id: 'writer', harness: bound },
  ];
  const before = roles.map((role) => service.preview(role, 'default').snapshot!.snapshotHash);
  const added = await install('added', ['added']);
  roles.forEach((role, index) => {
    const after = service.preview(role, 'default').snapshot!;
    expect(after.snapshotHash).not.toBe(before[index]);
    expect(after.resources).toContainEqual(
      expect.objectContaining({ hash: added, skillName: 'added', skillMode: 'auto' }),
    );
  });
});

it('a skill marked disable-model-invocation is explicit unless the role picks it', async () => {
  const source = join(root, 'marked');
  mkdirSync(join(source, 'skills', 'manual'), { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'marked', version: '1.0.0', pi: { skills: ['./skills'] } }),
  );
  writeFileSync(
    join(source, 'skills/manual/SKILL.md'),
    '---\nname: manual\ndescription: Run only on request.\ndisable-model-invocation: true\n---\nBody',
  );
  const resource = service.install((await service.reviewPackage('local', source)).reviewId);
  const ref = { resourceHash: resource.hash, entry: 'skills/manual/SKILL.md' };
  const bind = (skills: RoleSkillRef[]) =>
    service
      .preview({ id: 'writer', skills }, 'default')
      .snapshot!.resources.find((r) => r.hash === resource.hash);
  expect(bind([refs.second!])).toMatchObject({ skillName: 'manual', skillMode: 'explicit' });
  expect(bind([ref])).toMatchObject({ skillMode: 'auto', selectedByRole: true });
  const runtime = await service.runtimeResources({
    harness: service.preview({ id: 'writer', skills: [] }, 'default').snapshot!,
    inputs: [],
  });
  expect(runtime.skills.find((skill) => skill.name === 'manual')?.mode).toBe('explicit');
});

it('an evaluation run keeps exactly its fixed profile and receives no library skills', () => {
  service.saveProfile('evaluation', 0, {
    name: 'Evaluation',
    policy: 'strict',
    allowedTools: ['read', 'read_artifact', 'write_artifact', 'submit_result'],
    startupCommands: [],
    resources: [{ ...refs.first!, kind: 'skill', required: true, skillMode: 'auto' }],
  });
  const definition = linearCorral(['writer']);
  const role = definition.roles[0]!;
  role.harness = { profileId: 'evaluation', revision: 1 };
  const release = service.sealEvaluationDefinition(definition);
  try {
    const snapshot = service.resolve(role.harness, definition, role.id)!;
    expect(snapshot.resources.map((resource) => resource.skillName)).toEqual(['first']);
  } finally {
    release();
  }
  expect(service.resolve(role.harness, definition, role.id)!.resources.length).toBeGreaterThan(1);
});

it('an evaluation run in a workspace session also receives no library skills', () => {
  service.saveProfile('evaluation', 0, {
    name: 'Evaluation',
    policy: 'strict',
    allowedTools: ['read', 'read_artifact', 'write_artifact', 'submit_result'],
    startupCommands: [],
    resources: [{ ...refs.first!, kind: 'skill', required: true, skillMode: 'auto' }],
  });
  db.prepare(
    `INSERT INTO work_sessions (id, project_id, title, objective, pinned, revision, created_at, updated_at, entries_json)
     VALUES ('evaluation_session', 'default', 'Evaluation', 'Evaluate', 0, 1, ?, ?, '[]')`,
  ).run(new Date(0).toISOString(), new Date(0).toISOString());
  const definition = linearCorral(['writer']);
  const role = definition.roles[0]!;
  role.harness = { profileId: 'evaluation', revision: 1 };
  const release = service.sealEvaluationDefinition(definition);
  try {
    const snapshot = service.resolve(role.harness, definition, role.id, {
      sessionId: 'evaluation_session',
    })!;
    expect(snapshot.resources.map((resource) => resource.skillName)).toEqual(['first']);
  } finally {
    release();
  }
});

it('a library skill revoked after a run started is left out of a later worker start', async () => {
  const pinned = service.preview({ id: 'writer', skills: [refs.second!] }, 'default').snapshot!;
  expect(pinned.resources).toContainEqual(
    expect.objectContaining({ hash: refs.conflict!.resourceHash, skillName: 'required' }),
  );
  service.trust(refs.conflict!.resourceHash, false);
  const runtime = await service.runtimeResources({ harness: pinned, inputs: [] });
  expect(runtime.skills.map((skill) => skill.name)).toContain('second');
  expect(runtime.skills.map((skill) => skill.name)).not.toContain('required');
  service.trust(refs.second!.resourceHash, false);
  await expect(service.runtimeResources({ harness: pinned, inputs: [] })).rejects.toThrow(/trust/);
});

// harness-contract.md, "스냅샷" and "이전 실행에서 이어 갈 때".
it('library skills are marked, and a library change alone does not refuse a branch', async () => {
  db.prepare(
    `INSERT INTO work_sessions (id, project_id, title, objective, pinned, revision, created_at, updated_at, entries_json)
     VALUES ('branch_session', 'default', 'Branch', 'Branch', 0, 1, ?, ?, '[]')`,
  ).run(new Date(0).toISOString(), new Date(0).toISOString());
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    store,
    harnesses: service,
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const ended = (runId: string) =>
    waitForProjection(transport, runId, (run) =>
      ['succeeded', 'failed', 'cancelled'].includes(run.status),
    );
  const definition = linearCorral(['writer']);
  definition.roles[0]!.skills = [refs.second!];
  const source = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'source',
    definition,
    mode: 'mock',
  });
  expect(source.receipt.error).toBeUndefined();
  await ended(source.runId!);
  const before = store.getRun(source.runId!)!.snapshot.harnesses!.writer_role!;
  const picked = before.resources.find((resource) => resource.selectedByRole);
  expect(picked).toMatchObject({ skillName: 'second' });
  expect(picked).not.toHaveProperty('library');
  expect(before.resources.filter((resource) => resource.library).length).toBe(
    before.resources.length - 1,
  );
  const point = { sourceRunId: source.runId!, requestStart: true as const };
  const preview = coordinator.branchPreview(point);
  const added = await install('later', ['later']);
  const prepare = async () => ({ sessionId: 'branch_session' });
  const branch = await coordinator.branchRun(
    { ...point, commandId: 'branch_library', expectedHash: preview.hash },
    prepare,
  );
  expect(branch.receipt.error).toBeUndefined();
  const after = store.getRun(branch.runId!)!.snapshot.harnesses!.writer_role!;
  expect(after.snapshotHash).not.toBe(before.snapshotHash);
  expect(after.resources).toContainEqual(
    expect.objectContaining({ hash: added, skillName: 'later', library: true }),
  );
  await ended(branch.runId!);
  // A bound change, here the person's default policy, still refuses the branch.
  defaults();
  expect(
    await coordinator.branchRun(
      { ...point, commandId: 'branch_bound', expectedHash: preview.hash },
      prepare,
    ),
  ).toMatchObject({
    runId: null,
    receipt: { error: { message: 'branch model or resources changed' } },
  });
});

it('a skill read lists no explicit skill, which a request can still read by name', async () => {
  const source = join(root, 'marked-read');
  mkdirSync(join(source, 'skills', 'manual'), { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'marked-read', version: '1.0.0', pi: { skills: ['./skills'] } }),
  );
  writeFileSync(
    join(source, 'skills/manual/SKILL.md'),
    '---\nname: manual\ndescription: Run only on request.\ndisable-model-invocation: true\n---\nBody',
  );
  service.install((await service.reviewPackage('local', source)).reviewId);
  const snapshot = service.preview({ id: 'writer', skills: [refs.second!] }, 'default').snapshot!;
  expect(snapshot.resources).toContainEqual(
    expect.objectContaining({ skillName: 'manual', skillMode: 'explicit' }),
  );
  const read = service.readSkill(snapshot, 'skills/second/SKILL.md');
  const listed = (read.boundSkills as { name: string }[]).map((skill) => skill.name);
  expect(listed).toContain('first');
  expect(listed).not.toContain('manual');
  expect(service.readSkill(snapshot, 'skills/manual/SKILL.md').text).toContain('Body');
});

it('a pinned harness that leaves out an optional skill says so; unusable library skills do not', async () => {
  const optional = (ref: RoleSkillRef) => ({
    ...ref,
    kind: 'skill' as const,
    required: false,
    skillMode: 'auto' as const,
  });
  const pinned = (resources: RoleSkillRef[]) => {
    const profileId = `optional-${resources.length}`;
    service.saveProfile(profileId, 0, { ...profile, resources: resources.map(optional) });
    return service.preview({ id: 'writer', harness: { profileId, revision: 1 } }, 'default')
      .snapshot!;
  };
  expect(pinned([refs.first!]).diagnostics).not.toContain('optional_skill_skipped');
  for (const unusable of [refs.untrusted!, refs.missing!, refs.disabled!, refs.conflict!]) {
    const snapshot = pinned([refs.required!, unusable]);
    expect(snapshot.diagnostics.filter((code) => code === 'optional_skill_skipped')).toEqual([
      'optional_skill_skipped',
    ]);
    expect(snapshot.resources.some((r) => r.hash === unusable.resourceHash)).toBe(false);
    db.exec('ROLLBACK TO role_case');
  }
  const several = pinned([refs.untrusted!, refs.missing!, refs.disabled!]);
  expect(several.diagnostics.filter((code) => code === 'optional_skill_skipped')).toHaveLength(1);
  // The library already holds an untrusted and a disabled package, and they add nothing.
  expect(
    service.preview({ id: 'writer', harness: bound }, 'default').snapshot!.diagnostics,
  ).not.toContain('optional_skill_skipped');
});

it('a superseded entry loses to an older one no version follows, though it was installed last', async () => {
  const older = await install('solo-old', ['solo']);
  const newer = await install('solo-new', ['solo']);
  const entry = 'skills/solo/SKILL.md';
  service.store.manageEntry({ resourceHash: newer, entry, kind: 'skill' }, 0, false, {
    resourceHash: older,
    entry,
    kind: 'skill',
  });
  const snapshot = service.preview({ id: 'writer', skills: [] }, 'default').snapshot!;
  expect(snapshot.resources.filter((r) => r.skillName === 'solo')).toEqual([
    expect.objectContaining({ hash: older, library: true }),
  ]);
});
