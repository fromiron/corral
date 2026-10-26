import { fauxAssistantMessage } from '@corral/server/testing';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { requestBox, selectSessionTeam } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// session chat starts the conversation lead with no auto choice request, so the
// chooser's routing, its cancellation while choosing, question mode and Ultra are gone. What
// remains is the start command's lost-response and cancellation reconciliation.

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
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

test.use({ live: true, codexLogin: true, reasoningApi: true });

test('a deleted selected team is unavailable, never silently auto', async ({ page, corral }) => {
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
  await selectSessionTeam(page, 'No team');
  await expect(page.getByTestId('selected-team-missing')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

for (const stop of ['cancel', 'navigate'] as const) {
  test(`${stop} after commit reconciles and cancels the run even when its response is delayed`, async ({
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
      else await page.getByRole('link', { name: 'All projects', exact: true }).click();
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

for (const outcome of ['failed', 'succeeded'] as const) {
  test(`an unknown cancellation keeps the command after a ${outcome} run and session remount`, async ({
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
      async () => {
        await heldWorker;
        // the lead's reply is its answer; an empty reply publishes nothing and fails.
        return fauxAssistantMessage(outcome === 'failed' ? '' : 'Completed result.');
      },
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
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
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
    // Session chat sends no auto choice request.
    expect(corral.fake?.seen.hostRequests).toHaveLength(0);
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });

  test(`an unknown queued cancellation keeps its command after a ${outcome} run and session remount`, async ({
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
      async () => {
        await heldWorker;
        // the lead's reply is its answer; an empty reply publishes nothing and fails.
        return fauxAssistantMessage(outcome === 'failed' ? '' : 'Completed result.');
      },
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
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
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
    // Session chat sends no auto choice request.
    expect(corral.fake?.seen.hostRequests).toHaveLength(0);
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });
}
