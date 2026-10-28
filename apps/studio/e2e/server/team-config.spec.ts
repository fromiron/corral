import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
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

test('a saved-team conversation keeps its team name and revision after later edits', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const definition = linearCorral(['writer']);
  definition.name = 'Saved writing team';
  const saved = await call(page, '/corrals', {
    definition,
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
  });
  const record = saved.record;
  const made = await call(page, '/sessions', {
    projectId: 'default',
    title: 'Team provenance',
    corralId: record.corralId,
  });
  await page.goto(`${corral.server.url}/sessions/${made.session.sessionId}`);
  await expect(page.getByRole('banner')).toContainText('Saved writing team · r1');
  await requestBox(page).fill('Describe the writing task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toContainText('Succeeded');
  const runs = await call(page, '/runs', undefined, 'GET');
  const run = runs.find(
    (entry: { sessionId: string }) => entry.sessionId === made.session.sessionId,
  );
  await page.goto(`${corral.server.url}/runs/${run.runId}`);
  await expect(
    page.getByRole('heading', { name: 'Saved writing team · r1', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Team composed for this run · not a saved team')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit team', exact: true })).toBeVisible();
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
          layout: { nodes: record.layout.nodes, viewport: record.layout.viewport },
        }),
      });
      if (!response.ok) throw new Error(`rename failed: ${response.status}`);
    },
    { record },
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Saved writing team · r1', exact: true }),
  ).toBeVisible();
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
      layout: { nodes: { writer: { x: 0, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 } },
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
      await page.getByRole('menuitem', { name: 'Open team design', exact: true }).click();
      await page.locator('.react-flow__node[data-id="writer"]').click();
      await page
        .locator('[data-inspector-node="writer"]')
        .getByRole('textbox', { name: 'Name', exact: true })
        .first()
        .fill(`Writer r${revision}`);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('revisions')).toContainText(`Definition r${revision}`);
      await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
      await expect(page.getByRole('banner')).toContainText(`· r${revision}`);
      await expect(page.getByTestId('models-not-ready')).toContainText(
        `Writer r${revision} (missing-profile)`,
      );
      await expect(page.getByTestId('pre-run')).toContainText(`r${revision}`);
    }
  });
});
