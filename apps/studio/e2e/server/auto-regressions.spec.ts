import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import {
  closeRequestOptions,
  openRequestOptions,
  panelTab,
  requestBox,
  selectSessionTeam,
} from '../workbench.ts';
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
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
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
        await page.getByRole('link', { name: 'All projects', exact: true }).click();
        await expect(page).toHaveURL(/\/projects$/);
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
  await selectSessionTeam(page, 'Default chat');
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
  // A terminal Run can precede the submission acknowledgement that unlocks the composer.
  await expect(page.getByLabel('Attach text files', { exact: true })).toBeEnabled();
  await page.getByLabel('Attach text files', { exact: true }).setInputFiles({
    name: 'later.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Only for a later request'),
  });
  await expect(page.getByRole('button', { name: 'Remove later.txt', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'What this is', exact: true }).click();
  await page.getByRole('option', { name: /^Question/ }).click();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId('pre-run')).not.toContainText('Chosen per request');
  await expect(page.getByRole('button', { name: 'Model', exact: true })).not.toContainText(
    'Chosen per request',
  );
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Model', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Reasoning effort', exact: true })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Model', exact: true })).toBeHidden();
  await requestBox(page).fill('Explain this result');
  const sending = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/runs/explain'),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = (await sending).postDataJSON();
  expect(sent).not.toHaveProperty('attachments');
  expect(JSON.stringify(sent)).not.toContain('Only for a later request');
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(2);
  await expect(requestBox(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove later.txt', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove later.txt', exact: true })).toBeVisible();
});

