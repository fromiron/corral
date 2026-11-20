import type { TeamComposition } from '@corral/contracts';
import {
  BUILTIN_AGENTS,
  BUILTIN_SKILLS,
  type ComposableAgent,
  type ComposableSkill,
  ROLE_PRESET_IDS,
  type RolePresetId,
  roleFromPreset,
} from '@corral/core';
import en from '../src/messages/en.json' with { type: 'json' };

// What the editor can pick by hand, as a host hands it to the team assistant: the built-in agents
// in their listed order, then one skill. A catalog built from it names agent `a<n>` for the n-th
// built-in agent and `s1` for the skill.

const presetText = en.TeamTemplates.presets;

export const choices: { agents: ComposableAgent[]; skills: ComposableSkill[] } = {
  agents: ROLE_PRESET_IDS.map((id) => {
    const { id: _id, ...role } = roleFromPreset(id, id, presetText[id].name);
    const description = BUILTIN_AGENTS.find((agent) => agent.id === id)?.description;
    return {
      role,
      origin: { kind: 'preset', presetId: id },
      builtin: true,
      ...(description ? { description } : {}),
    };
  }),
  skills: BUILTIN_SKILLS.filter((skill) => skill.name === 'doc-writing').map((skill) => ({
    ref: { resourceHash: skill.resourceHash, entry: skill.entry },
    name: skill.name,
    description: skill.description,
  })),
};

/** The catalog id of a built-in agent. */
export const agent = (id: RolePresetId) => `a${ROLE_PRESET_IDS.indexOf(id) + 1}`;
/** The built-in agent's name on screen. */
export const agentName = (id: RolePresetId) => presetText[id].name;

/** One writer: a plain team of one seat. */
export const notice: TeamComposition = {
  name: 'Notice',
  brief: 'Write a notice.',
  criteria: ['Name the date.'],
  seats: [{ id: 'w', agent: agent('writer'), name: 'Notice writer', duty: 'Write the notice.' }],
  flow: [{ seat: 'w' }],
};

/** A plain sequence of three seats, one with an added skill. */
export const sequence: TeamComposition = {
  name: 'Fix the login bug',
  brief: 'Fix the login bug.',
  criteria: ['The login works again.'],
  seats: [
    { id: 'i', agent: agent('investigator'), name: 'Cause finder', duty: 'Find the cause.' },
    { id: 'b', agent: agent('builder'), name: 'Fixer', duty: 'Fix the cause.' },
    {
      id: 'e',
      agent: agent('explainer'),
      name: 'Release note',
      duty: 'Explain the fix.',
      skills: ['s1'],
    },
  ],
  flow: [{ seat: 'i' }, { seat: 'b' }, { seat: 'e' }],
};

/** A scope, two seats side by side, then a writer whose draft a judge passes or sends back. */
export const crew: TeamComposition = {
  name: 'Security review',
  brief: 'Review the pull request for security issues.',
  criteria: ['Each finding names the file and line.'],
  seats: [
    { id: 'scope', agent: agent('investigator'), name: 'Scope', duty: 'List what changed.' },
    { id: 'x', agent: agent('adversary'), name: 'Injection check', duty: 'Look for injection.' },
    { id: 'y', agent: agent('adversary'), name: 'Secrets check', duty: 'Look for leaked keys.' },
    { id: 'w', agent: agent('writer'), name: 'Summary', duty: 'Summarize the confirmed findings.' },
    { id: 'j', agent: agent('reviewer'), name: 'Final check', duty: 'Check the summary.' },
  ],
  flow: [
    { seat: 'scope' },
    { parallel: ['x', 'y'] },
    { loop: { work: ['w'], judge: 'j', rounds: 2 } },
  ],
};
