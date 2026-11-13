import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FAKE_CODEX_ACCESS, FAKE_REDIRECT_OK } from '@corral/server/testing';
import type { Locator, Page } from '@playwright/test';
import {
  addAgentAndOutput,
  modelSettingsTab,
  openLibrary,
  openLibraryTeams,
  openTestRun,
  teamCanvas,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

/** Models live under Settings (Workbench polish: one way into settings). */
async function openModels(page: Page) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
}

/** A row of Settings › Models › Connections, by its provider's name. */
const connection = (page: Page, name: string) => page.getByRole('article', { name, exact: true });

/** Opens a connection row; the row itself is the toggle. */
async function expand(row: Locator) {
  await row.getByRole('button', { expanded: false }).click();
  await expect(row.getByRole('button', { expanded: true })).toBeVisible();
}

/**
 * A kit text field by its name. (Its label also holds an aria-hidden copy of the text, so the
 * accessible name is what matches exactly, not the label's text.)
 */
const field = (scope: Locator, name: string) => scope.getByRole('textbox', { name, exact: true });

/** The Add connection dialog, whatever face it shows (its title names the face). */
const sheet = (page: Page) =>
  page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Close', exact: true }) });

/** Add connection → OpenAI-compatible address: the address face. */
async function openAddressFace(page: Page) {
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole('button', { name: /^OpenAI-compatible address/ }).click();
  await expect(field(dialog, 'Address')).toBeVisible();
  return dialog;
}

/** The last face of Add connection: the models the connection made usable. */
const foundModels = (dialog: Locator) =>
  dialog.getByRole('list', { name: 'Models now available', exact: true });

/** A profile's model field on the Profiles tab; it reads "Model of <profile>: <model>". */
const modelField = (panel: Locator, profile: string) =>
  panel.getByRole('button', { name: new RegExp(`^Model of ${profile}: `) });

