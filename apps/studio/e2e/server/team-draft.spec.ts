import type {
  TeamAssistantRequest,
  TeamAssistantResponse,
  TeamCatalog,
  TeamComposition,
} from '@corral/contracts';
import { FAKE_REDIRECT_OK } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import {
  closeSettings,
  editorSettings,
  openFlowGraph,
  openLibrary,
  saveNewTeam,
  teamNode,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

// The team assistant proposes only with a model (docs/specs/features/team-assistant.md). These
// tests connect the fake OpenAI and answer the assistant's request in the browser, so the
// proposal is the one written here and no provider is reached.
test.use({ live: true });

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

async function savedTeams(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => (await fetch('/api/v1/corrals')).json());
}

type CreateRequest = Extract<TeamAssistantRequest, { mode: 'create' }>;
/** A composition written against the catalog the editor sent, as a model would. */
type Compose = (agent: (name: string) => string, request: CreateRequest) => TeamComposition;

/** The catalog id of the agent the editor lists under `name`. */
function agentIn(catalog: TeamCatalog, name: string): string {
  const found = catalog.agents.find((agent) => agent.name === name);
  if (!found) throw new Error(`the catalog has no agent ${name}`);
  return found.id;
}

/** Answers every assistant request with a composition, and keeps the requests. */
async function answerWith(page: Page, compose: Compose, reason: string) {
  const requests: CreateRequest[] = [];
  await page.route('**/api/v1/team-assistant', async (route) => {
    const request = route.request().postDataJSON() as CreateRequest;
    requests.push(request);
    const plan = compose((name) => agentIn(request.catalog, name), request);
    const body: TeamAssistantResponse = { reply: { kind: 'plan', plan, reason }, model: 'Test A' };
    await route.fulfill({ json: body });
  });
  return requests;
}

async function draftFromGoal(page: Page) {
  await signInOpenAI(page);
  await page.reload();
  await openLibrary(page, 'Templates');
  await page.getByRole('link', { name: 'Draft from a goal' }).click();
  const input = page.getByRole('textbox', { name: 'Request to build the team', exact: true });
  await expect(page.getByText('Test A', { exact: true })).toBeVisible();
  return input;
}

async function propose(page: Page, input: ReturnType<Page['getByRole']>, goal: string) {
  await input.fill(goal);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Proposal from Test A' })).toBeVisible();
}

/** One writer, as the bundled Writing agent. */
const alone =
  (fields: Pick<TeamComposition, 'name' | 'brief' | 'criteria' | 'outrider'>): Compose =>
  (agent) => ({
    ...fields,
    seats: [
      { id: 'w', agent: agent('Writing'), name: 'Writer', duty: 'Write and submit the text.' },
    ],
    flow: [{ seat: 'w' }],
  });

/** Three seats in order: a cause, a fix and a note. */
const sequence: Compose = (agent) => ({
  name: 'Security PR review',
  brief: 'Review the pull request for security issues.',
  criteria: ['Each finding names the file and line.'],
  seats: [
    {
      id: 's',
      agent: agent('Cause investigation'),
      name: 'Security scope',
      duty: 'List the changes worth checking.',
    },
    {
      id: 'c',
      agent: agent('Challenge'),
      name: 'Injection check',
      duty: 'Look for injection flaws.',
    },
    {
      id: 'w',
      agent: agent('Writing'),
      name: 'Summary writer',
      duty: 'Keep the confirmed findings.',
    },
  ],
  flow: [{ seat: 's' }, { seat: 'c' }, { seat: 'w' }],
});

