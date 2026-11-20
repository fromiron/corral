import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import {
  closePanel,
  editorSettings,
  maximizePanel,
  requestBox,
  startTestRun,
  teamNode,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

async function call(page: Page, path: string, body?: unknown, method = 'POST') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    },
    { path, body, method },
  );
}

test('click, keyboard and pointer drag make the same next-step connection', async ({
  page,
  corral,
}, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await corral.open('/');
  const { record } = await call(page, '/corrals', {
    definition: linearCorral(['planner', 'writer']),
  });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  const canvas = page.locator('[data-team-canvas]');
  const source = teamNode(page, 'planner');
  const target = teamNode(page, 'output');
  const edges = canvas.locator('[data-edge]');
  const port = canvas.locator('[data-port="planner:out"]');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const pick = canvas.getByRole('button', { name: 'Connect to Output · in', exact: true });
  const cancel = canvas.getByRole('button', { name: 'Cancel connection' });
  await expect(edges).toHaveCount(2);

  await source.click();
  await canvas.getByRole('button', { name: 'Connect next step' }).click();
  await source.click();
  await expect(canvas.getByText('A step cannot lead to itself.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(source).toBeFocused();
  await expect(undo).toBeDisabled();

  await port.click();
  await expect(pick).toHaveAttribute('data-reachable', 'true');
  await expect(page.locator('[data-node-settings] input').first()).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('desktop-connect.png') });
  await target.click();
  await expect(edges).toHaveCount(3);
  await expect(cancel).toBeHidden();
  await undo.click();

  await canvas.getByRole('button', { name: 'Connect next step' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(edges).toHaveCount(3);
  await undo.click();

  const a = await port.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('The graph did not show both ends');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(edges).toHaveCount(3);
  await expect(cancel).toBeHidden();
  await expect(editorSettings(page).getByRole('heading', { name: 'Connections' })).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('panning, palette drop and dragging a loose step into a box still work', async ({
  page,
  corral,
}) => {
  await page.setViewportSize({ width: 1680, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await corral.open('/');
  const { record } = await call(page, '/corrals', { definition: linearCorral(['writer']) });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  const canvas = page.locator('[data-team-canvas]');
  const stage = canvas.locator('[data-graph-stage]');
  const transform = () => stage.evaluate((el) => getComputedStyle(el).transform);
  await expect(teamNode(page, 'writer')).toBeVisible();
  const initial = await transform();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Missing canvas');
  const left = box.x + 45,
    top = box.y + box.height - 110;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + 80, top - 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(initial);
  const palette = page.getByRole('toolbar', { name: 'Steps' });
  for (const kind of ['Agent', 'Loop']) {
    await palette
      .getByRole('button', { name: `Add ${kind}`, exact: true })
      .dragTo(canvas, { targetPosition: { x: 55, y: box.height - 110 } });
  }
  const outline = page.getByRole('complementary', { name: 'Corral structure' });
  const loose = outline.getByRole('button', { name: /^Agent [0-9]+$/ });
  await loose.dragTo(outline.getByRole('button', { name: 'Loop', exact: true }));
  await outline.getByRole('button', { name: 'Collapse Loop' }).click();
  await expect(loose).toBeHidden();
  await outline.getByRole('button', { name: 'Expand Loop' }).click();
  await expect(loose).toBeVisible();
  expect(corral.errors).toEqual([]);
});

for (const entry of ['editor', 'session'] as const) {
  test(`settings opened from a card return focus to its renamed card in the narrow ${entry}`, async ({
    page,
    corral,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await corral.open('/');
    const { record } = await call(page, '/corrals', { definition: linearCorral(['writer']) });
    if (entry === 'session') {
      const { session } = await call(page, '/sessions', {
        projectId: 'default',
        title: 'Writing',
        corralId: record.corralId,
      });
      await page.goto(`${corral.server.url}/sessions/${session.sessionId}`);
      await page.getByRole('banner').getByRole('button', { name: 'Actions for Writing' }).click();
      await page.getByRole('menuitem', { name: 'Open Corral design' }).click();
    } else await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
    const card = teamNode(page, 'writer');
    await card.scrollIntoViewIfNeeded();
    const scroller = page.locator('[data-layout="stacked"]');
    const offset = () => scroller.evaluate((el) => el.scrollTop);
    const before = await offset();
    await card.click();
    await expect.poll(offset).toBe(before);
    await page.getByRole('button', { name: 'Open writer settings' }).click();
    const settings = editorSettings(page);
    const name = settings.getByRole('textbox', { name: 'Name', exact: true }).first();
    await expect(name).toBeFocused();
    await name.fill('Copy editor');
    await page.screenshot({ path: testInfo.outputPath(`${entry}-390-settings.png`) });
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(card).toBeFocused();
    await expect.poll(offset).toBe(before);
    await expect(page.getByRole('button', { name: 'Open Copy editor settings' })).toBeVisible();
    expect(corral.errors).toEqual([]);
  });
}

test('shared Outrider settings survive reload and removal is reversible in the editor', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const { record } = await call(page, '/corrals', {
    definition: linearCorral(['planner', 'writer']),
  });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  const add = page.getByRole('button', { name: 'Add shared Outrider', exact: true });
  await expect(add).toBeVisible();
  await add.click();
  const settings = editorSettings(page);
  const principles = settings.getByRole('textbox', { name: 'Review principles' });
  await principles.fill('Ask for the evidence behind the plan.');
  await settings.getByRole('radio', { name: 'Select workers' }).click();
  await settings.getByRole('checkbox', { name: 'planner', exact: true }).click();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('revisions')).toContainText('Version 2');

  await page.reload();
  const configured = page.getByRole('button', { name: 'Outrider · 1 worker', exact: true });
  await configured.click();
  await expect(principles).toHaveValue('Ask for the evidence behind the plan.');
  await expect(settings.getByRole('checkbox', { name: 'planner', exact: true })).toBeChecked();
  await expect(settings.getByRole('checkbox', { name: 'writer', exact: true })).not.toBeChecked();
  await settings.getByRole('button', { name: 'Remove shared Outrider' }).click();
  await expect(add).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(configured).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(corral.errors).toEqual([]);
});

test('automatic observation can be saved for one worker and switched off independently', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const { record } = await call(page, '/corrals', {
    definition: linearCorral(['planner', 'writer']),
  });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  await page.getByRole('button', { name: 'Add shared Outrider', exact: true }).click();
  const settings = editorSettings(page);
  const toggle = settings.getByRole('checkbox', { name: 'Observe work in progress', exact: true });
  await expect(toggle).not.toBeChecked();
  const requestedReview = settings.getByRole('switch', { name: 'Artifact review', exact: true });
  await requestedReview.click();
  await toggle.click();
  const watched = settings.getByRole('group', { name: 'Workers to observe', exact: true });
  await watched.getByRole('radio', { name: 'Select workers' }).click();
  await watched.getByRole('checkbox', { name: 'writer', exact: true }).click();
  const interval = settings.getByRole('spinbutton', { name: 'Review interval (model requests)' });
  await interval.fill('0');
  await expect(interval).toHaveAttribute('aria-invalid', 'true');
  await expect(settings.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await interval.fill('2');
  await expect(settings.getByText(/additional model requests/i)).toBeVisible();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('revisions')).toContainText(/2/);
  await page.reload();
  const configured = page.getByRole('button', { name: 'Outrider · Entire team', exact: true });
  await configured.click();
  await expect(toggle).toBeChecked();
  await expect(requestedReview).toBeChecked();
  await expect(watched.getByRole('checkbox', { name: 'writer' })).toBeChecked();
  await expect(watched.getByRole('checkbox', { name: 'planner' })).not.toBeChecked();
  await expect(interval).toHaveValue('2');
  await toggle.click();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('revisions')).toContainText(/3/);
  await page.reload();
  await configured.click();
  await expect(toggle).not.toBeChecked();
  await expect(settings.getByRole('radio', { name: 'Entire team' })).toBeChecked();
  await expect(requestedReview).toBeChecked();
});

test('selecting a review target previews that result locally in one press', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const definition = linearCorral(['planner', 'writer']);
  const output = definition.nodes.find((node) => node.type === 'output');
  if (!output) throw new Error('Expected an output on the test team');
  output.inputBindings.push({ kind: 'task_output', name: 'source notes', sourceNodeId: 'planner' });
  const { record } = await call(page, '/corrals', { definition });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/team-assistant')) requests.push(r.url());
  });
  await page.getByRole('button', { name: 'Edit the team with AI' }).click();
  await page.getByRole('button', { name: 'Submit after review passes' }).click();
  const group = page.getByRole('group', {
    name: 'Which result should pass review before submission?',
  });
  const target = group.getByRole('button', { name: /source notes/ });
  await expect(target).toHaveAccessibleDescription('');
  const input = page.getByRole('textbox', { name: 'Request to edit the team' });
  await input.fill('Keep this request for later.');
  await target.click();
  const preview = page.getByRole('region', { name: 'Proposed changes' });
  await expect(preview).toContainText('source notes');
  await expect(preview.getByRole('button', { name: 'Apply to draft' })).toBeEnabled();
  await expect(group).toHaveCount(0);
  // This server has no model: the input took the choice's answer, and is off again after it.
  await expect(input).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('a required output review checks the saved candidate before publishing it', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const definition = linearCorral(['writer']);
  definition.sharedOutrider = {
    modelProfile: 'model-a',
    principles: 'Check the sources.',
    targets: { kind: 'all' },
  };
  const { record } = await call(page, '/corrals', { definition });
  await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
  await teamNode(page, 'output').click();
  const gate = editorSettings(page).getByRole('switch', { name: 'Submit after review passes' });
  await expect(gate).toHaveAccessibleDescription(/writer/);
  await gate.click();
  await expect(gate).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('revisions')).toContainText('Version 2');
  await page.reload();
  await teamNode(page, 'output').click();
  await expect(gate).toBeChecked();
  await startTestRun(page);
  await expect(page.getByTestId('run-output')).toContainText('writer', { timeout: 25_000 });
  expect(corral.errors).toEqual([]);
});

