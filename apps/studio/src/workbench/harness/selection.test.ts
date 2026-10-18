import type { HarnessProfile } from '@corral/contracts';
import { expect, it } from 'vitest';
import { updateResourceSelection } from './selection.ts';

it('[TC-MGR-001-N] replacing content preserves skill mode and optional hooks without changing other selections', () => {
  for (const skillMode of ['auto', 'explicit', 'mandatory'] as const) {
    const previous = {
      resourceHash: 'a'.repeat(64),
      entry: 'SKILL.md',
      kind: 'skill' as const,
      required: false,
      skillMode,
    };
    const profile: HarnessProfile = {
      name: 'Writer',
      policy: 'trusted-native',
      resources: [previous],
      allowedTools: ['read'],
      startupCommands: ['audit-start'],
      mcpServerIds: ['docs'],
    };
    const key = { resourceHash: 'b'.repeat(64), entry: previous.entry, kind: previous.kind };
    const next = updateResourceSelection(profile, key, true, [previous]);
    expect(next).toEqual({ ...profile, resources: [{ ...previous, ...key }] });
    expect(profile.resources).toEqual([previous]);
    expect(updateResourceSelection(next, key, true, [], 'explicit').resources[0]?.skillMode).toBe(
      'explicit',
    );
  }
  const extension = {
    resourceHash: 'c'.repeat(64),
    entry: 'hook.ts',
    kind: 'extension' as const,
    required: false,
  };
  const profile: HarnessProfile = {
    name: 'Hook',
    policy: 'trusted-native',
    resources: [extension],
    allowedTools: [],
    startupCommands: [],
  };
  expect(
    updateResourceSelection(profile, { ...extension, resourceHash: 'd'.repeat(64) }, true, [
      extension,
    ]).resources[0]?.required,
  ).toBe(false);
});