/** The same team refined: two checks in parallel, then a summary a final check passes. */
const crew: Compose = (agent) => ({
  name: 'Security PR review',
  brief: 'Review the pull request for security issues.',
  criteria: ['Each finding names the file and line.'],
  seats: [
    {
      id: 's',
      agent: agent('Cause investigation'),
      name: 'Security scope',
      duty: 'List the changes worth checking.',
    },
    {
      id: 'c',
      agent: agent('Challenge'),
      name: 'Injection check',
      duty: 'Look for injection flaws.',
    },
    { id: 'k', agent: agent('Challenge'), name: 'Secrets check', duty: 'Look for leaked secrets.' },
    {
      id: 'w',
      agent: agent('Writing'),
      name: 'Summary writer',
      duty: 'Keep the confirmed findings.',
    },
    {
      id: 'j',
      agent: agent('Review'),
      name: 'Final check',
      duty: 'Check the summary against the findings.',
    },
  ],
  flow: [{ seat: 's' }, { parallel: ['c', 'k'] }, { loop: { work: ['w'], judge: 'j', rounds: 2 } }],
});

test('a composed proposal is refined in the conversation, fills the unsaved draft, and only saving makes a team', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const requests = await answerWith(
    page,
    (agent, request) => (request.proposal ? crew : sequence)(agent, request),
    'Two checks in parallel find more, and a final check passes the summary.',
  );
  const input = await draftFromGoal(page);
  await page.getByRole('button', { name: 'Use one writer to write this guide.' }).click();
  await expect(input).toHaveValue('Use one writer to write this guide.');
  expect(requests).toHaveLength(0);
  await propose(page, input, 'Check the pull request for security issues.');
  // The request carries what the editor can pick by hand, never a prompt or a tool.
  const [first] = requests;
  expect(first?.catalog.agents.map((agent) => agent.name)).toContain('Judging');
  expect(JSON.stringify(first?.catalog)).not.toMatch(/prompt|allowedWorkTools|resourceHash/);
  expect(first).not.toHaveProperty('proposal');
  const shown = page.getByRole('region', { name: 'Proposal from Test A' });
  await expect(shown.getByText('Injection check', { exact: true })).toBeVisible();
  // Refining sends the shown composition back; the answer replaces it.
  await input.fill('Also look for leaked secrets, and check the summary before it goes out.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(shown.getByText('Secrets check', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.proposal?.flow).toEqual([{ seat: 's' }, { seat: 'c' }, { seat: 'w' }]);
  await expect(shown.getByRole('list', { name: 'In parallel', exact: true })).toBeVisible();
  await expect(shown.getByRole('list', { name: 'Up to 2 rounds', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to draft', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Earlier proposal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply to draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Security scope', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Security PR review', exact: true }),
  ).toBeVisible();
  for (const seat of ['Injection check', 'Secrets check', 'Summary writer', 'Final check'])
    await expect(page.getByRole('button', { name: seat, exact: true })).toBeVisible();
  expect(await savedTeams(page)).toHaveLength(0);
  await saveNewTeam(page);
  expect(await savedTeams(page)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'No problems', exact: true })).toBeVisible();
  await openFlowGraph(page);
  await expect(page.getByRole('application', { name: 'Corral graph' })).toContainText(
    'Secrets check',
  );
  await teamNode(page, 'output').press('Enter');
  await expect(
    editorSettings(page).getByRole('switch', { name: 'Ask for final approval' }),
  ).not.toBeChecked();
  expect(requests).toHaveLength(2);
  expect(corral.fake?.seen.hostRequests).toHaveLength(0);
});