test('pinned harness names survive two revision upgrades and reload without upgrading the binding', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const profile = {
    name: 'Evidence writer',
    policy: 'strict',
    resources: [],
    allowedTools: [],
    startupCommands: [],
  };
  await call(page, '/harness/profiles/pinned', { expectedRevision: 0, profile }, 'PUT');
  for (const revision of [1, 2]) {
    const current = await call(page, '/harness/defaults/project/default', undefined, 'GET');
    await call(
      page,
      '/harness/defaults/project/default',
      { expectedRevision: current.revision, binding: { profileId: 'pinned', revision } },
      'PUT',
    );
    await call(
      page,
      '/harness/profiles/pinned',
      {
        expectedRevision: revision,
        profile: { ...profile, name: `Evidence writer ${revision + 1}` },
      },
      'PUT',
    );
    await page.goto(
      `${corral.server.url}/projects/default?settings=project-defaults&settingsProject=default`,
    );
    const picker = page.getByRole('combobox', { name: 'Project default', exact: true });
    const label = revision === 1 ? 'Evidence writer · r1' : 'Evidence writer 2 · r2';
    await expect(picker).toContainText(label);
    await page.reload();
    await expect(picker).toContainText(label);
    expect(
      (await call(page, '/harness/defaults/project/default', undefined, 'GET')).binding,
    ).toEqual({ profileId: 'pinned', revision });
  }
});

