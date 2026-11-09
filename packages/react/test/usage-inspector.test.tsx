import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { UsageInspector } from '../src/components/UsageInspector.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

const call = (modelCallId: string, outputTokens: number | null, finished = true) =>
  ({
    modelCallId,
    executionId: 'exec_writer',
    finished,
    usage: outputTokens === null ? null : { outputTokens },
  }) as never;

function show(projection: ReturnType<typeof emptyProjection>) {
  render(
    <IntlProvider locale="en" messages={messages}>
      <UsageInspector
        session={sessionStore({ projection, definition: linearCorral(['writer']) })}
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
