import type { RunProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { EffortJudgments } from '../src/components/EffortJudgments.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

const settings = (mode: 'off' | 'observe'): RunProjection['decisionSettings'] => ({
  reasoning_effort: {
    mode,
    maxCalls: 40,
    providers: [
      {
        id: 'local-model',
        version: 'effort-judge-v6',
        privacy: 'local',
        available: true,
        reason: null,
      },
      {
        id: 'local-heuristic',
        version: '1',
        privacy: 'local',
        available: false,
        reason: 'not installed',
      },
    ],
  },
});

function view(change: Partial<RunProjection>) {
  const definition = linearCorral(['writer']);
  const session = sessionStore({
    runId: 'run_1',
    definition,
    projection: projectionWith(change),
  });
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <EffortJudgments session={session} />
    </IntlProvider>,
  );
}

const decision = (
  id: string,
  change: Partial<RunProjection['decisions'][string]>,
): RunProjection['decisions'][string] => ({
  decisionId: id,
  provider: 'local-model@effort-judge-v6',
  privacy: 'local',
  executionId: 'exec_1',
  modelCallId: 'call_1',
  status: 'observed',
  answer: 'high',
  probabilities: { low: 0.05, medium: 0.15, high: 0.7, xhigh: 0.1 },
  evidenceLevel: 'model_probability',
  reason: null,
  latencyMs: 21,
  readyBeforeDispatch: true,
  afterRequestFinished: false,
  ...change,
});

describe('EffortJudgments', () => {
  it('lists each request with every provider answer and says nothing was applied', () => {
    view({
      decisionSettings: settings('observe'),
      executions: {
        exec_1: {
          executionId: 'exec_1',
          nodeId: 'writer',
          taskId: 't',
          attemptNo: 1,
          parentExecutionId: null,
          previousExecutionId: null,
          depth: 0,
          iterationId: null,
          modelProfile: 'model-a',
          configRevision: 0,
          criteriaVersionId: null,
          status: 'succeeded',
          activity: null,
          waitingOn: null,
          modelCallIds: ['call_1'],
          error: null,
        },
      },
      executionOrder: ['exec_1'],
      decisions: {
        dec_1: decision('dec_1', {}),
        dec_2: decision('dec_2', {
          provider: 'local-heuristic@1',
          answer: 'medium',
          probabilities: null,
          evidenceLevel: 'rule',
          latencyMs: 0,
        }),
      },
    });
    const region = screen.getByRole('region', { name: 'Effort judgments' });
    expect(region.textContent).toContain('Observe only. Not applied to any request.');
    const row = within(region).getByTestId('judgment-call_1');
    expect(row.textContent).toContain('writer');
    expect(row.textContent).toContain('local-model@effort-judge-v6');
    expect(row.textContent).toContain('High');
    expect(row.textContent).toContain('70%');
    expect(row.textContent).toContain('local-heuristic@1');
    expect(row.textContent).toContain('Medium');
    expect(row.textContent).toContain('rule');
    // A provider that could not run says why.
    expect(region.textContent).toContain('local-heuristic: not installed');
  });

  it('failures read as plainly as answers, and nothing is ever shown as applied', () => {
    view({
      decisionSettings: settings('observe'),
      decisions: {
        dec_1: decision('dec_1', {
          status: 'failed',
          answer: null,
          probabilities: null,
          reason: 'timeout',
        }),
        dec_2: decision('dec_2', {
          modelCallId: 'call_2',
          afterRequestFinished: true,
          readyBeforeDispatch: false,
        }),
      },
    });
    const region = screen.getByRole('region', { name: 'Effort judgments' });
    expect(within(region).getByTestId('judgment-call_1').textContent).toContain(
      'Failed: timed out',
    );
    expect(within(region).getByTestId('judgment-call_2').textContent).toContain(
      'Arrived after the request finished',
    );
    expect(region.textContent?.toLowerCase()).not.toMatch(/\bapplied:/);
  });

  it('a judgment the run ended before reads as not collected, not as pending (#22)', () => {
    view({
      status: 'succeeded',
      decisionSettings: settings('observe'),
      decisions: {
        dec_1: decision('dec_1', {
          status: 'not_collected',
          answer: null,
          probabilities: null,
          evidenceLevel: null,
          latencyMs: null,
        }),
      },
    });
    const row = screen.getByTestId('judgment-call_1');
    expect(row.textContent).toContain('Not collected: the run ended first');
    expect(row.textContent).not.toContain('Waiting');
  });

  it('says so when judgments are off, and shows nothing for a runtime without them', () => {
    const off = view({ decisionSettings: settings('off') });
    expect(screen.getByRole('region', { name: 'Effort judgments' }).textContent).toContain(
      'Effort judgments are off for this run.',
    );
    off.unmount();
    view({ decisionSettings: null });
    expect(screen.queryByRole('region', { name: 'Effort judgments' })).toBeNull();
  });
});
