import { linearCorral } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../../examples/research-team.corral.json' with { type: 'json' };
import { type CompiledPlan, compileDefinition } from '../compiler/index.ts';
import { forkPlan, reachableFrom } from '../fork.ts';
import type { GraphRunner, IterationRef, LoopStop, RunnerCallbacks } from '../runner.ts';

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
  /** The research team with its review Loop's exhausted path taken out. */
  const withoutExhausted = () => {
    const definition = JSON.parse(JSON.stringify(researchTeam)) as typeof researchTeam;
    definition.controlEdges = definition.controlEdges.filter(
      (edge) => edge.sourcePort !== 'exhausted',
    );
    return definition;
  };

  /**
   * Records every callback and answers decisions from a script, in order. `stops` is what the
   * Coordinator's Loop check answers per `loop#round` (its cap, stall and limit policy).
   */
  function recorder(
    decisions: Record<string, string[]> = {},
    failAt?: string,
    stops: Record<string, LoopStop> = {},
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
        // `<stop>` stands for a person who stops the run at the decision instead of choosing.
        return answer === '<stop>' ? null : answer;
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
      async loopCheck(loopId, round) {
        const stop = stops[`${loopId}#${round}`] ?? null;
        log.push(`check ${loopId}#${round} ${stop ?? 'repeat'}`);
        return stop;
      },
      async joined(joinId, iteration, stopped) {
        log.push(
          `join ${tag(joinId, iteration)}${stopped.length ? ` stops ${stopped.map((s) => tag(s.nodeId, s.iteration)).join(',')}` : ''}`,
        );
      },
    };
    return { log, callbacks };
  }

  /** p fans out to a and b, which meet at Join j (policy given), then m → output. */
  function forked(policy: 'all' | 'any') {
    const definition = linearCorral(['p', 'a', 'b', 'm']);
    for (const node of definition.nodes)
      if (
        node.type === 'agent' &&
        node.invocation !== 'observer' &&
        (node.id === 'a' || node.id === 'b')
      )
        node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }];
    definition.nodes.push({ id: 'j', type: 'join', label: 'j', policy });
    const edge = (id: string, source: string, target: string) => ({
      id,
      source,
      sourcePort: 'out',
      target,
      targetPort: 'in' as const,
    });
    definition.controlEdges = [
      edge('pa', 'p', 'a'),
      edge('pb', 'p', 'b'),
      edge('aj', 'a', 'j'),
      edge('bj', 'b', 'j'),
      edge('jm', 'j', 'm'),
      edge('mo', 'm', 'output'),
    ];
    return planOf(definition);
  }

  const link = (
    id: string,
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ) => ({
    id,
    source,
    sourcePort,
    target,
    targetPort: targetPort as 'in',
  });

  /** p → inline Team t [ a ] → q → output; without p the run starts at t. */
  function teamed(startAtTeam = false) {
    const definition = linearCorral(startAtTeam ? ['a', 'q'] : ['p', 'a', 'q']);
    definition.nodes.push({ id: 't', type: 'team', label: 't', source: { kind: 'inline' } });
    for (const node of definition.nodes) if (node.id === 'a') node.parentId = 't';
    definition.entryNodeId = startAtTeam ? 't' : 'p';
    definition.controlEdges = [
      ...(startAtTeam ? [] : [link('pt', 'p', 'out', 't', 'enter')]),
      link('ta', 't', 'body', 'a', 'in'),
      link('at', 'a', 'out', 't', 'exit'),
      link('tq', 't', 'next', 'q', 'in'),
      link('qo', 'q', 'out', 'output', 'in'),
    ];
    return planOf(definition);
  }

  /**
   * Inline Team t [ Loop l [ a → router d (again: l.repeat, leave: t.exit, done: l.exit) ] ]
   * → q → output. `leave` leaves the Loop and the Team in one step.
   */
  function loopInTeam() {
    const definition = linearCorral(['a', 'q']);
    definition.nodes.push(
      { id: 't', type: 'team', label: 't', source: { kind: 'inline' } },
      { id: 'l', type: 'loop', label: 'l', parentId: 't', maxIterations: 3 },
      {
        id: 'd',
        type: 'decision',
        label: 'd',
        parentId: 'l',
        mode: 'router',
        routes: ['again', 'leave', 'done'].map((id) => ({ id, label: id })),
        inputBindings: [{ kind: 'task_output', name: 'input', sourceNodeId: 'a' }],
      },
    );
    for (const node of definition.nodes) if (node.id === 'a') node.parentId = 'l';
    definition.entryNodeId = 't';
    definition.controlEdges = [
      link('tl', 't', 'body', 'l', 'enter'),
      link('la', 'l', 'body', 'a', 'in'),
      link('ad', 'a', 'out', 'd', 'in'),
      link('dl', 'd', 'again', 'l', 'repeat'),
      link('dt', 'd', 'leave', 't', 'exit'),
      link('dx', 'd', 'done', 'l', 'exit'),
      link('lt', 'l', 'next', 't', 'exit'),
      link('tq', 't', 'next', 'q', 'in'),
      link('qo', 'q', 'out', 'output', 'in'),
    ];
    return planOf(definition);
  }

  /** Holds each named step until released; the recorder answers once it is. */
  function held(callbacks: RunnerCallbacks, log: string[], names: string[]) {
    const releases = new Map<string, (ok: boolean) => void>();
    const started = new Set<string>();
    const activate = callbacks.activate;
    callbacks.activate = async (nodeId, iteration) => {
      if (!names.includes(nodeId)) return activate(nodeId, iteration);
      log.push(`start ${nodeId}`);
      started.add(nodeId);
      const ok = await new Promise<boolean>((resolve) => releases.set(nodeId, resolve));
      log.push(`done ${nodeId}`);
      return ok ? { ok: true } : { ok: false, reason: `${nodeId} failed` };
    };
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 1000 && !check(); i++) await Promise.resolve();
    };
    return {
      started: (nodeId: string) => until(() => started.has(nodeId)),
      release: (nodeId: string, ok = true) => releases.get(nodeId)?.(ok),
    };
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
        'check review_loop#1 repeat',
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

    // docs/specs/features/fork-and-breakpoints.md: a fork runs from its step only.
    it('runs a fork plan from a top-level Loop without the steps before it', async () => {
      const { log, callbacks } = recorder({
        review_decision: ['pass'],
        approval: ['approve'],
      });
      const plan = planOf(researchTeam);
      const result = await makeRunner().run(
        forkPlan(plan, 'review_loop', reachableFrom(plan, 'review_loop')),
        callbacks,
      );
      expect(log).toEqual([
        'enter review_loop#1',
        'activate write#1',
        'activate review#1',
        'decide review_decision#1 → pass',
        'leave review_loop#1 pass',
        'decide approval → approve',
        'finalize output',
      ]);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('ends an exhausted Loop without an exhausted path, naming the Loop and why', async () => {
      const { log, callbacks } = recorder(
        { review_decision: ['revise', 'revise', 'revise'] },
        undefined,
        { 'review_loop#2': 'cap_reached' },
      );
      const result = await makeRunner().run(planOf(withoutExhausted()), callbacks);
      expect(log.filter((line) => line.startsWith('activate write'))).toEqual([
        'activate write#1',
        'activate write#2',
      ]);
      expect(log.filter((line) => line.startsWith('leave'))).toEqual([
        'leave review_loop#1 revise',
        'leave review_loop#2 cap_reached',
      ]);
      expect(result).toEqual({ kind: 'exhausted', loopId: 'review_loop', reason: 'cap_reached' });
    });

    it('leaves an exhausted Loop through its exhausted path to the step next leads to', async () => {
      const { log, callbacks } = recorder(
        { review_decision: ['revise', 'revise'], approval: ['approve'] },
        undefined,
        { 'review_loop#2': 'cap_reached' },
      );
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.slice(-3)).toEqual([
        'leave review_loop#2 cap_reached',
        'decide approval → approve',
        'finalize output',
      ]);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('opens another round whenever the Loop check lets the Loop go on', async () => {
      // The Coordinator answers null past the cap when the Loop's limit policy raised its Agents.
      const { log, callbacks } = recorder({
        review_decision: ['revise', 'revise', 'pass'],
        approval: ['approve'],
      });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.filter((line) => line.startsWith('activate write'))).toEqual([
        'activate write#1',
        'activate write#2',
        'activate write#3',
      ]);
      expect(log.filter((line) => line.startsWith('check'))).toEqual([
        'check review_loop#1 repeat',
        'check review_loop#2 repeat',
      ]);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('leaves a stalled Loop through its exhausted path', async () => {
      const definition = withoutExhausted();
      definition.nodes.push({
        id: 'fallback',
        type: 'agent',
        label: 'fallback',
        roleId: 'writer',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'draft',
      } as (typeof researchTeam.nodes)[number]);
      definition.controlEdges.push(
        {
          id: 'e_exhausted',
          source: 'review_loop',
          sourcePort: 'exhausted',
          target: 'fallback',
          targetPort: 'in',
        },
        {
          id: 'e_fallback',
          source: 'fallback',
          sourcePort: 'out',
          target: 'approval',
          targetPort: 'in',
        },
      );
      const { log, callbacks } = recorder(
        { review_decision: ['revise'], approval: ['approve'] },
        undefined,
        { 'review_loop#1': 'stalled' },
      );
      const result = await makeRunner().run(planOf(definition), callbacks);
      expect(log).toContain('leave review_loop#1 stalled');
      expect(log).toContain('activate fallback');
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

    it('takes the error port of a failed step', async () => {
      const definition = linearCorral(['research', 'writer', 'fallback']);
      definition.controlEdges.push({
        id: 'e_error',
        source: 'research',
        sourcePort: 'error',
        target: 'fallback',
        targetPort: 'in',
      });
      const { log, callbacks } = recorder({}, 'research');
      const result = await makeRunner().run(planOf(definition), callbacks);
      expect(log).toEqual(['activate research', 'activate fallback', 'finalize output']);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it('ends as rejected when the person stops the run at a decision', async () => {
      const { log, callbacks } = recorder({ review_decision: ['<stop>'] });
      const result = await makeRunner().run(planOf(researchTeam), callbacks);
      expect(log.at(-1)).toBe('decide review_decision#1 → <stop>');
      expect(result).toEqual({ kind: 'rejected', nodeId: 'review_decision' });
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

    it('runs parallel branches at once and continues after an all Join once both arrive', async () => {
      const { log, callbacks } = recorder();
      const hold = held(callbacks, log, ['a', 'b']);
      const result = makeRunner().run(forked('all'), callbacks);
      await hold.started('a');
      await hold.started('b');
      expect(log).toEqual(['activate p', 'start a', 'start b']);
      hold.release('b');
      await hold.started('nothing');
      expect(log).not.toContain('join j');
      hold.release('a');
      expect(await result).toEqual({ kind: 'finished', outputNodeId: 'output' });
      expect(log.slice(3)).toEqual(['done b', 'done a', 'join j', 'activate m', 'finalize output']);
    });

    it('continues after an any Join with the first branch and stops the other', async () => {
      const { log, callbacks } = recorder();
      const hold = held(callbacks, log, ['a', 'b']);
      const joined = callbacks.joined;
      // The Coordinator cancels the stopped step; here that settles b as failed.
      callbacks.joined = async (joinId, iteration, stopped, loops) => {
        await joined(joinId, iteration, stopped, loops);
        for (const step of stopped) hold.release(step.nodeId, false);
      };
      const result = makeRunner().run(forked('any'), callbacks);
      await hold.started('b');
      hold.release('a');
      expect(await result).toEqual({ kind: 'finished', outputNodeId: 'output' });
      expect(log).toContain('join j stops b');
      expect(log.filter((line) => line === 'activate m')).toHaveLength(1);
      expect(log).not.toContain('activate j');
    });

    it('ends the run when one branch fails, without waiting for the other', async () => {
      const { log, callbacks } = recorder();
      const hold = held(callbacks, log, ['a', 'b']);
      const result = makeRunner().run(forked('all'), callbacks);
      await hold.started('b');
      hold.release('a', false);
      expect(await result).toEqual({ kind: 'failed', nodeId: 'a', reason: 'a failed' });
      expect(log).not.toContain('join j');
    });

    it('runs the members of an inline Team between the steps around it', async () => {
      const { log, callbacks } = recorder();
      expect(await makeRunner().run(teamed(), callbacks)).toEqual({
        kind: 'finished',
        outputNodeId: 'output',
      });
      expect(log).toEqual(['activate p', 'activate a', 'activate q', 'finalize output']);
    });

    it('starts at an inline Team with its first member', async () => {
      const { log, callbacks } = recorder();
      await makeRunner().run(teamed(true), callbacks);
      expect(log).toEqual(['activate a', 'activate q', 'finalize output']);
    });

    it('closes a Loop round inside a Team that a member leaves through the Team exit', async () => {
      const { log, callbacks } = recorder({ d: ['again', 'leave'] });
      expect(await makeRunner().run(loopInTeam(), callbacks)).toEqual({
        kind: 'finished',
        outputNodeId: 'output',
      });
      expect(log).toEqual([
        'enter l#1',
        'activate a#1',
        'decide d#1 → again',
        'check l#1 repeat',
        'leave l#1 revise',
        'enter l#2',
        'activate a#2',
        'decide d#2 → leave',
        'leave l#2 pass',
        'activate q',
        'finalize output',
      ]);
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
