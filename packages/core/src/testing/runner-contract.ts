import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../../examples/research-team.corral.json' with { type: 'json' };
import { type CompiledPlan, compileDefinition } from '../compiler/index.ts';
import type { GraphRunner, IterationRef, RunnerCallbacks } from '../runner.ts';

/**
 * Behaviour every GraphRunner must share (runner parity, v0.2 supplement §5). The reference
 * runner in @corral/core and the LangGraph runner run the same scenarios on the same IR.
 */
export function describeGraphRunnerContract(name: string, makeRunner: () => GraphRunner) {
  const planOf = (definition: unknown): CompiledPlan => {
    const result = compileDefinition(definition);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.plan;
  };

  /** Records every callback and answers decisions from a script, in order. */
  function recorder(
    decisions: Record<string, string[]> = {},
    failAt?: string,
    capAnswers: ('continue' | 'stop')[] = [],
  ) {
    const log: string[] = [];
    const tag = (nodeId: string, iteration: IterationRef | null) =>
      iteration ? `${nodeId}#${iteration.no}` : nodeId;
    const callbacks: RunnerCallbacks = {
      async activate(nodeId, iteration) {
        log.push(`activate ${tag(nodeId, iteration)}`);
        return nodeId === failAt ? { ok: false, reason: 'agent failed' } : { ok: true };
      },
      async decide(nodeId, iteration) {
        const answer = decisions[nodeId]?.shift();
        if (!answer) throw new Error(`no scripted decision left for ${nodeId}`);
        log.push(`decide ${tag(nodeId, iteration)} → ${answer}`);
        return answer;
      },
      async finalize(outputNodeId) {
        log.push(`finalize ${outputNodeId}`);
      },
      async loopEntered(loopId, no) {
        log.push(`enter ${loopId}#${no}`);
      },
      async loopLeft(loopId, no, outcome) {
        log.push(`leave ${loopId}#${no} ${outcome}`);
      },
      async loopCapReached(loopId, rounds) {
        const answer = capAnswers.shift() ?? 'stop';
        log.push(`cap ${loopId}#${rounds} ${answer}`);
        return answer;
      },
    };
    return { log, callbacks };
  }

  describe(`GraphRunner contract: ${name}`, () => {
    it('runs a linear plan in the drawn order and finalizes the output', async () => {
      const { log, callbacks } = recorder();
      const result = await makeRunner().run(
        planOf(linearCorral(['research', 'writer'])),
        callbacks,
      );
      expect(log).toEqual(['activate research', 'activate writer', 'finalize output']);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('repeats the Loop body on revise and leaves through next on pass', async () => {
      const { log, callbacks } = recorder({
        review_decision: ['revise', 'pass'],
        approval: ['approve'],
      });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log).toEqual([
        'activate research',
        'enter review_loop#1',
        'activate write#1',
        'activate review#1',
        'decide review_decision#1 → revise',
        'leave review_loop#1 revise',
        'enter review_loop#2',
        'activate write#2',
        'activate review#2',
        'decide review_decision#2 → pass',
        'leave review_loop#2 pass',
        'decide approval → approve',
        'finalize output',
      ]);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('stops at the Loop cap instead of starting another round', async () => {
      const { log, callbacks } = recorder({ review_decision: ['revise', 'revise', 'revise'] });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.filter((line) => line.startsWith('activate write'))).toEqual([
        'activate write#1',
        'activate write#2',
      ]);
      expect(log.filter((line) => line.startsWith('leave'))).toEqual([
        'leave review_loop#1 revise',
        'leave review_loop#2 cap_reached',
      ]);
      expect(result).toEqual({ kind: 'cap_reached', loopId: 'review_loop', iterations: 2 });
    });

    it('runs one more round past the cap only when told to continue', async () => {
      const { log, callbacks } = recorder(
        { review_decision: ['revise', 'revise', 'pass'], approval: ['approve'] },
        undefined,
        ['continue'],
      );
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.filter((line) => line.startsWith('activate write'))).toEqual([
        'activate write#1',
        'activate write#2',
        'activate write#3',
      ]);
      expect(log).toContain('cap review_loop#2 continue');
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('ends as rejected when an approval is rejected', async () => {
      const { callbacks } = recorder({ review_decision: ['pass'], approval: ['reject'] });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(result).toEqual({ kind: 'rejected', nodeId: 'approval' });
    });

    it('stops at a failed step and names it', async () => {
      const { log, callbacks } = recorder({}, 'research');
      const result = await makeRunner().run(
        planOf(linearCorral(['research', 'writer'])),
        callbacks,
      );
      expect(log).toEqual(['activate research']);
      expect(result).toEqual({ kind: 'failed', nodeId: 'research', reason: 'agent failed' });
    });

    it('hands an inconclusive review to the user', async () => {
      const { log, callbacks } = recorder({ review_decision: ['inconclusive'] });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.at(-1)).toBe('leave review_loop#1 inconclusive');
      expect(result).toEqual({
        kind: 'needs_user',
        nodeId: 'review_decision',
        branch: 'inconclusive',
      });
    });

    it('stops without further steps once aborted', async () => {
      const signal = { aborted: false };
      const { log, callbacks } = recorder();
      const activate = callbacks.activate;
      callbacks.activate = async (nodeId, iteration) => {
        const outcome = await activate(nodeId, iteration);
        signal.aborted = true;
        return outcome;
      };
      const plan = planOf(linearCorral(['research', 'writer']));
      const result = await makeRunner().run(plan, callbacks, signal);
      expect(log).toEqual(['activate research']);
      expect(result).toEqual({ kind: 'stopped' });
    });
  });
}
