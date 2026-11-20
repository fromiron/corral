import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentAdapter, processChannel, sdkProcessChannel, WorkerTool } from '@corral/adapter-pi';
import type { HarnessProfile, RoleSkillRef } from '@corral/contracts';
import { Coordinator, InMemoryRunStore, InProcessTransport, waitForProjection } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
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
  expect(snapshot.resources).toHaveLength(row.expected.length);
  if (role.harness && !role.skills) {
    expect(result).toEqual(service.preview(role.harness, 'default'));
    expect(snapshot.snapshotHash).toBe(
      '932b5bd7419e71ac518441fb40cd8074df96335d091e237c9249b6c11308ae42',
    );
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
      }),
    );
  }
  if (row.defaults) {
    expect(snapshot.allowedTools).toEqual(['read']);
    expect(snapshot.policy).toBe('strict');
    expect(snapshot.layers?.map((layer) => layer.scope)).toEqual(['personal', 'project', 'role']);
  }
});

it('pins separate skill sets per role, creates only one immutable minimal base and no defaults', async () => {
  const definition = linearCorral(['writer', 'editor']);
  const [writer, editor] = definition.roles;
  writer!.skills = [refs.first!, refs.first!];
  editor!.skills = [refs.second!];
  const snapshots = definition.roles.map((role) => service.preview(role, 'default').snapshot!);
  expect(snapshots.map((s) => s.resources.map((r) => r.skillName))).toEqual([
    ['first'],
    ['second'],
  ]);
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
  expect(await service.runtimeResources({ harness: snapshots[0]!, inputs: [] })).toMatchObject({
    extensions: [],
    startupCommands: [],
    skills: [{ name: 'first', mode: 'auto', content: '' }],
  });
  expect(service.readSkill(snapshots[0]!, 'skills/first/SKILL.md').resourceHash).toBe(
    refs.first!.resourceHash,
  );
  expect(() => service.readSkill(snapshots[0]!, 'skills/second/SKILL.md')).toThrow('not bound');
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
  expect(preview.resources.map((ref) => ref.kind)).toEqual(['skill']);
  expect(await service.runtimeResources({ harness: preview, inputs: [] })).toMatchObject({
    extensions: [],
    startupCommands: [],
  });
  expect(preview.startupCommandPolicy).toBe('none');
  expect(service.resolve(undefined, definition, role.id)).toEqual(preview);
  const pinned = service.preview({ ...role, harness: bound }, 'default').snapshot!;
  expect(pinned.resources.map((ref) => ref.kind)).toEqual(['extension', 'skill']);
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