/** Chooses a profile's model from its searchable model list. */
async function chooseModel(page: Page, panel: Locator, profile: string, model: string) {
  await modelField(panel, profile).click();
  const list = page.getByRole('dialog', { name: `Model of ${profile}`, exact: true });
  await list.getByRole('combobox', { name: 'Search models', exact: true }).fill(model);
  // An option reads its name, then its marks ("Test B, Image input").
  const name = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(, |$)`);
  await list.getByRole('option', { name }).click();
  await expect(modelField(panel, profile)).toHaveAccessibleName(`Model of ${profile}: ${model}`);
}

/** Signs in to the fake OpenAI through the API the Settings page uses (as this tab). */
async function signInOpenAI(page: Page) {
  await page.evaluate(async (redirect) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const headers = { 'x-corral-csrf': csrfToken };
    const login = await fetch('/api/v1/model-auth/openai/login', { method: 'POST', headers });
    if (!login.ok) throw new Error(`Sign-in request failed: ${login.status}`);
    const callback = await fetch('/api/v1/model-auth/openai/login/callback', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ url: redirect }),
    });
    if (!callback.ok) throw new Error(`Sign-in callback failed: ${callback.status}`);
  }, FAKE_REDIRECT_OK);
}

const readConfig = (page: Page) =>
  page.evaluate(async () => (await fetch('/api/v1/model-config')).json());

/**
 * An OpenAI-compatible address on 127.0.0.1 whose `/models` lists `ids` (the harness's endpoint
 * serves inference only). Close it when the test ends.
 */
async function serveModelList(ids: string[]) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test.use({ live: true });

async function agentToOutput(page: Page) {
  await openLibraryTeams(page);
  await page.getByRole('button', { name: 'New team' }).click();
  await addAgentAndOutput(page);
  await openTestRun(page);
}

test('signing in from Settings shows the connection and its models, never the token', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await openModels(page);
  const openai = connection(page, 'OpenAI');
  await expect(openai).toContainText('Not connected');
  // Until then the profiles point at a model no connection offers.
  let profiles = await modelSettingsTab(page, 'Profiles');
  await expect(modelField(profiles, 'model-a')).toContainText('Not connected');

  await modelSettingsTab(page, 'Connections');
  await openai.getByRole('button', { name: 'Connect: OpenAI', exact: true }).click();
  const dialog = sheet(page);
  const link = dialog.getByRole('link', { name: 'Open sign-in page' });
  await expect(link).toHaveAttribute('href', 'https://auth.example.test/authorize?state=s1');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  // The person signs in on the provider's page; here the redirect address is pasted instead.
  await dialog.getByRole('button', { name: 'Paste the address instead' }).click();
  await field(dialog, 'Address the browser stopped on').fill(FAKE_REDIRECT_OK);
  await dialog.getByRole('button', { name: 'Use this address' }).click();

  // The last face shows the models the sign-in made usable.
  await expect(foundModels(dialog)).toContainText('Test A', { timeout: 10_000 });
  await expect(foundModels(dialog)).toContainText('Test B');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(openai).toContainText('Subscription · 2 models');
  profiles = await modelSettingsTab(page, 'Profiles');
  await expect(modelField(profiles, 'model-a')).toHaveAccessibleName('Model of model-a: Test A');
  await expect(modelField(profiles, 'model-a')).not.toContainText('Not connected');
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
  await page.getByRole('combobox', { name: 'Agents', exact: true }).click();
  await page.getByRole('option', { name: 'Live models (uses your sign-in)', exact: true }).click();
  await openTestRun(page);
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
  await openTestRun(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('Live answer from the model.');
  await expect(page.getByTestId('run-status')).toContainText('Completed');
  expect(corral.fake?.seen.tokens.every((token) => token === 'access-1-secret')).toBe(true);
});

test.describe('a borrowed Codex CLI login', () => {
  test.use({ codexLogin: true });

  test('is shown as the Codex login, read only, and live runs use it', async ({ page, corral }) => {
    corral.fake?.answerWith('Answer through the Codex login.');
    await corral.open('/');
    await openModels(page);
    const openai = connection(page, 'OpenAI');
    await expect(openai).toContainText('Codex CLI sign-in ·');
    // Signing out of Codex happens in Codex; a Corral sign-in can take over instead.
    await expand(openai);
    await expect(openai.getByRole('button', { name: 'Sign in to Corral instead' })).toBeVisible();
    await expect(openai.getByRole('button', { name: /^Disconnect/ })).toHaveCount(0);
    const profiles = await modelSettingsTab(page, 'Profiles');
    await expect(modelField(profiles, 'model-a')).toHaveAccessibleName('Model of model-a: Test A');
    await expect(modelField(profiles, 'model-a')).not.toContainText('Not connected');
    const content = await page.content();
    expect(content).not.toContain(FAKE_CODEX_ACCESS);
    expect(content).not.toContain('secret');
    expect(content).not.toContain('auth.json');

    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await agentToOutput(page);
    await page.getByRole('combobox', { name: 'Agents', exact: true }).click();
    await page
      .getByRole('option', { name: 'Live models (uses your sign-in)', exact: true })
      .click();
    await openTestRun(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-output')).toHaveText('Answer through the Codex login.');
    expect(corral.fake?.seen.tokens.length).toBeGreaterThan(0);
    expect(corral.fake?.seen.tokens.every((token) => token === FAKE_CODEX_ACCESS)).toBe(true);
    expect(corral.errors).toEqual([]);
  });
});

test('an API key typed under Models runs live, is never shown, and can be removed', async ({
  page,
  corral,
}) => {
  corral.fake?.answerWith('Answer with an entered key.');
  await corral.open('/');
  await openModels(page);
  const openai = connection(page, 'OpenAI');
  await openai.getByRole('button', { name: 'Connect: OpenAI', exact: true }).click();
  const dialog = sheet(page);
  await dialog.getByRole('tab', { name: 'API key', exact: true }).click();
  const key = dialog.getByLabel('API key', { exact: true });
  await key.fill('sk-e2e-entered-secret');
  await expect(key).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Show API key', exact: true }).click();
  await expect(key).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: 'Hide API key', exact: true }).click();
  await expect(key).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  // The key field gives way to the models the key reaches; the key is not kept in the page.
  await expect(foundModels(dialog)).toContainText('Test B (API only)');
  await expect(dialog.getByLabel('API key')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(openai).toContainText('API key · 3 models');
  expect(await page.content()).not.toContain('sk-e2e-entered-secret');

  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await agentToOutput(page);
  await page.getByRole('combobox', { name: 'Agents', exact: true }).click();
  await page.getByRole('option', { name: 'Live models (uses your sign-in)', exact: true }).click();
  await openTestRun(page);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-output')).toHaveText('Answer with an entered key.');
  expect(corral.fake?.seen.tokens.every((token) => token === 'sk-e2e-entered-secret')).toBe(true);

  await openModels(page);
  await expand(openai);
  await openai.getByRole('button', { name: 'Disconnect OpenAI', exact: true }).click();
  await expect(openai).toContainText('Not connected');
  expect(corral.errors).toEqual([]);
});

test.describe('a keyless OpenAI-compatible endpoint', () => {
  test.use({ compatibleEndpoint: true });

  test('shows the endpoint and runs live without a key', async ({ page, corral }) => {
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
    const local = connection(page, 'Local server');
    await expect(local).toContainText('No key · 1 model');
    // Nothing to sign in to or connect: no key field, no Connect, no Disconnect.
    await expect(page.getByRole('button', { name: 'Connect: Local server' })).toHaveCount(0);
    await expand(local);
    await expect(local).toContainText(new URL(corral.endpoint?.baseUrl ?? '').host);
    await expect(local.getByLabel('API key')).toHaveCount(0);
    await expect(local.getByRole('button', { name: /^Disconnect/ })).toHaveCount(0);
    const profiles = await modelSettingsTab(page, 'Profiles');
    await expect(modelField(profiles, 'model-a')).toHaveAccessibleName(
      'Model of model-a: llama3.2',
    );
    await expect(modelField(profiles, 'model-a')).not.toContainText('Not connected');

    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await agentToOutput(page);
    await page.getByRole('combobox', { name: 'Agents', exact: true }).click();
    await page
      .getByRole('option', { name: 'Live models (uses your sign-in)', exact: true })
      .click();
    await openTestRun(page);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByTestId('run-output')).toHaveText('Answer from the local model.');
    expect(corral.endpoint?.authorizations.every((a) => a === 'Bearer no-key')).toBe(true);
    expect(corral.errors).toEqual([]);
  });
});

test('asks the signed-in model for a team draft once and opens it after review', async ({
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
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: 'Draft from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  await dialog.getByLabel('What should the team do?').fill('Announce the new API');
  // The button itself says what asking costs.
  await expect(dialog.getByRole('button', { name: 'Ask the model' })).toContainText('1 request');
  const draftRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/v1/team-drafts') && request.method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Ask the model' }).click();
  const draftBody = (await draftRequest).postDataJSON();
  await expect(dialog.getByLabel('Team name')).toHaveValue('Launch note');
  await expect(dialog.getByLabel('Name of role 2')).toHaveValue('Copywriter');
  await dialog.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
  await expect(teamCanvas(page).locator('[data-node]', { hasText: 'Copywriter' })).toHaveCount(1);
  expect(corral.fake?.seen.hostRequests).toHaveLength(1);
  await openModels(page);
  // Selecting the tab reads the first page; there is no separate load button.
  await modelSettingsTab(page, 'Usage');
  const usage = page.getByRole('region', { name: 'Model request history' });
  await expect(usage.getByRole('table')).toBeVisible();
  await expect(usage.getByRole('table')).toContainText('Subscription');
  await expect(usage.getByRole('table')).toContainText('Draft');
  const replay = await page.evaluate(async (body) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    return (
      await fetch('/api/v1/team-drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      })
    ).status;
  }, draftBody);
  expect(replay).toBe(200);
  expect(corral.fake?.seen.hostRequests).toHaveLength(1);
  await usage.getByRole('table').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/llm-model-history.png', fullPage: true });
  expect(corral.errors).toEqual([]);
});

test.describe('editing models on the Models page', () => {
  test('an endpoint key stays out of config and is sent again after a partial save', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    const dialog = await openAddressFace(page);
    await field(dialog, 'Name').fill('Hive');
    await field(dialog, 'Address').fill('https://models.example.test/v1');
    const key = dialog.getByLabel('API key', { exact: true });
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill('fixture-inline-key');
    await dialog.getByRole('button', { name: 'Show API key', exact: true }).click();
    await expect(key).toHaveAttribute('type', 'text');
    await dialog.getByRole('button', { name: 'Hide API key', exact: true }).click();
    await expect(key).toHaveAttribute('type', 'password');
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
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    // The address is saved; the key is not, and the face says so where it happened.
    await expect(dialog.getByRole('alert')).toContainText('fixture key store unavailable');
    const stored = await readConfig(page);
    expect(stored.modelProviders[0].id).toBe('hive');
    expect(stored.modelProfiles.every((p: { provider: string }) => p.provider === 'openai')).toBe(
      true,
    );
    expect(JSON.stringify(stored)).not.toContain('fixture-inline-key');
    // A key the server answered about leaves the page; it is typed again and sent on its own.
    await expect(key).toHaveValue('');
    await key.fill('fixture-inline-key');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    // Saved this time; the address itself is not reachable from the test, and the face says that.
    await expect(dialog.getByRole('alert')).toContainText('Couldn’t reach the address');
    await expect(key).toHaveValue('');
    const again = await readConfig(page);
    expect(again.modelProviders.map((p: { id: string }) => p.id)).toEqual(['hive']);
    expect(JSON.stringify(again)).not.toContain('fixture-inline-key');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The row holds the key without showing it: it can be disconnected.
    const hive = connection(page, 'Hive');
    await expand(hive);
    await expect(hive.getByRole('button', { name: 'Disconnect Hive', exact: true })).toBeVisible();
    expect(await page.content()).not.toContain('fixture-inline-key');
    // Once saved, the key has one home, and the saved key never comes back into a field.
    await hive.getByRole('button', { name: 'Edit address', exact: true }).click();
    const edit = sheet(page);
    await expect(field(edit, 'Address')).toHaveValue('https://models.example.test/v1');
    await expect(edit.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(edit.getByLabel('API key', { exact: true })).toHaveAttribute(
      'placeholder',
      'Leave blank to keep the saved key',
    );
    expect(await page.content()).not.toContain('fixture-inline-key');
    expect(corral.errors.filter((e) => !e.includes('503'))).toEqual([]);
  });

  test('a refreshed loader cannot overwrite a concurrent profile edit and keeps the draft', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    const profiles = await modelSettingsTab(page, 'Profiles');
    await profiles
      .getByRole('button', { name: 'Advanced settings of model-b', exact: true })
      .click();
    const advanced = profiles.getByRole('group', { name: 'Advanced settings of model-b' });
    await field(advanced, 'Context window').fill('64000');
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
    // Starting a sign-in refreshes the page's lists while the editor stays mounted on its hidden
    // Profiles tab (every model settings tab stays mounted).
    await modelSettingsTab(page, 'Connections');
    await connection(page, 'OpenAI')
      .getByRole('button', { name: 'Connect: OpenAI', exact: true })
      .click();
    const dialog = sheet(page);
    await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await modelSettingsTab(page, 'Profiles');
    await expect(field(advanced, 'Context window')).toHaveValue('64000');
    await profiles.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(profiles.getByRole('alert')).toContainText('Profiles changed elsewhere');
    await expect(field(advanced, 'Context window')).toHaveValue('64000');
    const saved = await readConfig(page);
    expect(saved.modelProfiles[0].model).toBe('gpt-test-b');
    expect(saved.modelProfiles[1].contextWindow).toBeUndefined();
  });

  test('changes profiles’ models, one to a model of an added local address, saved to the workspace', async ({
    page,
    corral,
  }) => {
    const ollama = await serveModelList(['llama3.2']);
    try {
      await corral.open('/');
      // OpenAI's models become choosable once it is connected.
      await signInOpenAI(page);
      await openModels(page);
      const dialog = await openAddressFace(page);
      await field(dialog, 'Name').fill('Ollama');
      await field(dialog, 'Address').fill(ollama.baseUrl);
      await dialog.getByRole('tab', { name: 'No key', exact: true }).click();
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(foundModels(dialog)).toContainText('llama3.2');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(connection(page, 'Ollama')).toContainText('No key · 1 model');

      const profiles = await modelSettingsTab(page, 'Profiles');
      await chooseModel(page, profiles, 'model-a', 'Test B');
      await chooseModel(page, profiles, 'model-b', 'llama3.2');
      await profiles
        .getByRole('button', { name: 'Advanced settings of model-b', exact: true })
        .click();
      await profiles
        .getByRole('group', { name: 'Advanced settings of model-b' })
        .getByRole('switch', { name: 'Linux isolation' })
        .click();
      await profiles.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(profiles.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      const saved = await readConfig(page);
      expect(saved.modelProfiles).toMatchObject([
        { id: 'model-a', provider: 'openai', model: 'gpt-test-b' },
        { id: 'model-b', provider: 'ollama', model: 'llama3.2', workerIsolation: 'linux-bwrap' },
      ]);
      // The address's models are fetched, not written into the workspace.
      expect(saved.modelProviders).toMatchObject([{ id: 'ollama', models: [] }]);

      await page.reload();
      const after = await modelSettingsTab(page, 'Profiles');
      await expect(modelField(after, 'model-a')).toHaveAccessibleName('Model of model-a: Test B');
      await expect(modelField(after, 'model-b')).toHaveAccessibleName('Model of model-b: llama3.2');
      await after
        .getByRole('button', { name: 'Advanced settings of model-b', exact: true })
        .click();
      await expect(
        after
          .getByRole('group', { name: 'Advanced settings of model-b' })
          .getByRole('switch', { name: 'Linux isolation' }),
      ).toBeChecked();
      expect(corral.errors).toEqual([]);
    } finally {
      await ollama.close();
    }
  });

  test('an address off this computer over http is refused by field, and nothing changes', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/api/v1/model'))
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const dialog = await openAddressFace(page);
    await field(dialog, 'Name').fill('LAN box');
    const address = field(dialog, 'Address');
    await address.fill('http://10.0.0.5/v1');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(address).toHaveAccessibleDescription(
      'Use https, or http only on this computer (localhost, 127.0.0.1).',
    );
    // Leaving with the typed address asks first; discarding it saves nothing.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(connection(page, 'LAN box')).toHaveCount(0);
    expect(writes).toEqual([]);
    expect((await readConfig(page)).modelProviders).toEqual([]);
    expect(corral.errors).toEqual([]);
  });
});

test('profile context preview, explicit zero and round-trip', async ({ page, corral }) => {
  await corral.open('/settings/models');
  const profiles = await modelSettingsTab(page, 'Profiles');
  await profiles.getByRole('button', { name: 'Advanced settings of model-a', exact: true }).click();
  const advanced = profiles.getByRole('group', { name: 'Advanced settings of model-a' });
  await field(advanced, 'Context window').fill('64000');
  await field(advanced, 'Summary reserve').fill('0');
  await field(advanced, 'Recent history').fill('0');
  // The server's preview of this very draft: an explicit zero reserve is below the output cap.
  await expect(advanced).toContainText('Summary reserve is below the request output cap');
  await profiles.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(profiles.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.reload();
  const after = await modelSettingsTab(page, 'Profiles');
  await after.getByRole('button', { name: 'Advanced settings of model-a', exact: true }).click();
  const reopened = after.getByRole('group', { name: 'Advanced settings of model-a' });
  await expect(field(reopened, 'Context window')).toHaveValue('64000');
  await expect(field(reopened, 'Summary reserve')).toHaveValue('0');
  await expect(field(reopened, 'Recent history')).toHaveValue('0');
  const saved = await readConfig(page);
  expect(saved.modelProfiles[0]).toMatchObject({
    contextWindow: 64000,
    compaction: { reserveTokens: 0, keepRecentTokens: 0 },
  });
  expect(JSON.stringify(saved.modelProfiles)).not.toContain('uid');
});

test('endpoint renaming keeps original model metadata', async ({ page, corral }) => {
  const local = await serveModelList(['fixture-model']);
  try {
    await corral.open('/settings/models');
    await page.evaluate(async (baseUrl) => {
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
              baseUrl,
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
    }, local.baseUrl);
    await page.reload();
    const row = connection(page, 'Local');
    await expand(row);
    await row.getByRole('button', { name: 'Edit address', exact: true }).click();
    const dialog = sheet(page);
    await field(dialog, 'Name').fill('Renamed');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(foundModels(dialog)).toContainText('Metadata');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(connection(page, 'Renamed')).toBeVisible();
    const saved = await readConfig(page);
    expect(saved.modelProviders).toHaveLength(1);
    expect(saved.modelProviders[0]).toMatchObject({
      id: 'original',
      name: 'Renamed',
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
  } finally {
    await local.close();
  }
});

test('slow OAuth status reads do not overlap or starve the completed login', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/models');
  await connection(page, 'OpenAI')
    .getByRole('button', { name: 'Connect: OpenAI', exact: true })
    .click();
  const dialog = sheet(page);
  await expect(dialog.getByRole('link', { name: 'Open sign-in page' })).toBeVisible();
  let pending = 0,
    peak = 0;
  await page.route('**/api/v1/model-auth', async (route) => {
    pending++;
    peak = Math.max(peak, pending);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1900));
      const response = await route.fetch();
      await route.fulfill({ response });
    } catch {
      /* The test context may close while an old broken poll is still outstanding. */
    } finally {
      pending--;
    }
  });
  await page.evaluate(async (redirect) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch('/api/v1/model-auth/openai/login/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({ url: redirect }),
    });
    if (!response.ok) throw new Error('fixture OAuth callback failed');
  }, FAKE_REDIRECT_OK);
  // The dialog follows the finished sign-in to the models it made usable.
  await expect(foundModels(dialog)).toContainText('Test A', { timeout: 9000 });
  expect(peak).toBe(1);
});
