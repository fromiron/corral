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

  const router = (id: string, parentId: string, source: string, routes: string[]) => ({
    id,
    type: 'decision' as const,
    label: id,
    parentId,
    mode: 'router' as const,
    routes: routes.map((route) => ({ id: route, label: route })),
    inputBindings: [{ kind: 'task_output' as const, name: 'input', sourceNodeId: source }],
  });

  /**
   * s → Loop l [ p → [ router d, router e ] → Join j (any) → router f → output ], with f's
   * again: l.repeat, leave: l.exit; l.next → q → final. d's `inconclusive` route has no edge.
   */
  function roundInBranches() {
    const definition = linearCorral(['s', 'p', 'q']);
    for (const node of definition.nodes) {
      if (node.id === 'p') node.parentId = 'l';
      if (node.type === 'output') {
        node.parentId = 'l';
        node.inputBindings = [{ kind: 'task_output', name: 'final', sourceNodeId: 'p' }];
      }
    }
    definition.nodes.push(
      { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
      router('d', 'l', 'p', ['go', 'inconclusive']),
      router('e', 'l', 'p', ['go', 'other']),
      { id: 'j', type: 'join', label: 'j', parentId: 'l', policy: 'any' },
      router('f', 'l', 'p', ['done', 'again', 'leave']),
      {
        id: 'final',
        type: 'output',
        label: 'final',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'q' }],
        requireApproval: false,
      },
    );
    definition.controlEdges = [
      link('sl', 's', 'out', 'l', 'enter'),
      link('lp', 'l', 'body', 'p', 'in'),
      link('pd', 'p', 'out', 'd', 'in'),
      link('pe', 'p', 'out', 'e', 'in'),
      link('dj', 'd', 'go', 'j', 'in'),
      link('ej', 'e', 'go', 'j', 'in'),
      link('jf', 'j', 'out', 'f', 'in'),
      link('fo', 'f', 'done', 'output', 'in'),
      link('fr', 'f', 'again', 'l', 'repeat'),
      link('fx', 'f', 'leave', 'l', 'exit'),
      link('lq', 'l', 'next', 'q', 'in'),
      link('qf', 'q', 'out', 'final', 'in'),
    ];
    return planOf(definition);
  }

  /**
   * Loop o [ p → [ Loop l [ w → router dl ], x ] → Join j (any) → router od ] → output, with
   * dl's pass: l.exit, again: l.repeat; od's again: o.repeat, done: o.exit.
   */
  function loopInLosingBranch() {
    const definition = linearCorral(['p', 'w', 'x']);
    for (const node of definition.nodes) {
      if (node.id === 'p' || node.id === 'x') node.parentId = 'o';
      if (node.id === 'w') node.parentId = 'l';
      if (node.type === 'agent' && node.invocation !== 'observer' && node.id !== 'p')
        node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }];
      if (node.type === 'output')
        node.inputBindings = [{ kind: 'task_output', name: 'final', sourceNodeId: 'p' }];
    }
    definition.entryNodeId = 'o';
    definition.nodes.push(
      { id: 'o', type: 'loop', label: 'o', maxIterations: 3 },
      { id: 'l', type: 'loop', label: 'l', parentId: 'o', maxIterations: 3 },
      router('dl', 'l', 'w', ['pass', 'again']),
      { id: 'j', type: 'join', label: 'j', parentId: 'o', policy: 'any' },
      router('od', 'o', 'p', ['again', 'done']),
    );
    definition.controlEdges = [
      link('op', 'o', 'body', 'p', 'in'),
      link('pl', 'p', 'out', 'l', 'enter'),
      link('px', 'p', 'out', 'x', 'in'),
      link('lw', 'l', 'body', 'w', 'in'),
      link('wd', 'w', 'out', 'dl', 'in'),
      link('dx', 'dl', 'pass', 'l', 'exit'),
      link('dr', 'dl', 'again', 'l', 'repeat'),
      link('lj', 'l', 'next', 'j', 'in'),
      link('xj', 'x', 'out', 'j', 'in'),
      link('jd', 'j', 'out', 'od', 'in'),
      link('or', 'od', 'again', 'o', 'repeat'),
      link('ox', 'od', 'done', 'o', 'exit'),
      link('oo', 'o', 'next', 'output', 'in'),
    ];
    return planOf(definition);
  }

  /** Resolves once `check` holds, or after a bounded number of turns. */
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 1000 && !check(); i++) await Promise.resolve();
  };

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

    // docs/specs/features/team-graph.md, "병렬 실행", 끝난 회차의 분기.
    it('lets a branch go no further once a sibling Decision ended its round inconclusive', async () => {
      const { log, callbacks } = recorder({ d: ['inconclusive'], e: ['go'], f: ['done'] });
      const { decide, loopLeft, joined } = callbacks;
      let closed = false;
      let joinedOnce = false;
      // e decides once d has closed the round; the close is answered only after e has had
      // its chance to reach the Join, so d's branch has not yet ended the run when it does.
      callbacks.decide = async (nodeId, iteration) => {
        if (nodeId === 'e') await until(() => closed);
        return decide(nodeId, iteration);
      };
      callbacks.loopLeft = async (loopId, no, outcome) => {
        await loopLeft(loopId, no, outcome);
        if (outcome !== 'inconclusive') return;
        closed = true;
        await until(() => joinedOnce);
      };
      callbacks.joined = async (...args) => {
        joinedOnce = true;
        return joined(...args);
      };
      const result = await makeRunner().run(roundInBranches(), callbacks);
      expect(log).toContain('decide e#1 → go');
      expect(log).toContain('leave l#1 inconclusive');
      expect(log.some((line) => line.startsWith('join'))).toBe(false);
      expect(log).not.toContain('finalize output');
      expect(result).toEqual({ kind: 'needs_user', nodeId: 'd', branch: 'inconclusive' });
    });

    it('keeps the needs_user of the round’s close when a sibling then ends as rejected', async () => {
      const { log, callbacks } = recorder({ d: ['inconclusive'], e: ['<stop>'] });
      const { decide, loopLeft } = callbacks;
      let closed = false;
      let rejected = false;
      // e is stopped by the person once d has closed the round; the close is answered only
      // after e's branch has had every chance to end the run.
      callbacks.decide = async (nodeId, iteration) => {
        if (nodeId === 'e') await until(() => closed);
        const branch = await decide(nodeId, iteration);
        if (nodeId === 'e') rejected = true;
        return branch;
      };
      callbacks.loopLeft = async (loopId, no, outcome) => {
        await loopLeft(loopId, no, outcome);
        if (outcome !== 'inconclusive') return;
        closed = true;
        await until(() => rejected);
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      const result = await makeRunner().run(roundInBranches(), callbacks);
      expect(log).toContain('decide e#1 → <stop>');
      expect(result).toEqual({ kind: 'needs_user', nodeId: 'd', branch: 'inconclusive' });
    });

    it('closes the round once when a sibling then also comes back inconclusive', async () => {
      // e's answer, asked in the round d then closes, would close the same round again.
      const { log, callbacks } = recorder({ d: ['inconclusive'], e: ['inconclusive'] });
      const { decide, loopLeft } = callbacks;
      let closed = false;
      let answered = false;
      callbacks.decide = async (nodeId, iteration) => {
        if (nodeId === 'e') await until(() => closed);
        const branch = await decide(nodeId, iteration);
        if (nodeId === 'e') answered = true;
        return branch;
      };
      callbacks.loopLeft = async (loopId, no, outcome) => {
        await loopLeft(loopId, no, outcome);
        if (outcome !== 'inconclusive' || answered) return;
        closed = true;
        await until(() => answered);
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      const result = await makeRunner().run(roundInBranches(), callbacks);
      expect(log).toContain('decide e#1 → inconclusive');
      expect(log.filter((line) => line.startsWith('leave l#1'))).toEqual([
        'leave l#1 inconclusive',
      ]);
      expect(result).toEqual({ kind: 'needs_user', nodeId: 'd', branch: 'inconclusive' });
    });

    it('keeps the needs_user of the round’s close when a sibling’s request then fails', async () => {
      const { log, callbacks } = recorder({ d: ['inconclusive'], e: ['go'] });
      const { decide, loopLeft } = callbacks;
      let closed = false;
      let failed = false;
      // e's request, made in the round d then closes, fails as a dropped request does.
      callbacks.decide = async (nodeId, iteration) => {
        if (nodeId !== 'e') return decide(nodeId, iteration);
        await until(() => closed);
        failed = true;
        throw new Error('branch stopped');
      };
      callbacks.loopLeft = async (loopId, no, outcome) => {
        await loopLeft(loopId, no, outcome);
        if (outcome !== 'inconclusive') return;
        closed = true;
        await until(() => failed);
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      const result = await makeRunner().run(roundInBranches(), callbacks);
      expect(log).toContain('leave l#1 inconclusive');
      expect(result).toEqual({ kind: 'needs_user', nodeId: 'd', branch: 'inconclusive' });
    });

    it('drops a stopped branch whose Decision comes back inconclusive after the Join', async () => {
      const { log, callbacks } = recorder({ d: ['inconclusive'], e: ['go'], f: ['done'] });
      const { decide, joined } = callbacks;
      let joinedOnce = false;
      callbacks.decide = async (nodeId, iteration) => {
        if (nodeId === 'd') await until(() => joinedOnce);
        return decide(nodeId, iteration);
      };
      callbacks.joined = async (...args) => {
        await joined(...args);
        joinedOnce = true;
      };
      const result = await makeRunner().run(roundInBranches(), callbacks);
      expect(log).toContain('join j#1 stops d#1');
      expect(log).not.toContain('leave l#1 inconclusive');
      expect(log).toContain('decide f#1 → done');
      expect(log.at(-1)).toBe('finalize output');
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it.each(['a stopped step', 'a stopped Loop entry'])(
      'enters a Loop afresh after an any Join stopped %s in it and the Loop around repeated',
      async (stoppedAt) => {
        const { log, callbacks } = recorder({ od: ['again', 'done'], dl: ['pass'] });
        const { activate, loopEntered, joined } = callbacks;
        let joins = 0;
        let xRuns = 0;
        // o's first round: x wins the Join over l's branch, stopped at w or while entering l.
        // o's second round: l's fresh entry wins over x.
        callbacks.activate = async (nodeId, iteration) => {
          if (nodeId === 'w' && joins === 0) {
            await until(() => joins === 1);
            return { ok: false, reason: 'stopped' };
          }
          if (nodeId === 'x' && ++xRuns === 2) {
            await until(() => joins === 2);
            return { ok: false, reason: 'stopped' };
          }
          return activate(nodeId, iteration);
        };
        callbacks.loopEntered = async (loopId, no) => {
          await loopEntered(loopId, no);
          if (loopId === 'l' && joins === 0 && stoppedAt === 'a stopped Loop entry') {
            await until(() => joins === 1);
            throw new Error('branch stopped');
          }
        };
        callbacks.joined = async (...args) => {
          await joined(...args);
          joins += 1;
        };
        const result = await makeRunner().run(loopInLosingBranch(), callbacks);
        expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
        expect(log.filter((line) => line.startsWith('enter l'))).toEqual([
          'enter l#1',
          'enter l#1',
        ]);
        expect(log.filter((line) => line.startsWith('join'))).toEqual([
          stoppedAt === 'a stopped step' ? 'join j#1 stops w#1' : 'join j#1 stops l#1',
          'join j#2 stops x#2',
        ]);
        expect(log).toContain('leave l#1 pass');
      },
    );

    // docs/specs/features/team-graph.md, "병렬 실행", 갈라지기.
    it.each(['first', 'last'])(
      'starts no branch of a fan-out with a repeat target %s, and fails',
      async (where) => {
        // Loop o [ Loop l [ a → router d (again: l.repeat, done: l.exit) ] → router od
        // (again: o.repeat, done: o.exit) ] → output; d's again also gets o's repeat by hand.
        const definition = linearCorral(['a']);
        for (const node of definition.nodes) if (node.id === 'a') node.parentId = 'l';
        definition.entryNodeId = 'o';
        definition.nodes.push(
          { id: 'o', type: 'loop', label: 'o', maxIterations: 3 },
          { id: 'l', type: 'loop', label: 'l', parentId: 'o', maxIterations: 3 },
          router('d', 'l', 'a', ['again', 'done']),
          router('od', 'o', 'a', ['again', 'done']),
        );
        definition.controlEdges = [
          link('ol', 'o', 'body', 'l', 'enter'),
          link('la', 'l', 'body', 'a', 'in'),
          link('ad', 'a', 'out', 'd', 'in'),
          link('dr', 'd', 'again', 'l', 'repeat'),
          link('dx', 'd', 'done', 'l', 'exit'),
          link('ld', 'l', 'next', 'od', 'in'),
          link('or', 'od', 'again', 'o', 'repeat'),
          link('ox', 'od', 'done', 'o', 'exit'),
          link('oo', 'o', 'next', 'output', 'in'),
        ];
        const plan = planOf(definition);
        const d = plan.steps.d;
        if (d?.kind !== 'decision') throw new Error('d is not a decision');
        const outer = { nodeId: 'o', port: 'repeat' as const };
        const inner = d.branches.again ?? [];
        d.branches.again = where === 'first' ? [outer, ...inner] : [...inner, outer];
        const { log, callbacks } = recorder({ d: ['again'] });
        await expect(makeRunner().run(plan, callbacks)).rejects.toThrow('repeat of Loop');
        expect(log.at(-1)).toBe('decide d#1 → again');
      },
    );

    /**
     * Loop l [ p → [ q → [a, b] → Join k (policy given) → [u, v] → all Join k2, x ] → any Join j
     * → router d ], d's pass: l.exit, again: l.repeat; l.next → output.
     */
    function joinInsideBranch(policy: 'all' | 'any') {
      const definition = linearCorral(['p', 'q', 'a', 'b', 'u', 'v', 'x']);
      for (const node of definition.nodes) {
        if (node.type !== 'output') node.parentId = 'l';
        if (node.type === 'agent' && node.invocation !== 'observer' && node.id !== 'p')
          node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }];
        if (node.type === 'output')
          node.inputBindings = [{ kind: 'task_output', name: 'final', sourceNodeId: 'p' }];
      }
      definition.entryNodeId = 'l';
      definition.nodes.push(
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
        { id: 'k', type: 'join', label: 'k', parentId: 'l', policy },
        { id: 'k2', type: 'join', label: 'k2', parentId: 'l', policy: 'all' },
        { id: 'j', type: 'join', label: 'j', parentId: 'l', policy: 'any' },
        router('d', 'l', 'p', ['pass', 'again']),
      );
      definition.controlEdges = [
        link('lp', 'l', 'body', 'p', 'in'),
        link('pq', 'p', 'out', 'q', 'in'),
        link('px', 'p', 'out', 'x', 'in'),
        link('qa', 'q', 'out', 'a', 'in'),
        link('qb', 'q', 'out', 'b', 'in'),
        link('ak', 'a', 'out', 'k', 'in'),
        link('bk', 'b', 'out', 'k', 'in'),
        link('ku', 'k', 'out', 'u', 'in'),
        link('kv', 'k', 'out', 'v', 'in'),
        link('uk', 'u', 'out', 'k2', 'in'),
        link('vk', 'v', 'out', 'k2', 'in'),
        link('kj', 'k2', 'out', 'j', 'in'),
        link('xj', 'x', 'out', 'j', 'in'),
        link('jd', 'j', 'out', 'd', 'in'),
        link('dx', 'd', 'pass', 'l', 'exit'),
        link('dr', 'd', 'again', 'l', 'repeat'),
        link('lo', 'l', 'next', 'output', 'in'),
      ];
      return planOf(definition);
    }

    // docs/specs/features/team-graph.md, "병렬 실행": a stopped branch fans out past no Join.
    it.each(['all', 'any'] as const)(
      'fans out past no %s Join a branch that an outer any Join stopped while it joined',
      async (policy) => {
        const { log, callbacks } = recorder({ d: ['again', 'pass'] });
        const { activate, joined } = callbacks;
        let atK = false;
        // Round 1: x waits until k's join is under way, and k's join answers only after x has
        // won j. Round 2: x waits until the other branch has won j.
        callbacks.activate = async (nodeId, iteration) => {
          if (nodeId === 'x' && iteration?.no === 1) await until(() => atK);
          if (nodeId === 'x' && iteration?.no === 2)
            await until(() => log.some((line) => line.startsWith('join j#2')));
          return activate(nodeId, iteration);
        };
        callbacks.joined = async (joinId, iteration, stopped, loops) => {
          if (joinId === 'k' && iteration?.no === 1) {
            atK = true;
            await until(() => log.some((line) => line.startsWith('join j#1')));
          }
          return joined(joinId, iteration, stopped, loops);
        };
        const result = await makeRunner().run(joinInsideBranch(policy), callbacks);
        expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
        const j1 = log.findIndex((line) => line.startsWith('join j#1'));
        expect(log.findIndex((line) => line.startsWith('join k#1'))).toBeGreaterThan(j1);
        expect(log).not.toContain('activate u#1');
        expect(log).not.toContain('activate v#1');
        expect(log).toContain('activate u#2');
        expect(log.slice(-2)).toEqual(['leave l#2 pass', 'finalize output']);
      },
    );

    /**
     * p → [ q → [y, z] → Join k (any) → w, x ] → Join j (any) → output. With `looped`, q's part
     * is Loop l [ a → [y, z] → k → router dl (again: l.repeat, pass: l.exit) ], l.next → j.
     */
    function nestedAnyJoins(looped: boolean) {
      const definition = linearCorral(['p', 'q', 'a', 'y', 'z', 'w', 'x']);
      const inLoop = ['a', 'y', 'z'];
      const used = looped ? ['p', 'a', 'y', 'z', 'x'] : ['p', 'q', 'y', 'z', 'w', 'x'];
      definition.nodes = definition.nodes.filter((n) => n.type === 'output' || used.includes(n.id));
      for (const node of definition.nodes) {
        if (looped && inLoop.includes(node.id)) node.parentId = 'l';
        if (node.type === 'agent' && node.invocation !== 'observer' && node.id !== 'p')
          node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }];
        if (node.type === 'output')
          node.inputBindings = [{ kind: 'task_output', name: 'final', sourceNodeId: 'p' }];
      }
      definition.nodes.push(
        { id: 'k', type: 'join', label: 'k', policy: 'any', ...(looped ? { parentId: 'l' } : {}) },
        { id: 'j', type: 'join', label: 'j', policy: 'any' },
      );
      if (looped)
        definition.nodes.push(
          { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
          router('dl', 'l', 'p', ['pass', 'again']),
        );
      const head = looped ? 'a' : 'q';
      definition.controlEdges = [
        looped ? link('pl', 'p', 'out', 'l', 'enter') : link('pq', 'p', 'out', 'q', 'in'),
        link('px', 'p', 'out', 'x', 'in'),
        ...(looped ? [link('la', 'l', 'body', 'a', 'in')] : []),
        link('hy', head, 'out', 'y', 'in'),
        link('hz', head, 'out', 'z', 'in'),
        link('yk', 'y', 'out', 'k', 'in'),
        link('zk', 'z', 'out', 'k', 'in'),
        ...(looped
          ? [
              link('kd', 'k', 'out', 'dl', 'in'),
              link('dx', 'dl', 'pass', 'l', 'exit'),
              link('dr', 'dl', 'again', 'l', 'repeat'),
              link('lj', 'l', 'next', 'j', 'in'),
            ]
          : [link('kw', 'k', 'out', 'w', 'in'), link('wj', 'w', 'out', 'j', 'in')]),
        link('xj', 'x', 'out', 'j', 'in'),
        link('jo', 'j', 'out', 'output', 'in'),
      ];
      return planOf(definition);
    }

    // "기록": a Join does not stop again a branch another Join already stopped.
    it.each([false, true])(
      'an outer any Join reports no branch an inner one already stopped (in a Loop: %s)',
      async (looped) => {
        const { log, callbacks } = recorder({ dl: ['again'] });
        const { activate, joined } = callbacks;
        const reported: { loopId: string; no: number }[][] = [];
        const joinedJ = () => log.some((line) => line.startsWith('join j'));
        // z, stopped by k, is still ending; the inner winner's next step (w, or a in l's second
        // round) runs on; x reaches j once that step has started.
        const last = looped ? 'a' : 'w';
        callbacks.activate = async (nodeId, iteration) => {
          if (nodeId === 'z' || (nodeId === last && (!looped || iteration?.no === 2))) {
            const outcome = activate(nodeId, iteration);
            await until(joinedJ);
            await outcome;
            return { ok: false, reason: 'stopped' };
          }
          if (nodeId === 'x')
            await until(() => log.includes(looped ? 'activate a#2' : 'activate w'));
          return activate(nodeId, iteration);
        };
        callbacks.joined = async (joinId, iteration, stopped, loops) => {
          if (joinId === 'j') reported.push(loops);
          return joined(joinId, iteration, stopped, loops);
        };
        const result = await makeRunner().run(nestedAnyJoins(looped), callbacks);
        expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
        const joins = log.filter((line) => line.startsWith('join'));
        if (looped) {
          expect(reported).toEqual([[{ loopId: 'l', no: 2 }]]);
          expect(joins).toEqual(['join k#1 stops z#1', 'join j stops a#2']);
        } else {
          expect(joins).toEqual(['join k stops z', 'join j stops w']);
        }
      },
    );

    // "끝난 회차의 분기", 다만: a branch outside the Loop that reaches the any Join first.
    it('goes on through the any Join an outside branch reaches before the round’s close ends the run', async () => {
      // s → [ Loop l [ router d (go: l.exit, again: l.repeat) ], b ] → Join k (any) → m → output;
      // d's inconclusive has no edge.
      const definition = linearCorral(['s', 'b', 'm']);
      for (const node of definition.nodes) {
        if (node.type === 'agent' && node.invocation !== 'observer' && node.id !== 's')
          node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 's' }];
        if (node.type === 'output')
          node.inputBindings = [{ kind: 'task_output', name: 'final', sourceNodeId: 'm' }];
      }
      definition.nodes.push(
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
        router('d', 'l', 's', ['go', 'again', 'inconclusive']),
        { id: 'k', type: 'join', label: 'k', policy: 'any' },
      );
      definition.controlEdges = [
        link('sl', 's', 'out', 'l', 'enter'),
        link('sb', 's', 'out', 'b', 'in'),
        link('ld', 'l', 'body', 'd', 'in'),
        link('dx', 'd', 'go', 'l', 'exit'),
        link('dr', 'd', 'again', 'l', 'repeat'),
        link('lk', 'l', 'next', 'k', 'in'),
        link('bk', 'b', 'out', 'k', 'in'),
        link('km', 'k', 'out', 'm', 'in'),
        link('mo', 'm', 'out', 'output', 'in'),
      ];
      const { log, callbacks } = recorder({ d: ['inconclusive'] });
      const { activate, loopLeft, joined } = callbacks;
      let closed = false;
      let joinedK = false;
      callbacks.activate = async (nodeId, iteration) => {
        if (nodeId === 'b') await until(() => closed);
        return activate(nodeId, iteration);
      };
      callbacks.loopLeft = async (loopId, no, outcome) => {
        await loopLeft(loopId, no, outcome);
        if (outcome !== 'inconclusive') return;
        closed = true;
        await until(() => joinedK);
      };
      callbacks.joined = async (...args) => {
        await joined(...args);
        joinedK = true;
      };
      const result = await makeRunner().run(planOf(definition), callbacks);
      expect(log).toContain('leave l#1 inconclusive');
      expect(log).toContain('join k stops d#1');
      expect(log.slice(-2)).toEqual(['activate m', 'finalize output']);
      expect(result).toEqual({ kind: 'finished', outputNodeId: 'output' });
    });

    it.each(['first', 'last'])(
      'starts no branch of a fan-out into a step and a repeat, the repeat %s',
      async (where) => {
        // Loop l [ a → router d (again: l.repeat, done: l.exit) ] → output; d's again also gets
        // the step a by hand.
        const definition = linearCorral(['a']);
        for (const node of definition.nodes) if (node.id === 'a') node.parentId = 'l';
        definition.entryNodeId = 'l';
        definition.nodes.push(
          { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
          router('d', 'l', 'a', ['again', 'done']),
        );
        definition.controlEdges = [
          link('la', 'l', 'body', 'a', 'in'),
          link('ad', 'a', 'out', 'd', 'in'),
          link('dr', 'd', 'again', 'l', 'repeat'),
          link('dx', 'd', 'done', 'l', 'exit'),
          link('lo', 'l', 'next', 'output', 'in'),
        ];
        const plan = planOf(definition);
        const d = plan.steps.d;
        if (d?.kind !== 'decision') throw new Error('d is not a decision');
        const step = { nodeId: 'a', port: 'in' as const };
        const repeat = d.branches.again ?? [];
        d.branches.again = where === 'first' ? [...repeat, step] : [step, ...repeat];
        const { log, callbacks } = recorder({ d: ['again'] });
        await expect(makeRunner().run(plan, callbacks)).rejects.toThrow('repeat of Loop l');
        expect(log.at(-1)).toBe('decide d#1 → again');
      },
    );

    it('fails the run when a branch is still in a round its Loop has replaced', async () => {
      // A plan the compiler refuses, built by hand: in Loop l, p fans out to a and b; a goes on
      // to the Decision whose revise repeats l while b has not joined.
      const definition = linearCorral(['p', 'a', 'b']);
      for (const node of definition.nodes) {
        if (node.type !== 'output') node.parentId = 'l';
        if (node.type === 'agent' && node.invocation !== 'observer' && node.id !== 'p')
          node.inputBindings = [{ kind: 'task_output', name: 'input', sourceNodeId: 'p' }];
      }
      definition.entryNodeId = 'l';
      definition.nodes.push(
        { id: 'l', type: 'loop', label: 'l', maxIterations: 3 },
        { id: 'j', type: 'join', label: 'j', parentId: 'l', policy: 'any' },
        router('d', 'l', 'p', ['done', 'again']),
      );
      definition.controlEdges = [
        link('lp', 'l', 'body', 'p', 'in'),
        link('pa', 'p', 'out', 'a', 'in'),
        link('pb', 'p', 'out', 'b', 'in'),
        link('aj', 'a', 'out', 'j', 'in'),
        link('bj', 'b', 'out', 'j', 'in'),
        link('jd', 'j', 'out', 'd', 'in'),
        link('dx', 'd', 'done', 'l', 'exit'),
        link('dr', 'd', 'again', 'l', 'repeat'),
        link('lo', 'l', 'next', 'output', 'in'),
      ];
      const plan = planOf(definition);
      const a = plan.steps.a;
      if (a?.kind !== 'agent') throw new Error('a is not an agent');
      a.next = [{ nodeId: 'd', port: 'in' }];
      const { log, callbacks } = recorder({ d: ['again'] });
      const { activate } = callbacks;
      callbacks.activate = async (nodeId, iteration) => {
        // b's first run settles once l has opened its second round; the second round's
        // branches never settle, so only the stale b can move.
        if (nodeId === 'b' && log.includes('enter l#2') === false) {
          const outcome = await activate(nodeId, iteration);
          await until(() => log.includes('enter l#2'));
          return outcome;
        }
        if (log.includes('enter l#2') && nodeId !== 'p') return new Promise(() => {});
        return activate(nodeId, iteration);
      };
      await expect(makeRunner().run(plan, callbacks)).rejects.toThrow(
        'Loop l opened another round',
      );
      expect(log).toContain('enter l#2');
      // Nothing of the stale branch reached the recorder after b: no Join, no Decision.
      expect(log.filter((line) => line.startsWith('join'))).toEqual([]);
      expect(log.filter((line) => line.startsWith('decide'))).toEqual(['decide d#1 → again']);
    });
  });
}
