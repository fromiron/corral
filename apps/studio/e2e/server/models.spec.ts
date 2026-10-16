import { FAKE_CODEX_ACCESS, FAKE_REDIRECT_OK } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

test.use({ live: true });

async function agentToOutput(page: Page) {
  await page.getByRole('button', { name: 'New Corral' }).click();
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await page
    .locator('.react-flow__node[data-id="agent_1"] .react-flow__handle[data-handleid="out"]')
    .dragTo(
      page.locator('.react-flow__node[data-id="output_1"] .react-flow__handle[data-handleid="in"]'),
    );
  await expect(page.getByText('Ready to run.')).toBeVisible();
}

test('[TC-SEC-002-H] signing in from Settings shows status and expiry, never the token', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('link', { name: 'Models' }).click();
  const openai = page.getByTestId('provider-openai');
  await expect(openai.getByTestId('auth-status')).toContainText('Not signed in');
  await expect(page.getByTestId('profile-model-a')).toContainText('Sign-in needed');

  await openai.getByRole('button', { name: 'Sign in' }).click();
  const link = openai.getByRole('link', { name: 'Open the sign-in page' });
  await expect(link).toHaveAttribute('href', 'https://auth.example.test/authorize?state=s1');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // The person signs in on the provider's page; here the redirect address is pasted instead.
  await openai.getByLabel(/paste it here/).fill(FAKE_REDIRECT_OK);
  await openai.getByRole('button', { name: 'Use this address' }).click();

  await expect(openai.getByTestId('auth-status')).toContainText('Signed in (subscription)', {
    timeout: 10_000,
  });
  await expect(openai).toContainText('Current token valid until');
  await expect(page.getByTestId('profile-model-a')).toContainText('Ready');
  expect(await page.content()).not.toContain('secret');
  expect(corral.errors).toEqual([]);
});

test('a live run is refused until sign-in, then runs on the signed-in model', async ({
  page,
  corral,
}) => {
  corral.fake?.answerWith('Live answer from the model.');
  await corral.open('/');
  await agentToOutput(page);
  await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Settings → Models');

  // Sign in through the API the Settings page uses (as this tab), then run again.
  await page.evaluate(async (redirect) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const headers = { 'x-corral-csrf': csrfToken };
    const login = await fetch('/api/v1/model-auth/openai/login', {
      method: 'POST',
      headers,
    });
    if (!login.ok) throw new Error(`Sign-in request failed: ${login.status}`);
    const callback = await fetch('/api/v1/model-auth/openai/login/callback', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: redirect }),
    });
    if (!callback.ok) throw new Error(`Sign-in callback failed: ${callback.status}`);
  }, FAKE_REDIRECT_OK);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const [openai] = await (await fetch('/api/v1/model-auth')).json();
        return openai.signedIn;
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('Live answer from the model.');
  await expect(page.getByTestId('run-status')).toContainText('Succeeded');
  expect(corral.fake?.seen.tokens.every((token) => token === 'access-1-secret')).toBe(true);
});

