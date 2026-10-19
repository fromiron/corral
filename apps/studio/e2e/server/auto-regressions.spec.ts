import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

async function write(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { csrfToken } = await fetch('/api/v1/session').then((r) => r.json());
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-corral-csrf': csrfToken,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    { path, method, body },
  );
}

async function autoSession(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

async function routeReasoning(page: Page, sessionId: string) {
  await write(page, `/sessions/${sessionId}`, 'PATCH', {
    expectedRevision: 1,
    auto: { modelProfile: 'model-a', reasoning: { mode: 'route' } },
  });
  await page.reload();
}

test.use({ live: true, codexLogin: true, reasoningApi: true });

for (const stop of ['cancel', 'navigate'] as const) {
  test(`[TC-AUTO-003-N] ${stop} while choosing starts no run and keeps the draft`, async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    let entered!: () => void, release!: () => void;
    const choosing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    corral.fake?.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        entered();
        await held;
        return fauxAssistantMessage('{"template":"single","reason":"Short question"}');
      },
    ]);
    await requestBox(page).fill('Keep this request after cancelling the choice');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await choosing;
    try {
      if (stop === 'cancel') {
        await page.getByRole('button', { name: 'Cancel team selection', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page).toHaveURL(/\/settings/);
      }
      await expect.poll(() => signal?.aborted).toBe(true);
    } finally {
      release();
    }
    await page.waitForTimeout(100);
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
    if (stop === 'navigate') await page.goto(`${corral.server.url}/sessions/${sessionId}`);
    await expect(requestBox(page)).toHaveValue('Keep this request after cancelling the choice');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(page.getByText('The answer was lost', { exact: false })).toHaveCount(0);
  });
}

