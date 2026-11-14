import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTree } from '../src/components/RunView.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { selectRunFlowIterations } from '../src/run/flow.ts';
import { loopFlowFixture } from '../src/stories/loopFlowFixture.ts';

describe('a Loop whose limit policy applied', () => {
  /** Cap 2; the policy applied as round 2 ended, so round 3 runs on the raised settings. */
  const raised = (escalation: Record<string, unknown>) => {
    const data = loopFlowFixture(3);
    data.definition.nodes = data.definition.nodes.map((node) =>
      node.type === 'loop' ? { ...node, maxIterations: 2 } : node,
    );
    const round3 = data.projection.iterations.round_3;
    if (round3) round3.outcome = null;
    data.projection.loopEscalations = {
      review_loop: [
        {
          loopNodeId: 'review_loop',
          iterationId: 'round_2',
          reason: 'cap_reached',
          nodeIds: ['writer'],
          runSeq: 40,
          ...escalation,
        } as never,
      ],
    };
    data.projection.modelProfiles = {
      'model-u': { profile: 'model-u', provider: 'openai', modelId: 'gpt-upper', auth: 'mock' },
    } as never;
    data.session.setState({ definition: data.definition, projection: data.projection });
    return data;
  };
  const views = (data: ReturnType<typeof raised>) =>
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTree session={data.session} onSteer={vi.fn()} selectedExecutionId={null} />
      </IntlProvider>,
    );

  it('counts the rounds before the policy into the cap and says what it raised', () => {
    views(raised({ policy: 'raise_reasoning', levels: { writer: 'high' } }));
    const group = screen.getByTestId('loop-group-review_loop');
    expect(group).toHaveTextContent('3 observed rounds · max 4');
    expect(within(group).getByTestId('run-loop-escalation')).toHaveTextContent(
      'Reasoning raised to High',
    );
  });

  it('names the model it switched to, not its profile id', () => {
    views(raised({ policy: 'upper_model', modelProfile: 'model-u' }));
    expect(screen.getByTestId('run-loop-escalation')).toHaveTextContent('Switched to gpt-upper');
  });

  it('counts a new entry afresh, without the earlier entry’s policy', () => {
    const data = raised({ policy: 'raise_reasoning', levels: { writer: 'high' } });
    const { projection } = data;
    const round3 = projection.iterations.round_3;
    if (round3) round3.outcome = 'pass';
    projection.iterations.again_1 = {
      iterationId: 'again_1',
      loopNodeId: 'review_loop',
      no: 1,
      criteriaVersionId: 'criteria',
      parentIterationId: null,
      outcome: null,
    };
    projection.loopIterations.review_loop?.push('again_1');
    data.session.setState({ projection: { ...projection } });
    views(data);
    expect(screen.getByTestId('loop-group-review_loop')).toHaveTextContent(
      '1 observed rounds · max 2',
    );
    expect(screen.queryByTestId('run-loop-escalation')).toBeNull();
  });
});

describe('a Loop entered again', () => {
  /** Entries of the given sizes, as an inner Loop gets one per outer round; the last runs. */
  const entries = (sizes: number[], maxIterations: number | null = 3) => {
    const data = loopFlowFixture(0);
    data.definition.nodes = data.definition.nodes.map((node) => {
      if (node.type !== 'loop') return node;
      const { maxIterations: _cap, ...rest } = node;
      return maxIterations === null
        ? { ...rest, limitPolicy: { kind: 'unlimited' as const } }
        : { ...rest, maxIterations };
    });
    const { projection } = data;
    projection.status = 'running';
    projection.output = null;
    sizes.forEach((size, entry) => {
      for (let no = 1; no <= size; no++) {
        const iterationId = `entry_${entry + 1}_round_${no}`;
        const last = entry === sizes.length - 1 && no === size;
        projection.loopIterations.review_loop?.push(iterationId);
        projection.iterations[iterationId] = {
          iterationId,
          loopNodeId: 'review_loop',
          no,
          criteriaVersionId: 'criteria',
          parentIterationId: `outer_${entry + 1}`,
          outcome: last ? null : no === size ? 'pass' : 'revise',
        };
      }
    });
    data.session.setState({ definition: data.definition, projection });
    return data;
  };
  const views = (data: ReturnType<typeof entries>) =>
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTree session={data.session} onSteer={vi.fn()} selectedExecutionId={null} />
      </IntlProvider>,
    );

  it.each([
    ['second', [3, 2], '2 observed rounds · max 3', 'Current: round 2'],
    ['third', [3, 2, 1], '1 observed rounds · max 3', 'Current: round 1'],
  ])('counts its %s entry alone, against that entry’s cap', (_entry, sizes, summary, current) => {
    const data = entries(sizes);
    views(data);
    const group = screen.getByTestId('loop-group-review_loop');
    expect(group).toHaveTextContent(summary);
    expect(group).toHaveTextContent(current);
    const [loop] = selectRunFlowIterations(data.projection, data.definition);
    expect(loop?.latestIterationId).toBe(`entry_${sizes.length}_round_${sizes.at(-1)}`);
    expect(loop?.status).toBe('active');
    // Earlier entries stay in the round picker.
    expect(loop?.iterations).toHaveLength(sizes.reduce((a, b) => a + b, 0));
  });

  it('gives a Loop without a cap no max', () => {
    const data = entries([2], null);
    views(data);
    const [loop] = selectRunFlowIterations(data.projection, data.definition);
    expect(loop?.maxIterations).toBeNull();
    expect(screen.getByTestId('loop-group-review_loop')).not.toHaveTextContent('max');
  });

  it('names the highest level it raised several Agents to', () => {
    const data = entries([3]);
    data.projection.loopEscalations = {
      review_loop: [
        {
          loopNodeId: 'review_loop',
          iterationId: 'entry_1_round_2',
          reason: 'cap_reached',
          nodeIds: ['writer', 'editor', 'checker'],
          runSeq: 40,
          policy: 'raise_reasoning',
          levels: { writer: 'medium', editor: 'xhigh', checker: 'high' },
        } as never,
      ],
    };
    data.session.setState({ projection: { ...data.projection } });
    views(data);
    expect(screen.getByTestId('run-loop-escalation')).toHaveTextContent(
      'Reasoning raised to Extra high',
    );
  });
});
