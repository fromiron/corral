import { FAKE_REDIRECT_OK } from '@corral/server/testing';
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
