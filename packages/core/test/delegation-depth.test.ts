import type { AgentHost, AgentSettlement, CorralDefinition } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  compileDefinition,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// docs/specs/features/team-graph.md: "정한 깊이까지 위임한다".

const NEXT: Record<string, string> = {
  research: 'deep_b',
  deep_b: 'deep_c',
  deep_c: 'deep_d',
  deep_d: 'deep_c',
};

/** research → B → C → D, and D may call C again: one level past a depth limit of 3. */
function chain(maxDelegationDepth: number): CorralDefinition {
  const definition = collaborationCorral('deep');
  definition.limits = { ...definition.limits, maxDelegationDepth };
  definition.roles.push({
    id: 'delegator',
    name: 'Delegator',
    prompt: 'Pass the work on.',
    modelProfile: 'model-a',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['spawn_subagents', 'await_tasks', 'read_artifact', 'submit_result'],
    outputContract: 'notes',
  });
  // The collaboration helper loses its only caller below; it leaves the team with it.
  definition.nodes = definition.nodes.filter((node) => node.id !== 'helper');
  for (const id of ['deep_b', 'deep_c', 'deep_d'])
    definition.nodes.push({
      id,
      type: 'agent',
      label: id,
      roleId: 'delegator',
      invocation: 'callable',
      inputBindings: [{ kind: 'run_input', name: 'brief' }],
      outputName: `${id}-notes`,
    });
  definition.capabilityLinks = [
    ...definition.capabilityLinks.filter((link) => link.kind !== 'delegate'),
    ...Object.entries(NEXT).map(([source, target]) => ({
      id: `call_${source}_${target}`,
      kind: 'delegate' as const,
      sourceNodeId: source,
      targetNodeId: target,
    })),
  ];
  return definition;
}

async function finish(host: AgentHost): Promise<AgentSettlement> {
  const written = await host.invokeTool({ name: 'write_artifact', args: { text: 'done' } });
  if (!written.ok) return { outcome: 'failed', error: written.error.message };
  const submitted = await host.invokeTool({
    name: 'submit_result',
    args: { artifactVersionIds: [written.result.artifactVersionId] },
  });
  return submitted.ok
    ? { outcome: 'succeeded' }
    : { outcome: 'failed', error: submitted.error.message };
}

describe('delegation deeper than two levels', () => {
  it('compiles a depth limit of 3 without a runtime warning', () => {
    const compiled = compileDefinition(chain(3));
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(compiled.diagnostics.map((d) => d.code)).not.toContain('RUNTIME_UNSUPPORTED');
  });

  it('runs down to the set depth and refuses one level more', async () => {
    const refused: { nodeId: string; code: string }[] = [];
    const store = new InMemoryRunStore();
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({
          turns: 1,
          script: async (input, host) => {
            const next = NEXT[input.nodeId];
            if (!next) return null;
            const spawned = await host.invokeTool({
              name: 'spawn_subagents',
              args: { tasks: [{ targetNodeId: next, brief: `Continue in ${next}.` }] },
            });
            if (!spawned.ok) {
              refused.push({ nodeId: input.nodeId, code: spawned.error.code });
              return finish(host);
            }
            const awaited = await host.invokeTool({
              name: 'await_tasks',
              args: { taskIds: spawned.result.taskIds as string[] },
            });
            if (!awaited.ok) return { outcome: 'failed', error: awaited.error.message };
            return finish(host);
          },
        }),
      }),
    );
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_deep',
      definition: chain(3),
      mode: 'mock',
    });
    expect(receipt.error ?? null).toBeNull();
    const final = await waitForProjection(transport, runId ?? '', (p: RunProjection) =>
      ['succeeded', 'failed', 'cancelled'].includes(p.status),
    );
    const depthOf = (nodeId: string) =>
      Object.values(final.executions)
        .filter((execution) => execution.nodeId === nodeId)
        .map((execution) => execution.depth);
    expect(depthOf('deep_b')).toEqual([1]);
    expect(depthOf('deep_c')).toEqual([2]);
    expect(depthOf('deep_d')).toEqual([3]);
    expect(refused).toEqual([{ nodeId: 'deep_d', code: 'LIMIT_REACHED' }]);
    expect(
      store
        .readEvents(runId ?? '', 0)
        .filter((event) => event.type === 'limit.reached')
        .map((event) => event.payload),
    ).toEqual([{ limitKind: 'depth', used: 3, max: 3 }]);
    expect(final.status).toBe('succeeded');
  });
});