test.describe('a borrowed Codex CLI login (CR-004)', () => {
  test.use({ codexLogin: true });

  test('[TC-SEC-002-H] is shown as the Codex login, read only, and live runs use it', async ({
    page,
    corral,
  }) => {
    corral.fake?.answerWith('Answer through the Codex login.');
    await corral.open('/');
    await page.getByRole('link', { name: 'Models' }).click();
    const openai = page.getByTestId('provider-openai');
    await expect(openai.getByTestId('auth-status')).toContainText(
      'Using your Codex CLI login (read only)',
    );
    await expect(openai).toContainText('Corral does not renew it');
    await expect(openai).toContainText('Current token valid until');
    // Signing out of Codex happens in Codex; a Corral sign-in can take over instead.
    await expect(openai.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(openai.getByRole('button', { name: 'Sign in to Corral instead' })).toBeVisible();
    await expect(page.getByTestId('profile-model-a')).toContainText('Ready');
    const content = await page.content();
    expect(content).not.toContain(FAKE_CODEX_ACCESS);
    expect(content).not.toContain('secret');
    expect(content).not.toContain('auth.json');

    await page.getByRole('link', { name: 'Corrals' }).click();
    await agentToOutput(page);
    await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-output')).toHaveText('Answer through the Codex login.');
    expect(corral.fake?.seen.tokens.length).toBeGreaterThan(0);
    expect(corral.fake?.seen.tokens.every((token) => token === FAKE_CODEX_ACCESS)).toBe(true);
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-SEC-002-H] an API key typed under Models runs live, is never shown, and can be removed (CR-005)', async ({
  page,
  corral,
}) => {
  corral.fake?.answerWith('Answer with an entered key.');
  await corral.open('/');
  await page.getByRole('link', { name: 'Models' }).click();
  const openai = page.getByTestId('provider-openai');
  await openai.getByLabel('API key').fill('sk-e2e-entered-secret');
  await openai.getByRole('button', { name: 'Save key' }).click();
  await expect(openai.getByTestId('auth-status')).toContainText('Using the API key you entered');
  // The key field gives way to "Remove key"; the key is not kept in the page.
  await expect(openai.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByTestId('profile-model-a')).toContainText('Ready');
  expect(await page.content()).not.toContain('sk-e2e-entered-secret');

  await page.getByRole('link', { name: 'Corrals' }).click();
  await agentToOutput(page);
  await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('Answer with an entered key.');
  expect(corral.fake?.seen.tokens.every((token) => token === 'sk-e2e-entered-secret')).toBe(true);

  await page.getByRole('link', { name: 'Models' }).click();
  await openai.getByRole('button', { name: 'Remove key' }).click();
  await expect(openai.getByTestId('auth-status')).toContainText('Not signed in');
  expect(corral.errors).toEqual([]);
});

test.describe('a keyless OpenAI-compatible endpoint (CR-005)', () => {
  test.use({ compatibleEndpoint: true });

  test('[TC-SEC-002-H] shows the endpoint and runs live without a key', async ({
    page,
    corral,
  }) => {
    let calls = 0;
    corral.endpoint?.setReply((body) => {
      calls += 1;
      const written = [...JSON.stringify(body).matchAll(/artv_[a-f0-9]{32}/g)].at(-1)?.[0];
      if (calls === 1) {
        return {
          toolCall: { name: 'write_artifact', args: { text: 'Answer from the local model.' } },
        };
      }
      if (calls === 2) {
        return { toolCall: { name: 'submit_result', args: { artifactVersionIds: [written] } } };
      }
      return 'Done.';
    });
    await corral.open('/');
    await page.getByRole('link', { name: 'Models' }).click();
    const local = page.getByTestId('provider-local');
    await expect(local.getByTestId('auth-status')).toContainText('No key needed');
    await expect(local).toContainText(new URL(corral.endpoint?.baseUrl ?? '').host);
    await expect(local.getByLabel('API key')).toHaveCount(0);
    await expect(local.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByTestId('profile-model-a')).toContainText('Ready');

    await page.getByRole('link', { name: 'Corrals' }).click();
    await agentToOutput(page);
    await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-output')).toHaveText('Answer from the local model.');
    expect(corral.endpoint?.authorizations.every((a) => a === 'Bearer no-key')).toBe(true);
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-UX-003-H] asks the signed-in model for a team draft once and opens it after review (CR-006)', async ({
  page,
  corral,
}) => {
  corral.fake?.replyText(
    JSON.stringify({
      name: 'Launch note',
      pattern: 'write_review',
      brief: 'Announce the new API.',
      criteria: ['Mention the release date.'],
      roles: [
        { slot: 'planner', name: 'Outliner', duty: 'List the key points.' },
        { slot: 'writer', name: 'Copywriter', duty: 'Write the announcement.' },
        { slot: 'reviewer', name: 'Editor', duty: 'Check tone and facts.' },
      ],
      reviewRounds: 1,
      finalApproval: false,
    }),
  );
  await corral.open('/');
  await page.evaluate(async (redirect) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const headers = { 'x-corral-csrf': csrfToken };
    await fetch('/api/v1/model-auth/openai/login', { method: 'POST', headers });
    await fetch('/api/v1/model-auth/openai/login/callback', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: redirect }),
    });
  }, FAKE_REDIRECT_OK);
  await page.reload();
  await page.getByRole('button', { name: 'Draft from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  await dialog.getByLabel('What should the team do?').fill('Announce the new API');
  await expect(dialog).toContainText('Uses one model request');
  await dialog.getByRole('button', { name: 'Ask the model' }).click();
  await expect(dialog.getByLabel('Team name')).toHaveValue('Launch note');
  await expect(dialog.getByLabel('Name of role 2')).toHaveValue('Copywriter');
  await dialog.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(page.locator('.react-flow__node', { hasText: 'Copywriter' })).toHaveCount(1);
  expect(corral.fake?.seen.hostRequests).toHaveLength(1);
  expect(corral.errors).toEqual([]);
});
