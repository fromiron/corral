import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessProfile, RegisteredMcpServer } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, linearCorral } from '@corral/testkit';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  docsEcho,
  docsEdit,
  inheritedMcpNames,
  otherSearch,
  roleMcpCases,
} from '../../../packages/core/test/harness-role-mcp-cases.ts';
import { HarnessService } from '../src/harness/service.ts';

const root = mkdtempSync(join(tmpdir(), 'role-mcp-'));
const db = openDatabase(':memory:');
const service = new HarnessService({ root, db, clock: new FakeClock() });
const native = { profileId: 'native', revision: 1 };
const strict = { profileId: 'strict', revision: 1 };
const project = 'default';
const servers: RegisteredMcpServer[] = ['docs', 'other', 'unselected'].map((id) => ({
  id,
  name: id,
  transport: 'http',
  url: 'https://example.invalid/mcp',
  auth: { kind: 'none' },
  exposure: 'direct',
  timeoutMs: 1000,
}));
const profile: HarnessProfile = {
  name: 'External tools',
  policy: 'trusted-native',
  resources: [],
  allowedTools: ['submit_result', ...inheritedMcpNames],
  mcpServerIds: ['docs', 'other'],
  startupCommands: [],
};

beforeAll(() => {
  service.projectTools.save(project, 0, { checks: [], lspServers: [], mcpServers: servers });
  service.saveProfile(native.profileId, 0, profile);
  service.saveProfile(strict.profileId, 0, { ...profile, policy: 'strict', mcpServerIds: [] });
});
beforeEach(() => {
  db.exec('SAVEPOINT mcp_case');
});
afterEach(() => {
  db.exec('ROLLBACK TO mcp_case; RELEASE mcp_case');
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it.each(roleMcpCases)('$title', (row) => {
  if (row.disabled)
    service.projectTools.save(project, 1, {
      checks: [],
      lspServers: [],
      mcpServers: servers.map((s) => (s.id === 'docs' ? { ...s, enabled: false } : s)),
    });
  const definition = linearCorral(['researcher']);
  const [role] = definition.roles;
  if (!role) throw new Error('fixture requires a role');
  if (row.binding !== 'none') role.harness = row.binding === 'strict' ? strict : native;
  if (row.picks) role.mcpTools = row.picks;
  const result = service.preview(role, project);
  const resolve = () => service.resolve(role.harness, definition, role.id);
  if (row.problem) {
    const mcpProblem = {
      roleId: role.id,
      tools: row.picks?.map((ref) => ({ ...ref, reason: row.problem })),
    };
    expect(result).toEqual({ snapshot: null, problem: null, mcpProblem });
    expect(resolve).toThrow(expect.objectContaining({ mcpProblem }));
    if (row.binding === 'none') expect(service.store.listProfiles()).toHaveLength(2);
    return;
  }
  expect(resolve()).toEqual(result.snapshot);
  if (!row.offered) {
    expect(result).toEqual({ snapshot: null, problem: null });
    expect(service.store.listProfiles()).toHaveLength(2);
    return;
  }
  expect(result.snapshot?.allowedTools).toEqual(['submit_result', ...row.offered]);
  expect(result.snapshot?.projectTools?.mcpServerIds ?? []).toEqual(row.servers);
  if (!row.picks) expect(result).toEqual(service.preview(native, project));
});

it('pins different roles independently, and upper layers can remove but not add a picked tool', () => {
  const definition = linearCorral(['researcher', 'writer']);
  const [researcher, writer] = definition.roles;
  if (!researcher || !writer) throw new Error('fixture requires both roles');
  researcher.harness = writer.harness = native;
  researcher.mcpTools = [docsEcho];
  writer.mcpTools = [docsEdit];
  const before = service.resolve(native, definition, researcher.id);
  const other = service.resolve(native, definition, writer.id);
  if (!before || !other) throw new Error('both snapshots must be pinned');
  expect(before.allowedTools).toEqual(['submit_result', docsEcho.name]);
  expect(other.allowedTools).toEqual(['submit_result', docsEdit.name]);
  expect(before.snapshotHash).not.toBe(other.snapshotHash);
  const narrowed = { profileId: 'narrow', revision: 1 };
  service.saveProfile(narrowed.profileId, 0, {
    ...profile,
    allowedTools: ['submit_result', docsEcho.name],
    mcpServerIds: ['docs'],
  });
  service.setDefault('project', project, 0, narrowed);
  const result = service.preview(
    { id: 'combined', harness: native, mcpTools: [docsEcho, docsEdit, otherSearch] },
    project,
  );
  expect(result).toEqual({
    snapshot: null,
    problem: null,
    mcpProblem: {
      roleId: 'combined',
      tools: [
        { ...docsEdit, reason: 'tool_not_allowed' },
        { ...otherSearch, reason: 'server_not_selected' },
      ],
    },
  });
  const explicit = service.preview(researcher, project).snapshot;
  expect(explicit?.allowedTools).toEqual(before.allowedTools);
  expect(explicit?.snapshotHash).toBe(service.preview(native, project).snapshot.snapshotHash);
});

it('empty picks and selected skills use the skills base; nonempty picks never inherit a native policy', () => {
  service.setDefault('project', project, 0, native);
  const role = { id: 'uses_skills', skills: [], mcpTools: [] };
  expect(service.preview(role, project).snapshot?.policy).toBe('strict');
  expect(service.preview({ ...role, mcpTools: [docsEcho] }, project)).toEqual({
    snapshot: null,
    problem: null,
    mcpProblem: { roleId: role.id, tools: [{ ...docsEcho, reason: 'execution_policy_required' }] },
  });
});

it('reports both a missing skill and the tools a strict default prevents', () => {
  service.setDefault('project', project, 0, strict);
  const missing = { resourceHash: '0'.repeat(64), entry: 'SKILL.md' };
  const role = { id: 'combined', harness: native, skills: [missing], mcpTools: [docsEcho] };
  expect(service.preview(role, project)).toEqual({
    snapshot: null,
    problem: {
      roleId: role.id,
      reason: 'unusable_skills',
      entries: [{ ...missing, reason: 'missing' }],
    },
    mcpProblem: { roleId: role.id, tools: [{ ...docsEcho, reason: 'execution_policy_required' }] },
  });
});
