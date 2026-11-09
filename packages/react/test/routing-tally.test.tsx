import type { ReasoningResolution, RouteRecord } from '@corral/contracts';
import { emptyProjection, type ModelCallView } from '@corral/core';
import { render } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { RoutingTally } from '../src/components/RoutingTally.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

const HASH = 'b'.repeat(64);
const route = (overrides: Partial<RouteRecord>): RouteRecord => ({
  routeId: 'route_x',
  engine: 'local',
  application: 'active',
  settingsRevision: HASH,
  candidates: ['low', 'medium', 'high', 'xhigh'],
  recommended: null,
  probabilities: null,
  probabilityMeaning: null,
  engineIdentity: null,
  questionVersion: 'effort-v1',
  questionHash: HASH,
  serializerVersion: 'd1-systemone-v1',
  frame: null,
  timing: { deadlineMs: 5000, packMs: null, countMs: null, engineMs: null, callerWaitMs: null },
  device: null,
  usage: { inputTokens: null, billableUnits: null },
  ...overrides,
});
const call = (id: string, reasoning: ReasoningResolution): ModelCallView => ({
  modelCallId: id,
  executionId: 'exe_1',
  contextSnapshotId: 'ctx_1',
  profile: 'model-b',
  configRevision: 1,
  directiveIds: [],
  inputArtifactVersionIds: [],
  finished: true,
  usage: null,
  rawUsage: null,
  certainty: null,
  responseRef: null,
  reasoning,
});
const resolution = (
  source: ReasoningResolution['source'],
  resolved: ReasoningResolution['resolved'],
  routeRecord?: RouteRecord,
): ReasoningResolution => ({
  preparationId: 'prep_x',
  requested: { mode: 'auto' },
  resolved,
  source,
  ...(routeRecord ? { route: routeRecord } : {}),
});

it('counts the run’s judged requests and its fallbacks by reason', () => {
  const projection = emptyProjection('run_1');
  const timeout = { reason: 'timeout', target: { kind: 'provider-default' } } as const;
  projection.modelCalls = {
    a: call('a', resolution('router', 'low', route({ routeId: 'r_a', recommended: 'low' }))),
    b: call('b', resolution('fallback', null, route({ routeId: 'r_b', fallback: timeout }))),
    // A retry reusing b's result is not another judgment.
    c: call('c', resolution('reused', null, route({ routeId: 'r_b', fallback: timeout }))),
    d: call(
      'd',
      resolution(
        'fallback',
        null,
        route({
          routeId: 'r_d',
          fallback: { reason: 'busy', target: { kind: 'provider-default' } },
        }),
      ),
    ),
    e: call('e', resolution('fallback', null, route({ routeId: 'r_e', fallback: timeout }))),
    off: call('off', resolution('off', null)),
  };
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RoutingTally projection={projection} />
    </IntlProvider>,
  );
  const text = container.textContent ?? '';
  expect(text).toContain('4 requests judged');
  expect(text).toContain('1 recommendation applied');
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'Timed out: 2',
    'Busy: 1',
  ]);
});

it('shows nothing for a run that judged no request', () => {
  const projection = emptyProjection('run_2');
  projection.modelCalls = { off: call('off', resolution('off', null)) };
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RoutingTally projection={projection} />
    </IntlProvider>,
  );
  expect(container.textContent).toBe('');
});
