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
      locale === 'en' ? 'Security report · v2 · Failed' : 'Security report · 버전 2 · 실패',
    );
    expect(text).not.toContain(locale === 'en' ? 'artv_report · Failed' : 'artv_report · 실패');
    expect(text).toContain(locale === 'en' ? 'artv_missing · Failed' : 'artv_missing · 실패');
  },
);

it.each(['en', 'ko'] as const)(
  'a call that passed on an approval for the run says so on its line, with no approval id (%s)',
  (locale) => {
    const projection = emptyProjection('run_granted');
    projection.status = 'succeeded';
    projection.executionOrder = ['lead'];
    projection.executions.lead = {
      executionId: 'lead',
      nodeId: 'lead',
      status: 'succeeded',
    } as (typeof projection.executions)[string];
    const actor = { kind: 'agent', id: 'lead' };
    const lifecycle = (toolCallId: string, granted: boolean) => [
      {
        type: 'tool.requested',
        actor,
        payload: {
          executionId: 'lead',
          toolCallId,
          name: 'run_command',
          validatedArgs: { command: 'npm test' },
        },
      },
      { type: 'tool.allowed', actor, payload: { executionId: 'lead', toolCallId } },
      ...(granted
        ? [
            {
              type: 'tool.authorized',
              actor,
              payload: {
                executionId: 'lead',
                toolCallId,
                approvalId: 'appr_0001',
                fingerprint: 'f'.repeat(64),
              },
            },
          ]
        : []),
      {
        type: 'tool.finished',
        actor,
        payload: { executionId: 'lead', toolCallId, resultRef: null, error: null },
      },
    ];
    const events = [
      ...lifecycle('call_first', false),
      ...lifecycle('call_again', true),
    ] as unknown as RunEvent[];
    const messages = locale === 'en' ? en : ko;
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={messages}>
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
    const rows = [...container.querySelectorAll('.turn-process-row')].map(
      (row) => row.textContent ?? '',
    );
    const done = messages.Transcript.tool.finished;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`npm test · ${done}`);
    expect(rows[0]).not.toContain(messages.Turn.allowedForRun);
    expect(rows[1]).toContain(`npm test · ${done} · ${messages.Turn.allowedForRun}`);
    expect(container.textContent).not.toContain('appr_0001');
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
  // The judged row has no details to open; the other row is itself the way to its details.
  const details = 'button[aria-label^="Details of"]';
  expect(judged?.closest('.turn-process-row')?.querySelector(details)).toBeNull();
  const opener = off?.closest('.turn-process-row')?.querySelector(details);
  expect(opener?.getAttribute('aria-expanded')).toBe('false');
  expect(opener?.getAttribute('aria-label')).toBe('Details of Model request 2 · Response complete');
  expect(container.textContent).not.toContain('Request details');
});

it('shows each request’s applied level and wire check without opening the row', () => {
  const projection = emptyProjection('run_level');
  projection.status = 'succeeded';
  projection.executionOrder = ['lead'];
  projection.executions.lead = {
    executionId: 'lead',
    nodeId: 'lead',
    status: 'succeeded',
    modelCallIds: ['fixed', 'plain', 'missing'],
  } as unknown as (typeof projection.executions)[string];
  projection.modelCalls = {
    fixed: {
      modelCallId: 'fixed',
      executionId: 'lead',
      finished: true,
      reasoningWire: { kind: 'effort', value: 'high' },
    },
    plain: {
      modelCallId: 'plain',
      executionId: 'lead',
      finished: true,
      reasoningWire: { kind: 'omitted', value: null },
    },
    missing: { modelCallId: 'missing', executionId: 'lead', finished: true },
  } as unknown as typeof projection.modelCalls;
  const prepared = (modelCallId: string, runSeq: number, reasoning?: Record<string, unknown>) => ({
    type: 'model.request_prepared',
    runSeq,
    actor: { kind: 'agent', id: 'lead' },
    payload: {
      executionId: 'lead',
      modelCallId,
      directiveIds: [],
      inputArtifactVersionIds: [],
      profile: 'model-a',
      ...(reasoning ? { reasoning } : {}),
    },
  });
  const events = [
    prepared('fixed', 1, {
      preparationId: 'prep_fixed',
      requested: { mode: 'fixed', level: 'high' },
      resolved: 'high',
      source: 'fixed',
    }),
    prepared('plain', 2, {
      preparationId: 'prep_plain',
      requested: { mode: 'auto' },
      resolved: null,
      source: 'off',
    }),
    prepared('missing', 3),
  ] as unknown as RunEvent[];
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <IntlProvider locale="ko" messages={ko}>
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
  const labels = [...container.querySelectorAll('[data-testid="reasoning-level"]')];
  expect(labels.map((label) => label.textContent)).toEqual([
    '높음 · 확인됨: high',
    '공급자 기본값 · 확인됨',
    '추론 설정 미기록',
  ]);
  for (const label of labels) expect(label.closest('[hidden]')).toBeNull();
  expect(labels[2]?.textContent).not.toContain('공급자 기본값');
  // The row already says the record is missing; the details do not say it again.
  expect(container.textContent?.split('추론 설정 미기록')).toHaveLength(2);
  // The longer record stays folded. An empty verified send is not called omitted.
  const summaries = [...container.querySelectorAll('[data-testid="reasoning-summary"]')];
  expect(summaries.map((summary) => summary.textContent)).toEqual([
    '추론 노력: high → high · 수동 · 요청 확인: high',
    '끄기 · 판정 안 함',
  ]);
  for (const summary of summaries) expect(summary.closest('[hidden]')).not.toBeNull();
  expect(container.textContent).not.toContain('생략');
});

