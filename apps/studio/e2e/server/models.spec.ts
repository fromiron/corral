import { FAKE_CODEX_ACCESS, FAKE_REDIRECT_OK } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

/** Models live under Settings (Workbench polish: one way into settings). */
async function openModels(page: Page) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
}

test.use({ live: true });

async function agentToOutput(page: Page) {
  await page.getByRole('button', { name: 'New team' }).click();
  await page.getByRole('button', { name: 'Add Agent' }).click();
  await page.getByRole('button', { name: 'Add Output' }).click();
  await page
    .locator('.react-flow__node[data-id="agent_1"] .react-flow__handle[data-handleid="out"]')
    .dragTo(
      page.locator('.react-flow__node[data-id="output_1"] .react-flow__handle[data-handleid="in"]'),
    );
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
}

test('[TC-SEC-002-H] signing in from Settings shows status and expiry, never the token', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await openModels(page);
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
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
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
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
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
    await openModels(page);
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

    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
    await agentToOutput(page);
    await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
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
  await openModels(page);
  const openai = page.getByTestId('provider-openai');
  await openai.getByLabel('API key', { exact: true }).fill('sk-e2e-entered-secret');
  await expect(openai.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  await openai.getByRole('button', { name: 'Show API key', exact: true }).click();
  await expect(openai.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'text');
  await openai.getByRole('button', { name: 'Hide API key', exact: true }).click();
  await expect(openai.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  await openai.getByRole('button', { name: 'Save key' }).click();
  await expect(openai.getByTestId('auth-status')).toContainText('Using the API key you entered');
  // The key field gives way to "Remove key"; the key is not kept in the page.
  await expect(openai.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByTestId('profile-model-a')).toContainText('Ready');
  expect(await page.content()).not.toContain('sk-e2e-entered-secret');

  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await agentToOutput(page);
  await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
  await page.getByRole('tab', { name: 'Test run', exact: true }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('Answer with an entered key.');
  expect(corral.fake?.seen.tokens.every((token) => token === 'sk-e2e-entered-secret')).toBe(true);

  await openModels(page);
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
    await openModels(page);
    const local = page.getByTestId('provider-local');
    await expect(local.getByTestId('auth-status')).toContainText('No key needed');
    await expect(local).toContainText(new URL(corral.endpoint?.baseUrl ?? '').host);
    await expect(local.getByLabel('API key')).toHaveCount(0);
    await expect(local.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByTestId('profile-model-a')).toContainText('Ready');

    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
    await agentToOutput(page);
    await page.getByLabel('Agents').selectOption({ label: 'Live models (uses your sign-in)' });
    await page.getByRole('tab', { name: 'Test run', exact: true }).click();
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

test.describe('editing models on the Models page (CR-008)', () => {
  test('[TC-SEC-002-H] [TC-SEC-002-N] an inline endpoint key stays out of config and retries after a partial save', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await editor.getByRole('button', { name: 'Add endpoint' }).click();
    await editor.getByLabel('Endpoint id 1').fill('hive');
    await editor.getByLabel('Endpoint name 1').fill('Hive');
    await editor.getByLabel('Address of endpoint 1').fill('https://api-cdn.thehive.ai/api/v3');
    await editor.getByLabel('Models of endpoint 1').fill('deepseek-ai/deepseek-v4.1-flash-1017');
    await editor.getByLabel('Access of endpoint 1').selectOption('api_key');
    const key = editor.getByLabel('API key', { exact: true });
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill('fixture-inline-key');
    await editor.getByRole('button', { name: 'Show API key', exact: true }).click();
    await expect(key).toHaveAttribute('type', 'text');
    await editor.getByRole('button', { name: 'Hide API key', exact: true }).click();
    await expect(key).toHaveAttribute('type', 'password');
    await editor.getByLabel('Address of endpoint 1').fill('https://api-cdn.thehive.ai/api/v3/');
    await expect(key).toHaveValue('');
    await key.fill('fixture-inline-key');
    let failOnce = true;
    await page.route('**/model-auth/hive/api-key', async (route) => {
      if (failOnce) {
        failOnce = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'COMMAND_NOT_SUPPORTED', message: 'fixture key store unavailable' },
          }),
        });
      } else await route.continue();
    });
    await editor.getByRole('button', { name: 'Save models' }).click();
    await expect(editor.getByRole('alert')).toContainText(
      'Settings saved, but API key saving failed',
    );
    await expect(key).toHaveValue('fixture-inline-key');
    const stored = await page.evaluate(async () => (await fetch('/api/v1/model-config')).json());
    expect(stored.modelProviders[0].id).toBe('hive');
    expect(stored.modelProfiles.every((p: { provider: string }) => p.provider === 'openai')).toBe(
      true,
    );
    expect(JSON.stringify(stored)).not.toContain('fixture-inline-key');
    await editor.getByRole('button', { name: 'Save models' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId('provider-hive').getByTestId('auth-status')).toContainText(
      'Using the API key you entered',
    );
    expect(await page.content()).not.toContain('fixture-inline-key');
    expect(corral.errors.filter((e) => !e.includes('503'))).toEqual([]);
  });

  test('[TC-SEC-002-H] saving an endpoint and local reasoning settings in either order preserves both', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    const apply = page.getByRole('checkbox', {
      name: 'Allow automatic reasoning in all projects on this server',
    });
    await expect(apply).toBeEnabled();
    const changed = page.waitForResponse(
      (r) => r.url().endsWith('/models/reasoning') && r.request().method() === 'PUT',
    );
    await apply.click();
    expect((await changed).status()).toBe(200);
    await expect(apply).toBeChecked();
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await editor.getByRole('button', { name: 'Add endpoint' }).click();
    await editor.getByLabel('Endpoint id 1').fill('hive');
    await editor.getByLabel('Endpoint name 1').fill('Hive');
    await editor.getByLabel('Address of endpoint 1').fill('https://api-cdn.thehive.ai/api/v3');
    await editor.getByLabel('Access of endpoint 1').selectOption('api_key');
    await editor.getByLabel('Models of endpoint 1').fill('deepseek-ai/deepseek-v4.1-flash-1017');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/model-config') && r.request().method() === 'PUT',
    );
    await editor.getByRole('button', { name: 'Save models' }).click();
    expect((await saved).status()).toBe(200);
    await expect(editor).toHaveCount(0);
    await expect(apply).toBeChecked();
    const toggled = page.waitForResponse(
      (r) => r.url().endsWith('/models/reasoning') && r.request().method() === 'PUT',
    );
    await apply.click();
    expect((await toggled).status()).toBe(200);
    await page.reload();
    await expect(apply).not.toBeChecked();
    await page.getByRole('button', { name: 'Edit models' }).click();
    await expect(editor.getByLabel('Endpoint name 1')).toHaveValue('Hive');
    expect(corral.errors).toEqual([]);
  });

  test('[TC-SEC-002-N] a refreshed loader cannot overwrite a concurrent model edit and keeps the local endpoint draft', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await editor.getByRole('button', { name: 'Add endpoint' }).click();
    await editor.getByLabel('Endpoint id 1').fill('local');
    await editor.getByLabel('Endpoint name 1').fill('Keep my draft');
    await editor.getByLabel('Address of endpoint 1').fill('http://127.0.0.1:11434/v1');
    await editor.getByLabel('Models of endpoint 1').fill('llama3.2');
    await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const config = await (await fetch('/api/v1/model-config')).json();
      config.modelProfiles[0].model = 'gpt-test-b';
      const response = await fetch('/api/v1/model-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          revision: config.revision,
          modelProfiles: config.modelProfiles,
          modelProviders: config.modelProviders,
        }),
      });
      if (!response.ok) throw new Error('fixture config update failed');
    });
    // Signing in refreshes the parent loader while the editor stays mounted.
    await page
      .getByTestId('provider-openai')
      .getByRole('button', { name: 'Sign in', exact: true })
      .click();
    await expect(page.getByRole('link', { name: 'Open the sign-in page' })).toBeVisible();
    await editor.getByRole('button', { name: 'Save models' }).click();
    await expect(editor.getByRole('alert')).toContainText('Models changed');
    await expect(editor.getByLabel('Endpoint name 1')).toHaveValue('Keep my draft');
    const saved = await page.evaluate(async () => (await fetch('/api/v1/model-config')).json());
    expect(saved.modelProfiles[0].model).toBe('gpt-test-b');
    expect(saved.modelProviders).toEqual([]);
  });

  test('[TC-SEC-002-H] changes a profile’s model and adds a local endpoint, saved to the workspace', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await editor.getByLabel('Model of model-a').selectOption({ label: 'Test B' });

    await editor.getByRole('button', { name: 'Add endpoint' }).click();
    await editor.getByLabel('Endpoint id 1').fill('ollama');
    await editor.getByLabel('Endpoint name 1').fill('Ollama');
    await editor.getByLabel('Address of endpoint 1').fill('http://127.0.0.1:11434/v1');
    await editor.getByLabel('Models of endpoint 1').fill('llama3.2');
    await editor.getByLabel('Provider of model-b').selectOption({ label: 'Ollama' });
    await editor.getByLabel('Model of model-b').selectOption({ label: 'llama3.2' });
    await editor.getByRole('checkbox', { name: 'Linux isolation · model-b' }).check();
    await editor.getByRole('button', { name: 'Save models' }).click();

    await expect(page.getByRole('region', { name: 'Edit models' })).toHaveCount(0);
    await expect(page.getByTestId('profile-model-a')).toContainText('openai/gpt-test-b');
    await expect(page.getByTestId('profile-model-b')).toContainText('ollama/llama3.2');
    await expect(page.getByTestId('provider-ollama')).toContainText('No key needed');
    await page.reload();
    await expect(page.getByTestId('profile-model-a')).toContainText('openai/gpt-test-b');
    await page.getByRole('button', { name: 'Edit models' }).click();
    await expect(page.getByRole('checkbox', { name: 'Linux isolation · model-b' })).toBeChecked();
    expect(corral.errors).toEqual([]);
  });

  test('[TC-SEC-002-N] an address off this computer over http is refused by field, and nothing changes', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await page.getByRole('button', { name: 'Edit models' }).click();
    const editor = page.getByRole('region', { name: 'Edit models' });
    await editor.getByRole('button', { name: 'Add endpoint' }).click();
    await editor.getByLabel('Endpoint id 1').fill('lan');
    await editor.getByLabel('Endpoint name 1').fill('LAN box');
    await editor.getByLabel('Address of endpoint 1').fill('http://10.0.0.5/v1');
    await editor.getByLabel('Models of endpoint 1').fill('llama3.2');
    await editor.getByRole('button', { name: 'Save models' }).click();
    await expect(editor.getByRole('alert')).toContainText('modelProviders.0.baseUrl');
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('provider-lan')).toHaveCount(0);
    expect(corral.errors.filter((e) => !e.includes('400'))).toEqual([]);
  });
});

