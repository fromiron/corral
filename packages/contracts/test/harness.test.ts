import { describe, expect, it } from 'vitest';
import { AgentRole } from '../src/definition.ts';
import { HarnessProfile, ResourcePath } from '../src/harness.ts';

const role = {
  id: 'writer',
  name: 'Writer',
  prompt: 'Write clearly.',
  modelProfile: 'model-a',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result'],
  outputContract: 'text',
};

describe('optional harness binding (CR-018, H2)', () => {
  it('[TC-HAR-009-H] leaves old roles byte-for-byte unchanged and accepts an immutable binding', () => {
    expect(JSON.stringify(AgentRole.parse(role))).toBe(JSON.stringify(role));
    const bound = { ...role, harness: { profileId: 'writing', revision: 2 } };
    expect(AgentRole.parse(bound)).toEqual(bound);
  });

  it('[TC-HAR-009-N] rejects mutable or malformed bindings instead of dropping them', () => {
    for (const harness of [
      { profileId: 'writing', revision: 0 },
      { profileId: 'writing', revision: 'latest' },
      { profileId: '../writing', revision: 1 },
      { profileId: 'writing', revision: 1, path: '/private/resource' },
    ])
      expect(AgentRole.safeParse({ ...role, harness }).success).toBe(false);
  });
});

it('[TC-HAR-004-N] resource entries stay relative to immutable bundles', () => {
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
it('[TC-HAR-016-N] MCP server IDs cannot contain the tool namespace separator',()=>{
 const server={id:'docs__other',name:'Docs',transport:'http',url:'https://example.invalid/mcp',auth:{kind:'none'},exposure:'direct',timeoutMs:1000};
 expect(RegisteredMcpServer.safeParse(server).success).toBe(false);
 expect(RegisteredMcpServer.safeParse({...server,id:'docs_other'}).success).toBe(true);
});
