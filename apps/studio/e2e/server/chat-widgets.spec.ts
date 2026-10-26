import type { RunEvent } from '@corral/contracts';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// Deterministic provider responses exercise the production adapter, Coordinator,
// persisted plan bodies, subscriptions and Studio. No events or projections are injected.
test.use({ live: true, codexLogin: true, reasoningApi: true });

const titles = [
  'Read the existing conversation layout',
  'Choose a compact layout',
  'Update the chat widgets',
  'Check the composer controls',
  'Review the narrow layout',
  'Verify the result',
  'Record the outcome',
];

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

function current(corral: Harness) {
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('The UI has not started a run');
  return { runId: run.runId, ...corral.server.coordinator.getSnapshot(run.runId) };
}

function updatePlan(corral: Harness, completed: number, expectedRevision = completed) {
  return fauxAssistantMessage(
    [
      fauxToolCall('update_plan', {
        scope: 'execution',
        expectedRevision,
        criteriaVersionId: current(corral).projection.currentCriteriaVersionId,
        items: titles.map((title, index) => ({
          id: `step_${index + 1}`,
          title,
          status: index < completed ? 'completed' : index === completed ? 'in_progress' : 'pending',
        })),
      }),
    ],
    { stopReason: 'toolUse' },
  );
}

async function session(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

async function send(page: Page, text: string) {
  await requestBox(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('live plans, context, manual collapse and an answer use the primary session flow', async ({
  page,
  corral,
}) => {
  const next = gate();
  const later = gate();
  const ask = gate();
  const subscriptions: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/\/runs\/[^/]+\/events$/.test(url.pathname)) subscriptions.push(url.pathname);
  });
  corral.fake?.setResponses([
    () => updatePlan(corral, 0),
    async () => {
      await next.waiting;
      return updatePlan(corral, 1);
    },
    async () => {
      await later.waiting;
      return updatePlan(corral, 2);
    },
    async () => {
      await ask.waiting;
      return fauxAssistantMessage(
        [
          fauxToolCall('ask_user', {
            key: 'layout',
            questions: [{ id: 'layout', kind: 'text', prompt: 'Which layout should I keep?' }],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('The compact layout');
      return fauxAssistantMessage('The compact chat layout is ready for review.');
    },
  ]);

  try {
    await session(page, corral);
    await expect(
      page.getByTestId('chat-composer').getByRole('button', { name: 'Model', exact: true }),
    ).toContainText('From next request');
    await send(page, 'Review and update the chat layout in several steps.');
    const plan = page.getByTestId('composer-work-plan');
    const toggle = plan.getByRole('button', { name: /Work plan/ });
    await expect(toggle).toContainText('0/7 done');
    const pills = page.getByTestId('composer-status-pills');
    await expect(pills).toBeVisible();
    await expect(pills.getByRole('link').first()).toHaveAttribute(
      'href',
      new RegExp(`run=${current(corral).runId}`),
    );
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(plan.getByRole('listitem')).toHaveCount(5);
    await expect(page.getByTestId('compact-run')).toHaveCount(0);

    const widgets = page.getByTestId('session-summary-card');
    await expect(widgets).toBeVisible();
    expect(await widgets.evaluate((node) => !!node.closest('[data-testid="chat-timeline"]'))).toBe(
      false,
    );
    expect(await plan.evaluate((node) => !!node.closest('[data-testid="chat-timeline"]'))).toBe(
      false,
    );
    const context = page.getByTestId('context-usage-chip');
    await expect(context).toBeVisible();
    await context.click();
    const inspector = page.getByTestId('context-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('System prompt');
    await expect(inspector).toContainText('Built-in tools');
    await expect(inspector).toContainText('Messages');
    await page.keyboard.press('Escape');
    await expect(inspector).toBeHidden();
    await expect(context).toBeFocused();
    expect(
      subscriptions.filter((path) => path.includes(`/runs/${current(corral).runId}/events`)),
    ).toHaveLength(1);

    await plan.getByRole('button', { name: 'Show all 7', exact: true }).click();
    await expect(plan.getByRole('listitem')).toHaveCount(7);

    const input = requestBox(page);
    await input.fill('다음 요청 日本語');
    const originalInput = await input.elementHandle();
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(3, 3);
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    next.release();
    await expect(toggle).toContainText('1/7 done');
    expect(await originalInput?.evaluate((element) => element.isConnected)).toBe(true);
    await expect(input).toHaveValue('다음 요청 日本語');
    expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(3);
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      keyCode: 229,
      bubbles: true,
    });
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
    expect(current(corral).projection.status).toBe('running');
    await input.dispatchEvent('compositionend', { data: '語', bubbles: true });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(plan.getByRole('listitem')).toHaveCount(0);
    later.release();
    await expect(toggle).toContainText('2/7 done');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    ask.release();
    const question = page.getByRole('form', { name: 'Waiting for your answer' });
    await expect(page.getByTestId('action-required')).toBeVisible();
    // Faux responses do not serialize a provider request or invoke onPayload.
    // Their assembled context must not be promoted to a complete measurement.
    await expect(context).not.toContainText(/Context about \d+%/);
    await page
      .getByTestId('action-required')
      .getByText('Go to the request', { exact: true })
      .click();
    await expect(question).toBeVisible();
    await expect(question).toHaveCount(1);
    await question.getByRole('textbox', { name: 'Your answer' }).fill('The compact layout');
    await question.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByTestId('chat-result')).toContainText('ready for review');
    await expect.poll(() => current(corral).projection.status).toBe('succeeded');
    await expect(toggle).toContainText('2/7 done');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('action-required')).toHaveCount(0);
    await expect(input).toHaveValue('다음 요청 日本語');

    // Authoritative readback preserves the actual unfinished items after run success.
    const snapshot = current(corral);
    const ref = Object.values(snapshot.projection.workPlans ?? {})[0];
    expect(ref?.revision).toBe(3);
    if (!ref) throw new Error('The Coordinator must retain the plan reference');
    const body = JSON.parse(
      corral.server.coordinator.getArtifactText(snapshot.runId, ref.bodyRef) ?? 'null',
    );
    expect(
      body.items.filter((item: { status: string }) => item.status === 'completed'),
    ).toHaveLength(2);
    expect(body.items[2].status).toBe('in_progress');
    await toggle.click();
    await expect(plan.getByRole('listitem')).toHaveCount(7);
    expect(corral.errors).toEqual([]);
  } finally {
    next.release();
    later.release();
    ask.release();
  }
});

test.describe('serialized provider context', () => {
  test.use({ compatibleEndpoint: true, codexLogin: false, reasoningApi: false });

  test('the real provider payload reaches the context percentage and composition through a local endpoint', async ({
    page,
    corral,
  }) => {
    let request = 0;
    if (!corral.endpoint) throw new Error('The local compatible endpoint is required');
    corral.endpoint.setReply(() => {
      request += 1;
      // no auto choice request; the lead plans, asks, then replies.
      if (request === 1)
        return {
          toolCall: {
            name: 'update_plan',
            args: {
              scope: 'execution',
              expectedRevision: 0,
              criteriaVersionId: current(corral).projection.currentCriteriaVersionId,
              items: [
                { id: 'answer', title: 'Check the request and answer', status: 'in_progress' },
              ],
            },
          },
        };
      if (request === 2)
        return {
          toolCall: {
            name: 'ask_user',
            args: {
              key: 'context-check',
              questions: [{ id: 'confirm', kind: 'text', prompt: 'Keep the measured context?' }],
            },
          },
        };
      return 'The request used the recorded provider payload.';
    });
    await session(page, corral);
    await send(page, 'Read this text, make a short plan, and ask before answering.');
    await expect(page.getByTestId('action-required')).toBeVisible();

    // Read back the persisted public event through the Coordinator's existing stream.
    const events: RunEvent[] = [];
    const stop = corral.server.coordinator.subscribe(current(corral).runId, 0, (event) =>
      events.push(event),
    );
    await expect
      .poll(() => events.filter((event) => event.type === 'model.payload_recorded').length)
      .toBe(2);
    stop();
    const payload = events.filter((event) => event.type === 'model.payload_recorded').at(-1);
    if (payload?.type !== 'model.payload_recorded')
      throw new Error('The provider must publish its final serialized payload measurement');
    const usage = payload.payload.contextUsage;
    expect(usage).toMatchObject({ coverage: 'request', completeness: 'complete' });
    expect(usage?.parts.find((part) => part.category === 'system_tools')?.tokens).toBeGreaterThan(
      0,
    );
    expect(usage?.usedTokens).toBe(usage?.parts.reduce((total, part) => total + part.tokens, 0));
    const context = page.getByTestId('context-usage-chip');
    await expect(context).toContainText(
      `Context about ${Math.round(((usage?.usedTokens ?? 0) / 8000) * 100)}%`,
    );
    await context.click();
    const inspector = page.getByTestId('context-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('/ 8,000 tokens');
    for (const [category, label] of [
      ['messages', 'Messages'],
      ['system_prompt', 'System prompt'],
      ['system_tools', 'Built-in tools'],
    ]) {
      const tokens = usage?.parts.find((part) => part.category === category)?.tokens;
      expect(tokens).toBeGreaterThan(0);
      await expect(inspector.getByRole('listitem').filter({ hasText: label })).toContainText(
        Number(tokens).toLocaleString('en-US'),
      );
    }
    await page.keyboard.press('Escape');
    await page.getByTestId('action-required').getByRole('link').click();
    const question = page.getByRole('form', { name: 'Waiting for your answer' });
    await question.getByRole('textbox', { name: 'Your answer' }).fill('Keep it.');
    await question.getByRole('button', { name: 'Send answer' }).click();
    await expect(page.getByTestId('chat-result')).toContainText('recorded provider payload');
    await expect.poll(() => current(corral).projection.status).toBe('succeeded');
    expect(corral.endpoint.models.every((model) => model === 'llama3.2')).toBe(true);
    expect(corral.errors).toEqual([]);
  });
});

test('opening an earlier result preserves the draft and keeps the active Run separate', async ({
  page,
  corral,
}) => {
  await session(page, corral);
  corral.fake?.answerWith('Earlier result.');
  await send(page, 'Write the earlier result.');
  await expect(page.getByTestId('chat-result')).toContainText('Earlier result.');
  await expect.poll(() => current(corral).projection.status).toBe('succeeded');
  const earlierRunId = current(corral).runId;
  const next = gate();
  corral.fake?.setResponses([
    () => updatePlan(corral, 0),
    async () => {
      await next.waiting;
      return fauxAssistantMessage('The next version is available.');
    },
  ]);
  try {
    await send(page, 'Update the layout and retain the earlier result.');
    const plan = page.getByTestId('composer-work-plan');
    const toggle = plan.getByRole('button', { name: /Work plan/ });
    await expect(toggle).toContainText('0/7 done');
    const activeRunId = current(corral).runId;
    expect(activeRunId).not.toBe(earlierRunId);
    await requestBox(page).fill('Do not replace this draft.');

    await page
      .getByTestId('chat-timeline')
      .getByRole('link', { name: 'Open in Results', exact: true })
      .first()
      .click();
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(earlierRunId);
    await expect(page.getByTestId('result-body')).toContainText('Earlier result.');
    await expect(toggle).toHaveCount(0);
    await expect(requestBox(page)).toHaveValue('Do not replace this draft.');
    expect(current(corral).runId).toBe(activeRunId);

    next.release();
    await expect.poll(() => current(corral).projection.status).toBe('succeeded');
    await expect(toggle).toHaveCount(0);
    await expect(page.getByTestId('result-body')).toContainText('Earlier result.');
    await expect(requestBox(page)).toHaveValue('Do not replace this draft.');
    expect(corral.errors).toEqual([]);
  } finally {
    next.release();
  }
});

test('a finished checklist does not finish its run, and only automatic disclosure collapses on success', async ({
  page,
  corral,
}) => {
  const completePlan = gate();
  const completeRun = gate();
  corral.fake?.setResponses([
    () => updatePlan(corral, 0),
    async () => {
      await completePlan.waiting;
      return updatePlan(corral, 7, 1);
    },
    async () => {
      await completeRun.waiting;
      return fauxAssistantMessage('The completed checklist has a final result.');
    },
  ]);
  try {
    await session(page, corral);
    await send(page, 'Complete the checklist and then submit its result.');
    const plan = page.getByTestId('composer-work-plan');
    const toggle = plan.getByRole('button', { name: /Work plan/ });
    await expect(toggle).toContainText('0/7 done');
    completePlan.release();
    await expect(toggle).toContainText('7/7');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toContainText('run still going');
    expect(current(corral).projection.status).toBe('running');
    completeRun.release();
    await expect.poll(() => current(corral).projection.status).toBe('succeeded');
    await expect(page.getByTestId('chat-result')).toContainText('final result');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('7/7 done');
    await expect(plan.getByRole('listitem')).toHaveCount(0);
    expect(corral.errors).toEqual([]);
  } finally {
    completePlan.release();
    completeRun.release();
  }
});
