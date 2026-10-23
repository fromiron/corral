import type { RunEvent } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '@corral/core';
import {
  collaborationCorral,
  FakeClock,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { BudgetInspector } from '../src/components/BudgetInspector.tsx';
import { EventText, RunReason } from '../src/components/RunText.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { decisionRunStatus } from '../src/run/selectors.ts';
import { projectionWith, researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';

// Readable run views (roadmap UX-A4): sentences instead of event names and reason codes.

const intl = (node: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </IntlProvider>,
  );

async function collaborationEvents() {
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    }),
  );
  const definition = collaborationCorral();
  const { runId } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error('no run');
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
  const projection = await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const labelOf = (executionId: string | undefined) => {
    const nodeId = executionId ? projection.executions[executionId]?.nodeId : undefined;
    return definition.nodes.find((n) => n.id === nodeId)?.label ?? nodeId ?? '';
  };
  return { events, labelOf, definition };
}

describe('event sentences (UX-A4)', () => {
  it('[TC-OBS-001-H] describes what happened in words, naming the node, not the event type', async () => {
    const { events, labelOf, definition } = await collaborationEvents();
    const text = (type: RunEvent['type']) => {
      const event = events.find((e) => e.type === type);
      if (!event) throw new Error(`no ${type}`);
      const view = intl(
        <EventText
          event={event}
          labelOf={labelOf}
          nodeLabel={(id) => definition.nodes.find((n) => n.id === id)?.label ?? id}
        />,
      );
      const out = view.container.textContent ?? '';
      view.unmount();
      return out;
    };
    expect(text('run.started')).toBe('Run started (simulated agents)');
    expect(text('execution.created')).toBe('Research started');
    expect(text('message.question_created')).toBe('Writer asked Source Responder');
    expect(text('artifact.version_created')).toMatch(/^Research Helper wrote notes-part v1$/);
    expect(text('output.finalized')).toBe('Final output ready');
    expect(text('tool.requested')).toMatch(/^Research called spawn_subagents$/);
  });

  it('[TC-OBS-001-N] an event without a sentence still shows its type, never an empty row', async () => {
    const event = {
      type: 'future.event',
      runSeq: 1,
      payload: {},
    } as unknown as RunEvent;
    const view = intl(<EventText event={event} labelOf={() => ''} nodeLabel={(id) => id} />);
    expect(view.container.textContent).toBe('future.event');
  });
});

describe('run status reasons (UX-A4)', () => {
  const reason = (code: string) => {
    const view = intl(
      <RunReason code={code} nodeLabel={(id) => (id === 'write' ? 'Writer' : id)} />,
    );
    const out = view.container.textContent;
    view.unmount();
    return out;
  };

  it('[TC-OBS-001-H] turns reason codes into sentences, with node labels', () => {
    expect(reason('validation_passed')).toBe('The Corral passed validation');
    expect(reason('output_finalized')).toBe('The final output was produced');
    expect(reason('approval_requested: user_action')).toBe('Waiting for your decision');
    expect(reason('execution_failed: write')).toBe('Writer failed');
    expect(reason('final_output_rejected')).toBe('You rejected the final output');
  });

  it('[TC-OBS-001-N] an unknown code is shown as it is', () => {
    expect(reason('something_new: x')).toBe('something_new: x');
  });
});

