import type { HarnessApi } from '@corral/client';
import type { HarnessEntryView, LibraryAgent, PackageView } from '@corral/contracts';
import { BUILTIN_AGENTS, ROLE_PRESET_IDS, roleFromPreset, teamCatalog } from '@corral/core';
import { expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { builtinComposableAgents, teamChoices } from './teamChoices.ts';

const presetName = (id: (typeof ROLE_PRESET_IDS)[number]) => en.TeamTemplates.presets[id].name;

const skill = (name: string, hash: string, changes: Partial<HarnessEntryView> = {}) =>
  ({
    kind: 'skill',
    name,
    entry: `skills/${name}/SKILL.md`,
    resourceHash: hash,
    description: `For ${name}`,
    profiles: [],
    successor: null,
    archivedAt: null,
    managementRevision: 1,
    resource: {
      hash,
      trustedAt: '2026-11-20T00:00:00.000Z',
      name: 'pack',
      sourceKind: 'local',
      sourceLabel: '/home/private/source',
      fileCount: 1,
    },
    ...changes,
  }) as HarnessEntryView;

function library(agentId: string, name: string, changes: Partial<LibraryAgent> = {}): LibraryAgent {
  const { id: _id, origin: _origin, ...role } = roleFromPreset('writer', 'x', name);
  return {
    agentId,
    projectId: 'project',
    revision: 2,
    role,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    archivedAt: null,
    ...changes,
  };
}

it('offers the built-in agents in their order, named on screen and described as bundled', () => {
  const agents = builtinComposableAgents(presetName);
  expect(agents.map((agent) => agent.role.name)).toEqual(ROLE_PRESET_IDS.map(presetName));
  for (const [index, id] of ROLE_PRESET_IDS.entries()) {
    expect(agents[index]).toMatchObject({
      origin: { kind: 'preset', presetId: id },
      builtin: true,
      description: BUILTIN_AGENTS.find((agent) => agent.id === id)?.description,
    });
  }
  // The judge that merges answers is told apart from the reviewer by its description.
  const { catalog } = teamCatalog(agents, []);
  const judge = catalog.agents.find((agent) => agent.name === presetName('judge'));
  const reviewer = catalog.agents.find((agent) => agent.name === presetName('reviewer'));
  expect(judge?.description).toBeTruthy();
  expect(judge?.description).not.toBe(reviewer?.description);
});

it('lists what the editor can pick by hand: built-in agents, then the project’s own, and usable skills', async () => {
  const agents = {
    list: vi.fn(async () => [
      library('mine', 'Release writer'),
      library('old', 'Archived writer', { archivedAt: '2026-11-20T00:00:00.000Z' }),
    ]),
  };
  const harnesses = {
    entries: vi.fn(async () => [
      skill('doc-writing', 'h1'),
      skill('untrusted', 'h2', {
        resource: { ...skill('x', 'h2').resource, trustedAt: null },
      }),
      skill('archived', 'h3', { archivedAt: '2026-11-20T00:00:00.000Z' }),
      skill('switched-off', 'h4'),
      { ...skill('an-extension', 'h5'), kind: 'extension' } as HarnessEntryView,
    ]),
    packages: vi.fn(
      async () =>
        [
          { resource: { hash: 'h1' }, status: 'enabled' },
          { resource: { hash: 'h4' }, status: 'disabled' },
        ] as PackageView[],
    ),
  };
  const choices = await teamChoices({
    projectId: 'project',
    agents,
    harnesses: harnesses as unknown as HarnessApi,
    presetName,
  });
  expect(agents.list).toHaveBeenCalledWith('project');
  expect(choices.agents.map((agent) => agent.role.name)).toEqual([
    ...ROLE_PRESET_IDS.map(presetName),
    'Release writer',
  ]);
  expect(choices.agents.at(-1)).toMatchObject({
    origin: { kind: 'library', agentId: 'mine', revision: 2 },
  });
  expect(choices.agents.at(-1)).not.toHaveProperty('description');
  expect(choices.skills).toEqual([
    {
      ref: { resourceHash: 'h1', entry: 'skills/doc-writing/SKILL.md' },
      name: 'doc-writing',
      description: 'For doc-writing',
    },
  ]);
});

it('has no skills to offer where there is no harness, and fails when the agents cannot be read', async () => {
  const choices = await teamChoices({
    projectId: 'project',
    agents: { list: async () => [] },
    harnesses: null,
    presetName,
  });
  expect(choices.agents).toHaveLength(ROLE_PRESET_IDS.length);
  expect(choices.skills).toEqual([]);
  await expect(
    teamChoices({
      projectId: 'project',
      agents: {
        list: async () => {
          throw new Error('offline');
        },
      },
      harnesses: null,
      presetName,
    }),
  ).rejects.toThrow('offline');
});
