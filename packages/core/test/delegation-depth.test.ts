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
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// docs/specs/features/team-graph.md: "정한 깊이까지 위임한다" and "설치 상한보다 큰 하위 실행 수는
// 상한으로 실행한다".

const ended = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

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
  it('compiles a depth limit of 3', () => {
    expect(compileDefinition(chain(3)).ok).toBe(true);
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
    const final = await waitForProjection(transport, runId ?? '', ended);
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

describe('a spawn limit above the installation cap', () => {
  it('starts with the cap and refuses the child execution past it', async () => {
    const store = new InMemoryRunStore();
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        policy: { ...SPEC_HARD_CAPS, maxSpawns: 2 },
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      }),
    );
    const definition = collaborationCorral('capped');
    definition.limits = { ...definition.limits, maxSpawns: 5 };
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_capped',
      definition,
      mode: 'mock',
    });
    expect(receipt.error ?? null).toBeNull();
    const final = await waitForProjection(transport, runId ?? '', ended);
    const events = store.readEvents(runId ?? '', 0);
    const started = events.find((event) => event.type === 'run.started');
    expect(started?.type === 'run.started' && started.payload.limits.maxSpawns).toBe(2);
    expect(final.limits?.maxSpawns).toBe(2);
    // Research starts two helpers; the writer's question would be the third.
    expect(
      events.filter((event) => event.type === 'limit.reached').map((event) => event.payload),
    ).toEqual([{ limitKind: 'spawns', used: 2, max: 2 }]);
  });
});
