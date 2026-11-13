import type { CorralNode } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { subagentParents } from './VaultSettingsPage.tsx';

// Imported subagents hang under an agent that delegates (team-graph.md structure rule 11).
describe('subagent parents', () => {
  it('offers only agents in the flow: no callable agent and no advisor', () => {
    const nodes: CorralNode[] = [
      {
        id: 'writer',
        type: 'agent',
        label: 'Writer',
        roleId: 'writer_role',
        invocation: 'scheduled',
        inputBindings: [],
        outputName: 'text',
      },
      {
        id: 'helper',
        type: 'agent',
        label: 'Helper',
        roleId: 'helper_role',
        invocation: 'callable',
        inputBindings: [],
        outputName: 'help',
      },
      {
        id: 'advisor',
        type: 'agent',
        label: 'Advisor',
        roleId: 'advisor_role',
        invocation: 'observer',
        outputName: 'notes',
      },
      { id: 'out', type: 'output', label: 'Output', inputBindings: [], requireApproval: false },
    ];
    expect(subagentParents(nodes)).toEqual([{ value: 'writer', label: 'Writer' }]);
  });
});