/** The session menu's team line, where the selected saved team names its revision. */
async function teamLine(page: Page, title: string) {
  await page
    .getByRole('banner')
    .getByRole('button', { name: `Actions for ${title}`, exact: true })
    .click();
  return page.getByRole('menuitem', { name: /^Choose a Corral/ });
}

test('a saved-team conversation keeps its team name and revision after later edits', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const definition = linearCorral(['writer']);
  definition.name = 'Saved writing team';
  const saved = await call(page, '/corrals', {
    definition,
  });
  const record = saved.record;
  const made = await call(page, '/sessions', {
    projectId: 'default',
    title: 'Team provenance',
    corralId: record.corralId,
  });
  await page.goto(`${corral.server.url}/sessions/${made.session.sessionId}`);
  await expect(await teamLine(page, 'Team provenance')).toContainText('Saved writing team · r1');
  await page.keyboard.press('Escape');
  await requestBox(page).fill('Describe the writing task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toContainText('Completed');
  const runs = await call(page, '/runs', undefined, 'GET');
  const run = runs.find(
    (entry: { sessionId: string }) => entry.sessionId === made.session.sessionId,
  );
  await page.goto(`${corral.server.url}/runs/${run.runId}`);
  // The run's head names its request; the team and its revision are in Run info
  // (execution-monitor.md: "팀·시작 시각·실행 ID·…·저장 팀 편집 링크·…는 실행 정보의 상세에 둔다").
  const facts = page.getByTestId('run-facts');
  await page.getByRole('button', { name: 'Run info', exact: true }).click();
  await expect(facts).toContainText('Saved writing team · r1');
  await expect(page.getByText('Team composed for this run · not a saved Corral')).toHaveCount(0);
  await expect(facts.getByRole('link', { name: 'Edit Corral', exact: true })).toBeVisible();
  await page.evaluate(
    async ({ record }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1/corrals/${record.corralId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-corral-csrf': csrfToken,
          'if-match': String(record.definitionRevision),
        },
        body: JSON.stringify({
          definition: { ...record.definition, name: 'Renamed after the run' },
        }),
      });
      if (!response.ok) throw new Error(`rename failed: ${response.status}`);
    },
    { record },
  );
  await page.reload();
  if (!(await facts.isVisible()))
    await page.getByRole('button', { name: 'Run info', exact: true }).click();
  await expect(facts).toContainText('Saved writing team · r1');
});