describe('budget meter (UX-A4)', () => {
  it('[TC-OBS-004-H] shows output tokens and model calls as meters, with the full table folded away', () => {
    const { definition } = researchTeamDraft();
    const session = sessionStore({
      runId: 'r',
      definition,
      projection: projectionWith({
        limits: definition.limits,
        budget: { ...projectionWith({}).budget, spent: 16_000, modelCalls: 10 },
      }),
    });
    intl(<BudgetInspector session={session} />);
    const tokens = screen.getByRole('meter', { name: 'Output tokens' }) as HTMLMeterElement;
    expect(tokens.value).toBe(16000);
    expect(tokens.max).toBe(definition.limits.maxOutputTokens);
    expect((screen.getByRole('meter', { name: 'Model calls' }) as HTMLMeterElement).value).toBe(10);
    expect(screen.getByRole('button', { name: 'All budget figures' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('[TC-OBS-004-H] shows the estimated cost at list prices, or says a subscription covers it (roadmap 15)', () => {
    const { definition } = researchTeamDraft();
    const call = (profile: string) => ({
      modelCallId: `c_${profile}`,
      executionId: 'e',
      contextSnapshotId: 'x',
      profile,
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: [],
      finished: true,
      usage: null,
      rawUsage: { input: 1_000_000, output: 250_000, cacheRead: 0, cacheWrite: 0 },
      certainty: 'reported' as const,
    });
    const render = (auth: 'api_key' | 'oauth') => {
      const session = sessionStore({
        runId: 'r',
        definition,
        projection: projectionWith({
          limits: definition.limits,
          modelProfiles: {
            'model-a': { profile: 'model-a', provider: 'openai', modelId: 'gpt-a', auth },
          },
          modelCalls: { c: call('model-a') },
        }),
      });
      const view = intl(
        <BudgetInspector
          session={session}
          prices={() => ({ input: 2, output: 8, cacheRead: 0, cacheWrite: 0 })}
        />,
      );
      const text = screen.getByTestId('cost-estimate').textContent;
      view.unmount();
      return text;
    };
    expect(render('api_key')).toContain('$4.00');
    expect(render('oauth')).toContain('Included in your subscription');
  });
});

describe('decision and output node status (UX-A4)', () => {
  const team = researchTeamDraft().definition;
  const node = (id: string) => {
    const found = team.nodes.find((n) => n.id === id);
    if (!found) throw new Error(id);
    return found;
  };
  const iteration = (no: number, outcome: RunProjection['iterations'][string]['outcome']) => ({
    iterationId: `iter_${no}`,
    loopNodeId: 'review_loop',
    no,
    criteriaVersionId: 'c',
    outcome,
  });

  it('[TC-OBS-001-H] a review decision counts the rounds it decided; approval and output wait for the person', () => {
    const p = projectionWith({
      iterations: { iter_1: iteration(1, 'revise'), iter_2: iteration(2, 'pass') },
      loopIterations: { review_loop: ['iter_1', 'iter_2'] },
      approvals: {
        a1: {
          approvalId: 'a1',
          kind: 'user_action',
          subjectVersionIds: ['v'],
          criteriaVersionId: 'c',
          status: 'approved',
        },
        a2: {
          approvalId: 'a2',
          kind: 'final_output',
          subjectVersionIds: ['v'],
          criteriaVersionId: 'c',
          status: 'pending',
        },
      },
    });
    expect(decisionRunStatus(p, node('review_decision'))).toEqual({ status: 'done', count: 2 });
    expect(decisionRunStatus(p, node('approval'))).toEqual({ status: 'done', count: 1 });
    expect(decisionRunStatus(p, node('output'))).toEqual({ status: 'waiting', count: 0 });
  });

  it('[TC-OBS-001-N] nothing decided yet is idle, a rejection is failed, and a round in progress is not done', () => {
    const p = projectionWith({
      iterations: { iter_1: iteration(1, null) },
      loopIterations: { review_loop: ['iter_1'] },
      approvals: {
        a1: {
          approvalId: 'a1',
          kind: 'user_action',
          subjectVersionIds: ['v'],
          criteriaVersionId: 'c',
          status: 'rejected',
        },
      },
    });
    expect(decisionRunStatus(p, node('review_decision'))).toEqual({ status: 'idle', count: 0 });
    expect(decisionRunStatus(p, node('approval'))).toEqual({ status: 'failed', count: 1 });
    expect(decisionRunStatus(projectionWith({}), node('output'))).toEqual({
      status: 'idle',
      count: 0,
    });
  });
});