test('a proposal with opt-in artifact review saves it as a shared Outrider setting', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await answerWith(
    page,
    alone({
      name: 'Manuscript',
      brief: 'Write the manuscript and revise it after review when needed.',
      criteria: ['Revise after each review.'],
      outrider: 'artifact_review',
    }),
    'The writer asks for review when needed.',
  );
  const input = await draftFromGoal(page);
  await propose(
    page,
    input,
    'Let the writer ask for manuscript review when needed. The writer should revise it and submit.',
  );
  await expect(page.getByText(/Workers can ask the shared Outrider for feedback/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply to draft' }).click();
  await saveNewTeam(page);
  await page.reload();
  await openFlowGraph(page);
  await page.getByRole('button', { name: 'Outrider · Entire team', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Artifact review', exact: true })).toBeChecked();
});

test('a proposal requiring review confirms the producer before adding a gate to the saved Output', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await answerWith(
    page,
    alone({
      name: 'Launch note',
      brief: 'Write a launch note that passes review before it is submitted.',
      criteria: ['Name the release date.'],
      outrider: 'required_review',
    }),
    'The note must pass review before it is submitted.',
  );
  const input = await draftFromGoal(page);
  await propose(page, input, 'Write a launch note. The result must pass review before submitting.');
  const confirm = page.getByRole('switch', { name: 'Submit after review passes' });
  await expect(confirm).not.toBeChecked();
  await expect(confirm).toHaveAccessibleDescription(/revises the candidate/);
  const open = page.getByRole('button', { name: 'Apply to draft' });
  await expect(open).toBeDisabled();
  await confirm.click();
  await open.click();
  await saveNewTeam(page);
  await expect(page.getByRole('button', { name: 'No problems', exact: true })).toBeVisible();
  await page.reload();
  await openFlowGraph(page);
  await teamNode(page, 'output').click();
  await expect(page.getByRole('switch', { name: 'Submit after review passes' })).toBeChecked();
});

test('without a usable model the request opens the model settings and sends nothing', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/team-assistant')) requests.push(r.url());
  });
  await openLibrary(page, 'Teams');
  await page.getByRole('link', { name: 'New Corral', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Build the team with AI', exact: true });
  const connect = assistant.getByRole('button', { name: 'Connect a model', exact: true });
  await expect(connect).toBeVisible();
  await expect(assistant.getByRole('textbox')).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(
    assistant.getByRole('button', { name: 'Use one writer to write this guide.' }),
  ).toHaveCount(0);
  await connect.click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  // Settings open over the same screen.
  await expect(page).toHaveURL(
    (url) => url.pathname === '/corrals/new/edit' && url.searchParams.get('settings') === 'models',
  );
  // Settings tells open screens that the models changed; the same event follows this sign-in.
  await signInOpenAI(page);
  await page.evaluate(() => window.dispatchEvent(new Event('corral:models-changed')));
  await closeSettings(page);
  await expect(page).toHaveURL((url) => url.pathname === '/corrals/new/edit');
  await expect(
    assistant.getByRole('textbox', { name: 'Request to build the team', exact: true }),
  ).toBeVisible();
  await expect(assistant.getByText('Test A', { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

test('observation stays off in a proposal until the person turns it on, and saves with its interval', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const requests = await answerWith(
    page,
    alone({
      name: 'Invitation',
      brief: 'Write the invitation.',
      criteria: ['Name the date and place.'],
    }),
    'One writer can write the invitation.',
  );
  const input = await draftFromGoal(page);
  await expect(page).toHaveURL(
    (url) => url.pathname === '/corrals/new/edit' && url.searchParams.get('assistant') === '1',
  );
  await propose(page, input, 'One writer should write an invitation.');
  await page.getByRole('button', { name: 'Criteria and settings', exact: true }).click();
  const observe = page.getByRole('switch', { name: 'Observe work in progress' });
  await expect(observe).not.toBeChecked();
  await observe.click();
  await expect(observe).toBeChecked();
  await expect(page.getByText(/every 3/)).toContainText('additional model requests');
  await page.getByRole('button', { name: 'Apply to draft', exact: true }).click();
  expect(requests).toHaveLength(1);
  expect(await savedTeams(page)).toHaveLength(0);
  await saveNewTeam(page);
  await page.reload();
  await openFlowGraph(page);
  await page.getByRole('button', { name: 'Outrider · Entire team', exact: true }).click();
  const settings = editorSettings(page);
  await expect(settings.getByRole('checkbox', { name: 'Observe work in progress' })).toBeChecked();
  await expect(
    settings.getByRole('spinbutton', { name: 'Review interval (model requests)' }),
  ).toHaveValue('3');
});