test.describe('saved team roles', () => {
  test.use({ live: true });
  test('two docked saves refresh the composer revision and disconnected role without re-entry', async ({
    page,
    corral,
  }) => {
    await corral.open('/');
    const definition = linearCorral(['writer']);
    definition.roles[0]!.modelProfile = 'missing-profile';
    const saved = await call(page, '/corrals', {
      definition,
    });
    const made = await call(page, '/sessions', {
      projectId: 'default',
      title: 'Role refresh',
      corralId: saved.record.corralId,
    });
    await page.goto(`${corral.server.url}/sessions/${made.session.sessionId}`);
    for (const revision of [2, 3]) {
      await page
        .getByRole('banner')
        .getByRole('button', { name: 'Actions for Role refresh', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'Open Corral design', exact: true }).click();
      // The design opens in the Files tab beside the conversation; maximized, its canvas has the
      // room for the step and the settings sheet side by side.
      await maximizePanel(page);
      await teamNode(page, 'writer').click();
      await editorSettings(page)
        .getByRole('textbox', { name: 'Name', exact: true })
        .first()
        .fill(`Writer r${revision}`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('revisions')).toContainText(`Version ${revision}`);
      await closePanel(page);
      await expect(await teamLine(page, 'Role refresh')).toContainText(`· r${revision}`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('models-not-ready')).toContainText(
        `Writer r${revision} (missing-profile)`,
      );
      await expect(page.getByTestId('pre-run')).toContainText(`r${revision}`);
    }
  });
});