test('[TC-CONTEXT-001-H] [TC-CONTEXT-001-N] profile context preview, explicit zero, round-trip and a concurrent reasoning save', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit models' });
  await editor.getByLabel('Context window · model-a').fill('64000');
  await editor.getByLabel('Summary reserve · model-a').fill('0');
  await editor.getByLabel('Recent history · model-a').fill('0');
  await expect(editor.getByTestId('context-policy-model-a')).toContainText('64,000');
  await expect(editor.getByTestId('context-policy-model-a')).toContainText(
    'below the request output cap',
  );
  await editor.getByRole('button', { name: 'Save models' }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  await expect(editor.getByLabel('Summary reserve · model-a')).toHaveValue('0');
  await expect(editor.getByLabel('Recent history · model-a')).toHaveValue('0');
  await editor.getByLabel('Context window · model-a').fill('96000');
  const changed = page.waitForResponse(
    (r) => r.url().endsWith('/models/reasoning') && r.request().method() === 'PUT',
  );
  await page
    .getByRole('checkbox', { name: 'Allow automatic reasoning in all projects on this server' })
    .click();
  expect((await changed).status()).toBe(200);
  await editor.getByRole('button', { name: 'Save models' }).click();
  await expect(editor.getByRole('alert')).toContainText('Models changed');
  await expect(editor.getByLabel('Context window · model-a')).toHaveValue('96000');
  const saved = await page.evaluate(async () => (await fetch('/api/v1/model-config')).json());
  expect(saved.modelProfiles[0]).toMatchObject({
    contextWindow: 64000,
    compaction: { reserveTokens: 0, keepRecentTokens: 0 },
  });
  expect(JSON.stringify(saved.modelProfiles)).not.toContain('uid');
});

test('[TC-CONTEXT-001-H] endpoint renaming keeps original model metadata', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const config = await (await fetch('/api/v1/model-config')).json();
    const result = await fetch('/api/v1/model-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        revision: config.revision,
        modelProfiles: config.modelProfiles,
        modelProviders: [
          {
            id: 'original',
            name: 'Local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            access: 'none',
            models: [
              {
                id: 'fixture-model',
                name: 'Metadata',
                contextWindow: 128000,
                maxOutput: 8192,
                reasoning: true,
                imageInput: true,
              },
            ],
          },
        ],
      }),
    });
    if (!result.ok) throw new Error('fixture save failed');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Edit models' });
  await editor.getByLabel('Endpoint id 1').fill('renamed');
  await editor.getByRole('button', { name: 'Save models' }).click();
  await expect(editor).toHaveCount(0);
  const saved = await page.evaluate(async () => (await fetch('/api/v1/model-config')).json());
  expect(saved.modelProviders[0]).toMatchObject({
    id: 'renamed',
    models: [
      {
        id: 'fixture-model',
        name: 'Metadata',
        contextWindow: 128000,
        maxOutput: 8192,
        reasoning: true,
        imageInput: true,
      },
    ],
  });
});
