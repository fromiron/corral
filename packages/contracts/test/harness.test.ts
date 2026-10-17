import { describe, expect, it } from 'vitest';
import { AgentRole } from '../src/definition.ts';

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
