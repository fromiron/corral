import { CorralDefinition, type RunEvent } from '@corral/contracts';
import {
  type CompiledPlan,
  Coordinator,
  compileDefinition,
  type GraphRunner,
  InProcessTransport,
  type RunnerCallbacks,
  SequentialPlanRunner,
  waitForProjection,
} from '@corral/core';
import { describeGraphRunnerContract } from '@corral/core/testing';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { LangGraphRunner } from '../src/index.ts';

describeGraphRunnerContract('LangGraph', () => new LangGraphRunner());

function planOf(definition: unknown): CompiledPlan {
  const result = compileDefinition(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

/** Records every callback; decisions and failures come from a generated script. */
function scripted(decisions: string[], failing: Set<string>) {
  const log: string[] = [];
  let next = 0;
  const callbacks: RunnerCallbacks = {
    activate: async (nodeId, iteration) => {
      log.push(`activate ${nodeId}#${iteration?.no ?? '-'}`);
      return failing.has(`${nodeId}#${iteration?.no ?? '-'}`)
        ? { ok: false, reason: 'scripted failure' }
        : { ok: true };
    },
    decide: async (nodeId, iteration) => {
      const branch = decisions[next++ % decisions.length] ?? 'pass';
      log.push(`decide ${nodeId}#${iteration?.no ?? '-'} ${branch}`);
      return branch;
    },
    finalize: async (outputNodeId) => {
      log.push(`finalize ${outputNodeId}`);
    },
    loopEntered: async (loopId, no) => {
      log.push(`enter ${loopId}#${no}`);
    },
    loopLeft: async (loopId, no, outcome) => {
      log.push(`leave ${loopId}#${no} ${outcome}`);
    },
    loopCapReached: async (loopId, rounds) => {
      // Continue past the cap once in a while, driven by the same script.
      const answer =
        decisions[next % decisions.length] === 'revise' && rounds < 4 ? 'continue' : 'stop';
      log.push(`cap ${loopId}#${rounds} ${answer}`);
      return answer;
    },
  };
  return { log, callbacks };
}

describe('LangGraph runner parity with the reference runner', () => {
  it.each(['patch', 'approval'] as const)(
    'a runtime Loop %s can use all ten permitted rounds',
    async (extension) => {
      const run = async (runner: GraphRunner) => {
        const plan = planOf(researchTeam);
        const rounds: number[] = [];
        const { callbacks } = scripted(['revise'], new Set());
        callbacks.loopEntered = async (id, no) => {
          rounds.push(no);
          if (no === 1 && extension === 'patch') {
            const loop = plan.loops[id];
            const step = plan.steps[id];
            if (!loop || step?.kind !== 'loop') throw new Error('loop expected');
            loop.maxIterations = 10;
            step.maxIterations = 10;
          }
        };
        callbacks.decide = async (nodeId, iteration) =>
          nodeId === 'review_decision'
            ? (iteration?.no ?? 0) < 10
              ? 'revise'
              : 'pass'
            : 'approve';
        callbacks.loopCapReached = async () => 'continue';
        return { result: await runner.run(plan, callbacks), rounds };
      };
      const expected = await run(new SequentialPlanRunner());
      expect(expected.rounds).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await run(new LangGraphRunner())).toEqual(expected);
    },
  );

  it('takes the same steps for any decision and failure script', async () => {
    const definition = CorralDefinition.parse(researchTeam);
    const branch = fc.constantFrom('pass', 'revise', 'inconclusive', 'approve', 'reject');
    const failure = fc.constantFrom('research#-', 'write#1', 'review#2', 'write#3');
    await fc.assert(
      fc.asyncProperty(
        fc.array(branch, { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(failure, { maxLength: 1 }),
        fc.integer({ min: 1, max: 4 }),
        async (decisions, failures, cap) => {
          const loop = definition.nodes.find((n) => n.type === 'loop');
          if (loop?.type === 'loop') loop.maxIterations = cap;
          const plan = planOf(definition);
          const reference = scripted(decisions, new Set(failures));
          const graph = scripted(decisions, new Set(failures));
          const expected = await new SequentialPlanRunner().run(plan, reference.callbacks);
          const actual = await new LangGraphRunner().run(plan, graph.callbacks);
          expect(actual).toEqual(expected);
          expect(graph.log).toEqual(reference.log);
        },
      ),
      { seed: 20261015, numRuns: 200 },
    );
  });

  it('raises a callback error instead of retrying the step', async () => {
    const plan = planOf(CorralDefinition.parse(researchTeam));
    let calls = 0;
    const { callbacks } = scripted(['pass'], new Set());
    callbacks.activate = async () => {
      calls += 1;
      throw new Error('coordinator refused');
    };
    await expect(new LangGraphRunner().run(plan, callbacks)).rejects.toThrow('coordinator refused');
    expect(calls).toBe(1);
  });
});

describe('LangGraph runner under the Coordinator', () => {
  async function eventsWith(runner: GraphRunner) {
    const script: Record<string, string[]> = { review_decision: ['revise', 'pass'] };
    const definition = CorralDefinition.parse(researchTeam);
    for (const node of definition.nodes) if (node.type === 'output') node.requireApproval = false;
    const approval = definition.nodes.find((n) => n.id === 'approval');
    if (approval?.type === 'decision') script.approval = ['approve'];
    const transport = new InProcessTransport(
      new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
        runner,
        decisions: { decide: async ({ nodeId }) => script[nodeId]?.shift() ?? 'none' },
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_start',
      definition,
      mode: 'mock',
    });
    const events: RunEvent[] = [];
    transport.subscribe(runId ?? '', 0, { onEvent: (e) => events.push(e) });
    const final = await waitForProjection(transport, runId ?? '', (p) => p.status !== 'running');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return { final, events };
  }

  it('commits the same events as the reference runner for the research team', async () => {
    const reference = await eventsWith(new SequentialPlanRunner());
    const graph = await eventsWith(new LangGraphRunner());
    expect(graph.final.status).toBe('succeeded');
    expect(graph.events).toEqual(reference.events);
    expect(graph.final.nodeExecutions.write).toHaveLength(2);
  });
});