test('[TC-ABS-006-H] [TC-ABS-006-N] a question about an earlier result starts beside a writer and cancels independently', async ({
  page,
  corral,
}) => {
  test.setTimeout(90000);
  const source = join(corral.workspace, 'source');
  execFileSync('git', ['init', '-q', source]);
  writeFileSync(join(source, 'README.md'), 'The original folder stays unchanged.\n');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd: source },
    );
  git('add', '.');
  git('commit', '-qm', 'initial');
  await corral.open('/');
  await page.getByRole('tab', { name: /^Project folder/ }).click();
  const folder = page.getByRole('tabpanel', { name: 'Project folder', exact: true });
  await folder.getByLabel('Folder path on this computer').fill(source);
  await folder.getByRole('button', { name: 'Link folder', exact: true }).click();
  const trust = folder.getByRole('switch', { name: /Trust this repository/ });
  await trust.click();
  await expect(trust).toBeChecked();
  // Reuse the authenticated browser session; its bootstrap token is single-use.
  await page.goto(`${corral.server.url}/`);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await panelTab(page, 'Changes');
  await page
    .getByRole('tabpanel', { name: 'Changes', exact: true })
    .getByRole('button', { name: /Make a working copy from/ })
    .click();
  await expect(page.getByRole('link', { name: 'Review changes', exact: true })).toBeVisible();

  corral.fake?.answerWith('Earlier result: the original folder is preserved.', {
    hostReply: '{"template":"single","reason":"A direct request."}',
  });
  await requestBox(page).fill('Create the earlier result for this session.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
  const seed = corral.server.coordinator.listRuns()[0]?.runId;
  await expect(page.getByText(/^Starts from .+ v\d+$/)).toBeVisible();

  let releaseWriter!: () => void;
  let releaseQuestion!: () => void;
  let writerEntered = false;
  let questionEntered = false;
  const heldWriter = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const heldQuestion = new Promise<void>((resolve) => {
    releaseQuestion = resolve;
  });
  corral.fake?.setResponses([
    fauxAssistantMessage('{"template":"single","reason":"A direct request."}'),
    async () => {
      writerEntered = true;
      await heldWriter;
      return fauxAssistantMessage('Writer stopped.');
    },
    async (context) => {
      questionEntered = true;
      expect(JSON.stringify(context.messages)).toContain(
        'Earlier result: the original folder is preserved.',
      );
      await heldQuestion;
      return fauxAssistantMessage('Question stopped.');
    },
  ]);
  try {
    await requestBox(page).fill('Keep writer A working in this copy.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => writerEntered).toBe(true);
    await expect(requestBox(page)).toHaveValue('');
    const writer = corral.server.coordinator.listRuns().find((run) => run.runId !== seed);
    if (!writer) throw new Error('Writer A did not start');
    expect(
      corral.server.coordinator.getRunSnapshot(writer.runId)?.definition.roles[0]?.allowedWorkTools,
    ).toContain('write_file');
    expect(writer.status).toBe('running');

    await openRequestOptions(page);
    await page.getByRole('switch', { name: 'Review only · no file changes', exact: true }).check();
    await closeRequestOptions(page);
    await page.getByRole('combobox', { name: 'What this is', exact: true }).click();
    const question = page.getByRole('option', { name: /^Question/ });
    await expect(question).toBeVisible({ timeout: 5000 });
    await question.click();
    await requestBox(page).fill('Question B: why was the original folder preserved?');
    const sending = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/runs/explain'),
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect((await sending).postDataJSON()).toMatchObject({ sessionId, startFrom: { runId: seed } });
    await expect.poll(() => questionEntered).toBe(true);
    const reader = corral.server.coordinator
      .listRuns()
      .find((run) => run.runId !== seed && run.runId !== writer.runId);
    if (!reader) throw new Error('Question B did not start');
    expect(reader.sessionId).toBe(writer.sessionId);
    expect(
      corral.server.coordinator.getRunSnapshot(reader.runId)?.definition.roles[0]?.allowedWorkTools,
    ).toEqual(['write_artifact']);
    await page.getByRole('combobox', { name: 'Selected run', exact: true }).click();
    await page.getByRole('option', { name: /Question B:/ }).click();
    await expect(page).toHaveURL(new RegExp(`run=${reader.runId}`));
    await page
      .getByRole('region', { name: 'Request', exact: true })
      .getByRole('button', { name: 'Cancel whole run', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Cancel whole run', exact: true })
      .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
      .click();
    await expect
      .poll(() => corral.server.coordinator.getSnapshot(reader.runId).projection.status)
      .toMatch(/cancelling|cancelled/);
    releaseQuestion();
    await expect
      .poll(() => corral.server.coordinator.getSnapshot(reader.runId).projection.status)
      .toBe('cancelled');
    // A cancelled in-flight provider request may retain an unknown external effect;
    // its attention notice takes precedence over the activity line.
    await expect(page.getByRole('combobox', { name: 'Selected run', exact: true })).toContainText(
      'Cancelled',
    );
    expect(corral.server.coordinator.getSnapshot(writer.runId).projection.status).toBe('running');
    expect(corral.server.coordinator.getSnapshot(seed ?? '').projection.status).toBe('succeeded');
    expect(readFileSync(join(source, 'README.md'), 'utf8')).toBe(
      'The original folder stays unchanged.\n',
    );
    expect(corral.errors).toEqual([]);
  } finally {
    releaseQuestion();
    releaseWriter();
  }
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
    expect(corral.fake?.seen.hostRequests).toHaveLength(1);
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });
}

test.describe('quality presets', () => {
  test.use({ live: false, codexLogin: false, reasoningApi: false });
  test('[TC-ULTRA-003-H] the selected model pool survives settings and runs synthesis before cross-model review', async ({
    page,
    corral,
  }) => {
    const sessionId = await autoSession(page, corral);
    await write(page, `/sessions/${sessionId}`, 'PATCH', {
      expectedRevision: 1,
      auto: { modelProfile: 'model-a', reasoning: { mode: 'fixed', level: 'low' } },
    });
    await page.reload();
    const url = page.url();
    await requestBox(page).fill('/ultra');
    await requestBox(page).press('Enter');
    await openRequestOptions(page);
    await expect(page.getByRole('combobox', { name: 'Quality preset', exact: true })).toContainText(
      'Ultra',
    );
    await closeRequestOptions(page);
    await requestBox(page).fill('Hello from the fixed quality fixture');
    await openRequestOptions(page);
    await page.getByRole('combobox', { name: 'Quality preset', exact: true }).click();
    await page.getByRole('option', { name: 'Ultra · plan, work and review', exact: true }).click();
    const verifier = page.getByRole('checkbox', { name: /model-b/ });
    await verifier.uncheck();
    await closeRequestOptions(page);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await openRequestOptions(page);
    await verifier.check();
    await closeRequestOptions(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/settings=general/);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page).toHaveURL(url);
    await expect(requestBox(page)).toHaveValue('Hello from the fixed quality fixture');
    await openRequestOptions(page);
    await expect(page.getByRole('combobox', { name: 'Quality preset', exact: true })).toContainText(
      'Ultra',
    );
    await closeRequestOptions(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
    const runId = corral.server.coordinator.listRuns()[0]!.runId;
    const snapshot = corral.server.coordinator.getRunSnapshot(runId)!;
    expect(snapshot.mode).toBe('mock');
    expect(snapshot.autoRoute?.qualityPreset).toBe('ultra');
    // CR-048: Studio sends version 2; without a working copy it runs as collaboration.
    expect(snapshot.autoRoute?.ultra).toMatchObject({
      version: 2,
      modelProfiles: ['model-a', 'model-b'],
      verifierProfile: 'model-b',
      mode: 'collaboration',
      fallbackReason: 'no_working_copy',
    });
    expect(snapshot.definition.roles.find((role) => role.id === 'reviewer')?.modelProfile).toBe(
      'model-b',
    );
    expect(snapshot.definition.roles.find((role) => role.id === 'synthesizer')?.modelProfile).toBe(
      'model-a',
    );
    expect(
      snapshot.definition.roles.every(
        (role) => role.reasoning?.mode === 'fixed' && role.reasoning.level === 'max',
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        async (id) =>
          (await fetch(`/api/v1/sessions/${id}`).then((response) => response.json())).auto,
        sessionId,
      ),
    ).toEqual({ modelProfile: 'model-a', reasoning: { mode: 'fixed', level: 'low' } });
    await page.reload();
    await expect(page.getByTestId('entry-auto')).toContainText('Ultra');
    expect(corral.server.coordinator.listRuns()).toHaveLength(1);
  });
});