it('opens a step’s details from its row, by pointer or keyboard, with no details label', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const projection = emptyProjection('run_rows');
  projection.status = 'succeeded';
  projection.executionOrder = ['lead'];
  projection.executions.lead = {
    executionId: 'lead',
    nodeId: 'lead',
    status: 'succeeded',
  } as (typeof projection.executions)[string];
  const events = [
    {
      type: 'tool.requested',
      actor: { kind: 'agent', id: 'lead' },
      payload: {
        executionId: 'lead',
        toolCallId: 'read',
        name: 'read_file',
        validatedArgs: { path: 'README.md' },
      },
    },
    {
      type: 'tool.finished',
      actor: { kind: 'agent', id: 'lead' },
      payload: { executionId: 'lead', toolCallId: 'read' },
    },
  ] as unknown as RunEvent[];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
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
    ),
  );
  const row = container.querySelector('.turn-process-row');
  expect(row?.textContent).not.toContain('Tool details');
  const opener = row?.querySelector<HTMLButtonElement>('button[aria-expanded]');
  expect(opener?.getAttribute('aria-label')).toBe('Details of Read · README.md · Done');
  // The chevron says it opens; the panel it controls is closed and out of the tab order.
  expect(opener?.querySelector('svg')).not.toBeNull();
  const panel = container.querySelector(
    `#${CSS.escape(opener?.getAttribute('aria-controls') ?? '')}`,
  );
  expect(panel?.hasAttribute('inert') || panel?.hasAttribute('hidden')).toBe(true);
  await act(async () => opener?.click());
  expect(opener?.getAttribute('aria-expanded')).toBe('true');
  expect(panel?.hasAttribute('inert')).toBe(false);
  expect(panel?.textContent).toContain('read_file');
  // A native button: Enter and Space toggle it from the keyboard.
  expect(opener?.tagName).toBe('BUTTON');
  expect(opener?.getAttribute('type')).toBe('button');
  await act(async () => root.unmount());
  container.remove();
});

it.each(['en', 'ko'] as const)(
  'a pending ask leaves the wait to the composer notice: the header shows time, the row no state (%s)',
  (locale) => {
    const projection = emptyProjection('run_ask');
    projection.status = 'awaiting_user';
    projection.startedAt = '2026-11-10T00:00:00.000Z';
    projection.executionOrder = ['lead'];
    projection.executions.lead = {
      executionId: 'lead',
      nodeId: 'lead',
      status: 'waiting_approval',
      attemptNo: 1,
    } as (typeof projection.executions)[string];
    const tool = (toolCallId: string, name: string) => ({
      type: 'tool.requested',
      actor: { kind: 'agent', id: 'lead' },
      payload: { executionId: 'lead', toolCallId, name, validatedArgs: {} },
    });
    const events = [
      tool('plan', 'update_plan'),
      {
        type: 'tool.finished',
        actor: { kind: 'agent', id: 'lead' },
        payload: { executionId: 'lead', toolCallId: 'plan' },
      },
      tool('ask', 'ask_user'),
      {
        type: 'tool.allowed',
        actor: { kind: 'runtime', id: 'runtime' },
        payload: { executionId: 'lead', toolCallId: 'ask' },
      },
      {
        type: 'user_input.requested',
        recordedAt: '2026-11-10T00:00:05.000Z',
        actor: { kind: 'runtime', id: 'runtime' },
        payload: {
          requestId: 'question',
          executionId: 'lead',
          attemptNo: 1,
          bodyRef: 'body_question',
          schemaHash: 'b'.repeat(64),
          deadline: '2026-11-10T00:01:00.000Z',
        },
      },
    ] as unknown as RunEvent[];
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
    // What each row shows: its label and its line, not the folded details.
    const rows = [...container.querySelectorAll('.turn-process-row')].map(
      (row) =>
        `${row.querySelector('span')?.textContent ?? ''} ${row.querySelector('button[aria-expanded]')?.textContent ?? ''}`,
    );
    const messages = locale === 'en' ? en : ko;
    const ask = rows.find((row) => row.includes(messages.Turn.tool.ask_user));
    const plan = rows.find((row) => row.includes(messages.Turn.tool.update_plan));
    // The pill and the notice above the composer say the run waits; the turn does not.
    expect(ask).not.toContain(messages.Presence.state.awaiting_user);
    expect(ask).not.toContain(locale === 'en' ? 'Waiting for your answer' : '답을 기다리는 중');
    expect(ask).not.toContain(messages.Transcript.tool.allowed);
    // Nor does it open the question: its text shows only in that notice.
    const askRow = [...container.querySelectorAll('.turn-process-row')].find((row) =>
      row.querySelector('span')?.textContent?.includes(messages.Turn.tool.ask_user),
    );
    expect(askRow?.querySelector('button[aria-expanded]')).toBeNull();
    expect(plan).toContain(locale === 'en' ? 'Done' : '완료');
    // Like any other state, the head's time is the time the turn worked, to its last record.
    const header = container.querySelector('[data-testid="turn-process-header"]')?.textContent;
    expect(header).not.toContain(messages.Presence.state.awaiting_user);
    expect(header).toBe(locale === 'en' ? '5s' : '5초');
  },
);