test('[TC-AUTO-001-N] a deleted selected team is unavailable, never silently auto', async ({
  page,
  corral,
}) => {
  const sessionId = await autoSession(page, corral);
  const saved = await write(page, '/corrals', 'POST', {
    definition: linearCorral(['required_reviewer']),
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  });
  await write(page, `/sessions/${sessionId}`, 'PATCH', {
    expectedRevision: 1,
    corralId: saved.record.corralId,
  });
  await write(page, `/corrals/${saved.record.corralId}`, 'DELETE');
  await page.reload();
  await requestBox(page).fill('My selected team must review this');
  await expect(page.getByTestId('selected-team-missing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await requestBox(page).press('Enter');
  expect(corral.fake?.seen.hostRequests).toHaveLength(0);
  expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  await page.getByRole('combobox', { name: 'Team', exact: true }).click();
  await page.getByRole('option', { name: 'Auto', exact: true }).click();
  await expect(page.getByTestId('selected-team-missing')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

for (const queued of [false, true]) {
  test(`[TC-AUTO-005-H] ${queued ? 'queued' : 'direct'} requests show and persist their routing metadata`, async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    await routeReasoning(page, sessionId);
    const text = queued ? 'Queued request' : 'Direct request';
    corral.fake?.answerWith('Recorded answer', {
      // Missing reasoning retains the template and records a medium fallback.
      hostReply: '{"template":"single","reason":"A short request needs one agent"}',
    });
    if (queued) {
      await write(page, `/sessions/${sessionId}/entries`, 'POST', {
        intent: 'queue',
        text,
        state: 'queued',
      });
      await page.reload();
      await page.getByRole('button', { name: 'Start now', exact: true }).click();
    } else {
      await requestBox(page).fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    }
    const metadata = page.getByTestId('chat-timeline');
    await expect(metadata).toContainText('Auto · one agent');
    await expect(metadata).toContainText('A short request needs one agent');
    await expect(metadata).toContainText('model-a');
    await expect(metadata).toContainText('Medium');
    await expect(metadata).toContainText('fallback');
    await page.reload();
    await expect(page.getByTestId('entry-auto')).toContainText('A short request needs one agent');
    await expect(page.getByTestId('entry-auto')).toContainText('fallback');
  });
}

test('[TC-AUTO-005-N] questions hide the auto reasoning setting they cannot apply', async ({
  page,
  corral,
}) => {
  const sessionId = await autoSession(page, corral);
  await routeReasoning(page, sessionId);
  corral.fake?.answerWith('A result to ask about', {
    hostReply: '{"template":"single","reason":"Short request","reasoning":"low"}',
  });
  await requestBox(page).fill('Make one result');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  await page.getByRole('combobox', { name: 'What this is', exact: true }).click();
  await page.getByRole('option', { name: /^Question/ }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId('pre-run')).not.toContainText('Chosen per request');
});

for (const stop of ['cancel', 'navigate'] as const) {
  test(`[TC-AUTO-003-N] ${stop} after commit reconciles and cancels the run even when its response is delayed`, async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    let releaseResponse!: () => void, committed!: () => void, releaseWorker!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const heldWorker = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    corral.fake?.setResponses([
      fauxAssistantMessage('{"template":"single","reason":"Short question"}'),
      async () => {
        await heldWorker;
        return fauxAssistantMessage('Stopped');
      },
    ]);
    await page.route('**/api/v1/runs/auto', async (route) => {
      const response = await route.fetch();
      committed();
      await heldResponse;
      await route.fulfill({ response }).catch(() => undefined);
    });
    const text = 'Keep this draft until cancellation is reconciled';
    await requestBox(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await started;
    const runId = corral.server.coordinator.listRuns()[0]?.runId;
    expect(runId).toBeTruthy();
    try {
      if (stop === 'cancel')
        await page.getByRole('button', { name: 'Cancel team selection', exact: true }).click();
      else await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect
        .poll(() =>
          ['cancelling', 'cancelled'].includes(
            corral.server.coordinator.listRuns()[0]?.status ?? '',
          ),
        )
        .toBe(true);
      releaseWorker();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
    } finally {
      releaseWorker();
      releaseResponse();
    }
    await expect
      .poll(async () =>
        page.evaluate(async (sessionId) => {
          const session = await fetch(`/api/v1/sessions/${sessionId}`).then((r) => r.json());
          return session.entries[0]?.runId;
        }, sessionId),
      )
      .toBe(runId);
    if (stop === 'navigate') await page.goto(`${corral.server.url}/sessions/${sessionId}`);
    await expect(requestBox(page)).toHaveValue(text);
    await expect(page.getByTestId('chat-timeline')).toContainText('Cancelled');
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });
}

test('[TC-AUTO-002-N] output-capped routing shows a translated fallback reason', async ({
  page,
  corral,
}) => {
  await autoSession(page, corral);
  corral.fake?.answerWith('Fallback answer', {
    hostReply: '{"template":"single","reason":"Short question"}'.padEnd(257, ' '),
  });
  await requestBox(page).fill('A bounded routing choice');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('entry-auto')).toContainText('Choice output limit reached');
  await expect(page.getByTestId('entry-auto')).toContainText('choice failed');
  await expect(page.getByTestId('entry-auto')).not.toContainText('Sessions.autoFallbackReason');
});

for (const outcome of ['failed', 'succeeded'] as const) {
  test(`[TC-AUTO-003-N] an unknown cancellation keeps the command after a ${outcome} run and session remount`, async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    const starts: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/runs/auto'))
        starts.push(request.postDataJSON());
    });
    let releaseResponse!: () => void, committed!: () => void, releaseWorker!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const heldWorker = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    corral.fake?.setResponses([
      fauxAssistantMessage('{"template":"single","reason":"Short question"}'),
      async () => {
        await heldWorker;
        return outcome === 'failed'
          ? fauxAssistantMessage('Stopped without a result')
          : fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Completed result.' })], {
              stopReason: 'toolUse',
            });
      },
      (context) =>
        fauxAssistantMessage(
          [
            fauxToolCall('submit_result', {
              artifactVersionIds: [
                JSON.stringify(context.messages)
                  .match(/artv_[a-f0-9]{32}/g)
                  ?.at(-1) ?? 'missing_artifact',
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
    ]);
    await page.route(
      '**/api/v1/runs/auto',
      async (route) => {
        const response = await route.fetch();
        committed();
        await heldResponse;
        await route.fulfill({ response }).catch(() => undefined);
      },
      { times: 1 },
    );
    await page.route('**/api/v1/runs/auto/*/cancel', (route) => route.abort('failed'), {
      times: 1,
    });
    const text = 'Retry this exact request only after reconciling its first command';
    await requestBox(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await started;
    const runId = corral.server.coordinator.listRuns()[0]?.runId;
    try {
      await page.getByRole('button', { name: 'Cancel team selection', exact: true }).click();
      await expect(page.getByTestId('refusal')).toHaveAttribute('data-kind', 'network');
      await expect(page.getByTestId('refusal')).toContainText('Failed to fetch');
    } finally {
      releaseWorker();
      releaseResponse();
    }
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe(outcome);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
    await expect(requestBox(page)).toHaveValue(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1]).toEqual(starts[0]);
    await expect
      .poll(async () =>
        page.evaluate(async (sessionId) => {
          const session = await fetch(`/api/v1/sessions/${sessionId}`).then((r) => r.json());
          return session.entries[0]?.runId;
        }, sessionId),
      )
      .toBe(runId);
    expect(corral.fake?.seen.hostRequests).toHaveLength(1);
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });

  test(`[TC-AUTO-003-N] an unknown queued cancellation keeps its command after a ${outcome} run and session remount`, async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    const starts: unknown[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/runs/auto'))
        starts.push(request.postDataJSON());
    });
    const text = 'Retry this queued request only after reconciling its first command';
    await write(page, `/sessions/${sessionId}/entries`, 'POST', {
      intent: 'queue',
      text,
      state: 'queued',
    });
    await page.reload();
    let releaseResponse!: () => void, committed!: () => void, releaseWorker!: () => void;
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const started = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const heldWorker = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    corral.fake?.setResponses([
      fauxAssistantMessage('{"template":"single","reason":"Short question"}'),
      async () => {
        await heldWorker;
        return outcome === 'failed'
          ? fauxAssistantMessage('Stopped without a result')
          : fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Completed result.' })], {
              stopReason: 'toolUse',
            });
      },
      (context) =>
        fauxAssistantMessage(
          [
            fauxToolCall('submit_result', {
              artifactVersionIds: [
                JSON.stringify(context.messages)
                  .match(/artv_[a-f0-9]{32}/g)
                  ?.at(-1) ?? 'missing_artifact',
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
    ]);
    await page.route(
      '**/api/v1/runs/auto',
      async (route) => {
        const response = await route.fetch();
        committed();
        await heldResponse;
        await route.fulfill({ response }).catch(() => undefined);
      },
      { times: 1 },
    );
    await page.route('**/api/v1/runs/auto/*/cancel', (route) => route.abort('failed'), {
      times: 1,
    });
    await page.getByRole('button', { name: 'Start now', exact: true }).click();
    await started;
    const runId = corral.server.coordinator.listRuns()[0]?.runId;
    try {
      await page.getByRole('button', { name: 'Cancel team selection', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible();
    } finally {
      releaseWorker();
      releaseResponse();
    }
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe(outcome);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
    await page.getByRole('button', { name: 'Start now', exact: true }).click();
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1]).toEqual(starts[0]);
    await expect
      .poll(async () =>
        page.evaluate(async (sessionId) => {
          const session = await fetch(`/api/v1/sessions/${sessionId}`).then((r) => r.json());
          return session.entries[0]?.runId;
        }, sessionId),
      )
      .toBe(runId);
    expect(corral.fake?.seen.hostRequests).toHaveLength(1);
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });
}
