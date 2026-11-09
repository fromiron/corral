// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { emptyProjection } from '@corral/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { TurnProcess } from './TurnProcess.tsx';

it.each(['en', 'ko'] as const)(
  'names the exact read result version while keeping unknown targets and failure states (%s)',
  (locale) => {
    const projection = emptyProjection('run_process');
    projection.status = 'failed';
    projection.executionOrder = ['lead'];
    projection.executions.lead = {
      executionId: 'lead',
      nodeId: 'lead',
      status: 'failed',
    } as (typeof projection.executions)[string];
    projection.artifacts.artv_report = {
      artifactVersionId: 'artv_report',
      artifactId: 'report',
      version: 2,
      parentVersionId: null,
      name: 'Security report',
      contract: 'text',
      contentHash: 'a'.repeat(64),
      byteLength: 12,
      authorExecutionId: 'lead',
      modelCallId: null,
      contextSnapshotId: null,
      submitted: true,
      configRevision: 1,
      criteriaVersionId: null,
      inputArtifactVersionIds: [],
    };
    const events = ['artv_report', 'artv_missing'].flatMap((id) => [
      {
        type: 'tool.requested',
        actor: { kind: 'agent', id: 'lead' },
        payload: {
          executionId: 'lead',
          toolCallId: id,
          name: 'read_artifact',
          validatedArgs: { artifactVersionId: id },
        },
      },
      {
        type: 'tool.finished',
        actor: { kind: 'agent', id: 'lead' },
        payload: { executionId: 'lead', toolCallId: id, error: 'The read failed.' },
      },
    ]) as unknown as RunEvent[];
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={locale === 'en' ? en : ko}>
        <TurnProcess
          events={events}
          projection={projection}
          streams={{}}
          label={(id) => id}
          open
          onOpenChange={() => {}}
        />
      </IntlProvider>,
    );
    // The row names the tool and describes its exact target; arguments stay in its details.
    const text = container.textContent ?? '';
    expect(text).toContain(locale === 'en' ? 'Read' : '읽기');
    expect(text).toContain(
      locale === 'en' ? 'Security report · v2 · failed' : 'Security report · 버전 2 · 실패',
    );
    expect(text).not.toContain(locale === 'en' ? 'artv_report · failed' : 'artv_report · 실패');
    expect(text).toContain(locale === 'en' ? 'artv_missing · failed' : 'artv_missing · 실패');
  },
);

it('shows a judged request on its row and keeps other reasoning in the request details', () => {
  const projection = emptyProjection('run_reasoning');
  projection.status = 'succeeded';
  projection.executionOrder = ['lead'];
  projection.executions.lead = {
    executionId: 'lead',
    nodeId: 'lead',
    status: 'succeeded',
    modelCallIds: ['c1', 'c2'],
  } as unknown as (typeof projection.executions)[string];
  projection.modelCalls = {
    c1: { modelCallId: 'c1', executionId: 'lead', finished: true },
    c2: { modelCallId: 'c2', executionId: 'lead', finished: true },
  } as unknown as typeof projection.modelCalls;
  const HASH = 'a'.repeat(64);
  const prepared = (modelCallId: string, reasoning: Record<string, unknown>, runSeq: number) => ({
    type: 'model.request_prepared',
    runSeq,
    actor: { kind: 'agent', id: 'lead' },
    payload: {
      executionId: 'lead',
      modelCallId,
      directiveIds: [],
      inputArtifactVersionIds: [],
      profile: 'model-a',
      reasoning,
    },
  });
  const events = [
    prepared(
      'c1',
      {
        preparationId: 'prep_1',
        requested: { mode: 'auto' },
        resolved: 'low',
        source: 'router',
        route: {
          routeId: 'route_1',
          engine: 'local',
          application: 'active',
          settingsRevision: HASH,
          candidates: ['low', 'medium', 'high'],
          recommended: 'low',
          probabilities: null,
          probabilityMeaning: null,
          engineIdentity: null,
          questionVersion: 'effort-v1',
          questionHash: HASH,
          serializerVersion: 'd1-systemone-v1',
          frame: null,
          timing: { deadlineMs: 5000, packMs: 3, countMs: 12, engineMs: 405, callerWaitMs: 420 },
          device: { requested: 'cpu', actual: 'cpu', host: null, threads: 4 },
          usage: null,
        },
      },
      1,
    ),
    prepared(
      'c2',
      { preparationId: 'prep_2', requested: { mode: 'auto' }, resolved: null, source: 'off' },
      2,
    ),
  ] as unknown as RunEvent[];
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <IntlProvider locale="en" messages={en}>
      <TurnProcess
        events={events}
        projection={projection}
        streams={{}}
        label={(id) => id}
        open
        onOpenChange={() => {}}
      />
    </IntlProvider>,
  );
  const [judged, off] = container.querySelectorAll('[data-testid="reasoning-summary"]');
  expect(judged?.textContent).toBe('Local · CPU · Recommended low → applied low · 420ms');
  // The judged line opens its own detail, so it is not folded away.
  expect(judged?.closest('[hidden]')).toBeNull();
  expect(off?.textContent).toBe('Off · Not judged');
  expect(off?.closest('[hidden]')).not.toBeNull();
  expect(judged?.closest('.turn-process-row')?.textContent).not.toContain('Request details');
  expect(off?.closest('.turn-process-row')?.textContent).toContain('Request details');
});
