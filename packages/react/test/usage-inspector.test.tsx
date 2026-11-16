import { emptyProjection, type RunProjection, usageTotals } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { UsageInspector } from '../src/components/UsageInspector.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { usageByAgent } from '../src/run/usage-by-agent.ts';
import { sessionStore } from '../src/stories/fixtures.tsx';

const call = (modelCallId: string, outputTokens: number | null, finished = true) =>
  ({
    modelCallId,
    executionId: 'exec_writer',
    finished,
    usage: outputTokens === null ? null : { outputTokens },
  }) as unknown as RunProjection['modelCalls'][string];

function show(projection: ReturnType<typeof emptyProjection>, headed = true) {
  render(
    <IntlProvider locale="en" messages={messages}>
      <UsageInspector
        session={sessionStore({ projection, definition: linearCorral(['writer']) })}
        headed={headed}
      />
    </IntlProvider>,
  );
}

describe('UsageInspector', () => {
  it('shows what was used and never a limit or allowance', () => {
    const p = emptyProjection('run_usage');
    p.executions.exec_writer = { nodeId: 'writer', status: 'running' } as never;
    p.executionOrder = ['exec_writer'];
    p.modelCalls.call_done = call('call_done', 42);
    p.modelCalls.call_live = call('call_live', null, false);
    show(p);
    expect(screen.getByText('Output tokens').nextSibling).toHaveTextContent('42');
    expect(screen.getByText('Model requests').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('In progress').nextSibling).toHaveTextContent('1');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(/budget|allowance|reserved|limit/i)).not.toBeInTheDocument();
  });

  it('inside the Usage tab, names its region without repeating the tab as a heading', () => {
    const p = emptyProjection('run_usage');
    p.modelCalls.call_done = call('call_done', 42);
    show(p, false);
    expect(screen.getByRole('region', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Usage' })).toBeNull();
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
  });

  it('names the role and request while keeping call IDs in collapsed diagnostics', () => {
    const p = emptyProjection('run_usage');
    p.executions.exec_writer = { nodeId: 'writer', status: 'succeeded' } as never;
    p.modelCalls.call_private = call('call_private', 7);
    show(p);
    const row = screen.getByTestId('usage-call-call_private');
    expect(row.querySelector('span')).toHaveTextContent('writer · Request 1');
    expect(row.querySelector('details')).not.toHaveAttribute('open');
    expect(row.querySelector('details')).toHaveTextContent('call_private');
  });

  it('counts unreported usage apart and never as zero', () => {
    const p = emptyProjection('run_usage');
    p.executions.exec_writer = { nodeId: 'writer', status: 'succeeded' } as never;
    p.modelCalls.call_unknown = call('call_unknown', null);
    p.usage.route_1 = {
      usageId: 'route_1',
      kind: 'auto_route',
      profileId: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
    };
    show(p);
    expect(screen.getByText('Usage not reported').nextSibling).toHaveTextContent('2');
    expect(screen.getByTestId('usage-call-call_unknown')).toHaveTextContent('Not reported');
    expect(screen.getByTestId('usage-record-route_1')).toHaveTextContent('Team choice');
    expect(screen.getByTestId('usage-record-route_1')).toHaveTextContent('Not reported');
  });

  it('shows image cost in microdollars and an unreported image cost as unknown', () => {
    const p = emptyProjection('run_image');
    p.usage.image_a = {
      usageId: 'image_a',
      kind: 'image',
      profileId: 'images',
      inputTokens: null,
      outputTokens: null,
      costMicros: 125001,
    };
    p.usage.image_b = {
      usageId: 'image_b',
      kind: 'image',
      profileId: 'images',
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
    };
    show(p);
    expect(screen.getByText('Image cost').nextElementSibling).toHaveTextContent('$0.125001');
    expect(screen.getByText('Images without a reported cost').nextElementSibling).toHaveTextContent(
      '1',
    );
    expect(screen.getByTestId('usage-record-image_a')).toHaveTextContent('Image generation 1');
    expect(screen.getByTestId('usage-record-image_b')).toHaveTextContent('Cost not reported');
  });

  it('leaves image rows absent for runs without images', () => {
    show(emptyProjection('run_text'));
    expect(screen.queryByText('Image cost')).not.toBeInTheDocument();
  });
});

// Run info › Usage reads a run's reported input as the Overview's usage detail does
// (chat-widgets-contract.md, features/execution-monitor.md): finished calls only, the cache share
// over calls that reported both, and an unreported figure never counted as zero.
describe('UsageInspector input and cached input', () => {
  const reported = (
    modelCallId: string,
    inputTokens: number | null,
    cachedInputTokens: number | null,
    finished = true,
  ) =>
    ({
      ...call(modelCallId, 10, finished),
      usage: { outputTokens: 10, inputTokens, cachedInputTokens },
    }) as RunProjection['modelCalls'][string];
  const showCalls = (...calls: RunProjection['modelCalls'][string][]) => {
    const p = emptyProjection('run_input');
    p.executions.exec_writer = { nodeId: 'writer', status: 'succeeded' } as never;
    for (const item of calls) p.modelCalls[item.modelCallId] = item;
    show(p);
  };
  const value = (label: string) => screen.getByText(label).nextElementSibling;

  it('sums the reported input of finished calls with its cached part and share', () => {
    // A call still going is left out: its usage is not final.
    showCalls(reported('a', 2_000, 1_500), reported('b', 1_000, 0), reported('c', 999, 999, false));
    expect(value('Reported input tokens')).toHaveTextContent('3,000');
    expect(value('Cached input')).toHaveTextContent('1,500 (50%)');
    expect(screen.queryByText(/did not report/)).not.toBeInTheDocument();
  });

  it('has no input total when no call reported input, and says how many did not', () => {
    showCalls(reported('a', null, null), reported('b', null, null));
    expect(screen.queryByText('Reported input tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached input')).not.toBeInTheDocument();
    expect(screen.getByText('2 completed calls did not report input tokens')).toBeInTheDocument();
  });

  it('counts calls that did not report input apart from the known total', () => {
    showCalls(reported('a', 2_000, 500), reported('b', null, null));
    expect(value('Reported input tokens')).toHaveTextContent('2,000');
    expect(value('Cached input')).toHaveTextContent('500 (25%)');
    expect(screen.getByText('1 completed call did not report input tokens')).toBeInTheDocument();
  });

  it('says cached input was not reported instead of zero when no call reported it', () => {
    showCalls(reported('a', 2_000, null), reported('b', 1_000, null));
    expect(value('Reported input tokens')).toHaveTextContent('3,000');
    expect(value('Cached input')).toHaveTextContent('Not reported');
    expect(value('Cached input')).not.toHaveTextContent('0');
  });

  it('takes the share over the calls that reported both and names the others', () => {
    showCalls(reported('a', 2_000, 500), reported('b', 1_000, null));
    expect(value('Reported input tokens')).toHaveTextContent('3,000');
    // 500 of the 2,000 input of the one call that reported both.
    expect(value('Cached input')).toHaveTextContent('500 (25%)');
    expect(screen.getByText('1 call did not report cached input')).toBeInTheDocument();
  });
});

// Run-level usage is read in one place, Run info › Usage, with a split by agent that adds up to
// the run's own totals (docs/specs/features/execution-monitor.md, run-stats.md: unreported usage is
// no information, never zero).
describe('usage by agent', () => {
  const twoAgents = () => {
    const p = emptyProjection('run_agents');
    p.executions.exec_writer = { nodeId: 'writer', status: 'succeeded' } as never;
    p.executions.exec_writer_2 = { nodeId: 'writer', status: 'running' } as never;
    p.executions.exec_reviewer = { nodeId: 'reviewer', status: 'succeeded' } as never;
    p.executionOrder = ['exec_writer', 'exec_reviewer', 'exec_writer_2'];
    p.modelCalls.w1 = call('w1', 42);
    p.modelCalls.w2 = { ...call('w2', 8), executionId: 'exec_writer_2' };
    p.modelCalls.w3 = { ...call('w3', null, false), executionId: 'exec_writer_2' };
    p.modelCalls.r1 = { ...call('r1', null), executionId: 'exec_reviewer' };
    // A call whose execution the record does not hold cannot be given to an agent.
    p.modelCalls.lost = { ...call('lost', null), executionId: 'exec_gone' };
    p.usage.route_1 = {
      usageId: 'route_1',
      kind: 'auto_route',
      profileId: null,
      inputTokens: null,
      outputTokens: 5,
      costMicros: null,
    };
    p.usage.image_a = {
      usageId: 'image_a',
      kind: 'image',
      profileId: 'images',
      inputTokens: null,
      outputTokens: null,
      costMicros: 900,
    };
    return p;
  };

  it('adds up to the run total by the same definition', () => {
    const p = twoAgents();
    const rows = usageByAgent(p);
    const total = usageTotals(p);
    const sum = (key: keyof typeof total) =>
      rows.reduce((value, row) => value + row.totals[key], 0);
    for (const key of Object.keys(total) as (keyof typeof total)[])
      expect({ key, value: sum(key) }).toEqual({ key, value: total[key] });
    expect(rows.map((row) => row.nodeId)).toEqual(['writer', 'reviewer', null]);
    expect(rows[0]?.totals.outputTokens).toBe(50);
    expect(rows[0]?.reported).toBe(true);
    expect(rows[1]?.reported).toBe(false);
  });

  it('lists each agent and what no agent owns, with no information instead of zero', () => {
    show({ ...twoAgents(), executions: { ...twoAgents().executions } });
    const table = screen.getByRole('table', { name: 'Usage by agent' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelector('th, td')?.textContent)).toEqual([
      'writer',
      'reviewer',
      'Outside agent executions',
    ]);
    expect(rows[0]).toHaveTextContent('50');
    expect(rows[1]).toHaveTextContent('No information');
    expect(rows[1]).not.toHaveTextContent(/\b0\b/);
    expect(rows[2]).toHaveTextContent('5');
  });
});
