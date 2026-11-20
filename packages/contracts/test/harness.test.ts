import { describe, expect, it } from 'vitest';
import { AgentRole } from '../src/definition.ts';
import { type EffectiveHarnessSnapshot, HarnessProfile, ResourcePath } from '../src/harness.ts';
import { matchesRoleMcpSelection } from '../src/harness-management.ts';

const role = {
  id: 'writer',
  name: 'Writer',
  prompt: 'Write clearly.',
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text',
};

describe('optional harness binding', () => {
  it('leaves old roles byte-for-byte unchanged and accepts an immutable binding', () => {
    expect(JSON.stringify(AgentRole.parse(role))).toBe(JSON.stringify(role));
    const bound = { ...role, harness: { profileId: 'writing', revision: 2 } };
    expect(AgentRole.parse(bound)).toEqual(bound);
  });

  it('rejects mutable or malformed bindings instead of dropping them', () => {
    for (const harness of [
      { profileId: 'writing', revision: 0 },
      { profileId: 'writing', revision: 'latest' },
      { profileId: '../writing', revision: 1 },
      { profileId: 'writing', revision: 1, path: '/private/resource' },
    ])
      expect(AgentRole.safeParse({ ...role, harness }).success).toBe(false);
  });
});

it('resource entries stay relative to immutable bundles', () => {
  for (const value of [
    '/etc/passwd',
    '../skill.md',
    'a/../b',
    'a/./b',
    'a//b',
    'C:/secret',
    'a\\b',
    'a\u0000b',
  ])
    expect(ResourcePath.safeParse(value).success).toBe(false);
  expect(ResourcePath.parse('skills/writer/SKILL.md')).toBe('skills/writer/SKILL.md');
  expect(
    HarnessProfile.safeParse({
      name: 'Writing',
      policy: 'strict',
      allowedTools: [],
      resources: [],
      startupCommands: [],
      unknown: true,
    }).success,
  ).toBe(false);
});

import { RegisteredMcpServer } from '../src/project-tools.ts';

it('MCP server IDs cannot contain the tool namespace separator', () => {
  const server = {
    id: 'docs__other',
    name: 'Docs',
    transport: 'http',
    url: 'https://example.invalid/mcp',
    auth: { kind: 'none' },
    exposure: 'direct',
    timeoutMs: 1000,
  };
  expect(RegisteredMcpServer.safeParse(server).success).toBe(false);
  expect(RegisteredMcpServer.safeParse({ ...server, id: 'docs_other' }).success).toBe(true);
});

it('requires both exact name and server sets on a pinned role selection', () => {
  const harness = { profileId: 'reader', revision: 1 };
  const echo = { serverId: 'docs', name: 'mcp__docs__echo' };
  const mcpRole = { harness, mcpTools: [echo] };
  const projectTools = {
    projectId: 'default',
    revision: 1,
    hash: '1'.repeat(64),
    checkIds: [],
    lspServerIds: [],
    mcpServerIds: ['docs'],
  };
  const snapshot: EffectiveHarnessSnapshot = {
    binding: harness,
    policy: 'trusted-native',
    policyRevision: 1,
    piVersion: '1.3.0',
    snapshotHash: '0'.repeat(64),
    allowedTools: ['read', echo.name],
    projectTools,
    resources: [],
    tools: [],
    diagnostics: [],
  };
  expect(matchesRoleMcpSelection(mcpRole, snapshot)).toBe(true);
  expect(matchesRoleMcpSelection({}, snapshot)).toBe(true);
  expect(matchesRoleMcpSelection({ mcpTools: [echo] }, snapshot)).toBe(false);
  expect(matchesRoleMcpSelection({ harness, mcpTools: [] }, snapshot)).toBe(false);
  expect(matchesRoleMcpSelection(mcpRole, { ...snapshot, policy: 'strict' })).toBe(false);
  expect(matchesRoleMcpSelection(mcpRole, { ...snapshot, allowedTools: ['read'] })).toBe(false);
  expect(
    matchesRoleMcpSelection(mcpRole, {
      ...snapshot,
      projectTools: { ...projectTools, mcpServerIds: ['docs', 'other'] },
    }),
  ).toBe(false);
  for (const extra of [
    'mcp__docs__edit',
    'read_mcp_resource',
    'list_mcp_resources',
    'list_mcp_resource_templates',
  ]) {
    expect(
      matchesRoleMcpSelection(mcpRole, { ...snapshot, allowedTools: [echo.name, extra] }),
    ).toBe(false);
  }
});

import { MAX_SNAPSHOT_RESOURCES, ProviderPayloadRecord } from '../src/harness.ts';

// A role may hold as many skills as a snapshot holds resources, and a request may carry the text
// of every one of them; the record of that request must not be the thing that fails.
it('a payload record names as many skills as a snapshot can hold', () => {
  const record = (count: number) => ({
    modelCallId: 'call_1',
    payloadHash: 'a'.repeat(64),
    payloadBytes: 10,
    skills: Array.from({ length: count }, (_, index) => ({
      name: `skill-${index}`,
      resourceHash: 'b'.repeat(64),
      bodyHash: 'c'.repeat(64),
      bytes: 1,
    })),
  });
  expect(ProviderPayloadRecord.safeParse(record(MAX_SNAPSHOT_RESOURCES)).success).toBe(true);
  expect(ProviderPayloadRecord.safeParse(record(MAX_SNAPSHOT_RESOURCES + 1)).success).toBe(false);
});
