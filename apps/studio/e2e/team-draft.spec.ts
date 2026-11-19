import { expect, type Page, test } from '@playwright/test';
import {
  addAgentAndOutput,
  collapseTeamAssistant,
  editorSettings,
  openFlowGraph,
  openLibrary,
  openTestRun,
  saveNewTeam,
  teamNode,
} from './workbench.ts';

async function propose(page: Page, goal: string) {
  await page.getByRole('textbox', { name: 'Request to build the team', exact: true }).fill(goal);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Local example', { exact: true })).toBeVisible();
}

test('a local security review suggestion has specific roles and a short name before saving', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Templates');
  await page.getByRole('link', { name: 'Draft from a goal' }).click();
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/team-assistant')) calls.push(r.url());
  });
  const goal =
    'Review a pull request for security issues, then have a second agent double check the findings and write a summary for me to approve';
  await propose(page, goal);
  await expect(page.getByText('Security reviewer', { exact: true })).toBeVisible();
  await expect(page.getByText('Independent verifier', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply to draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Security reviewer', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Security PR review', exact: true }),
  ).toBeVisible();
  await saveNewTeam(page);
  await openFlowGraph(page);
  await expect(page.getByRole('application', { name: 'Corral graph' })).toContainText(
    'Security reviewer',
  );
  await teamNode(page, 'output').press('Enter');
  await expect(
    editorSettings(page).getByRole('switch', { name: 'Ask for final approval' }),
  ).not.toBeChecked();
  expect(calls).toEqual([]);
});

test('the blank team keeps its request and lets you edit it from the narrow test panel', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Teams');
  await page.getByRole('link', { name: 'New Corral', exact: true }).click();
  await collapseTeamAssistant(page);
  await page
    .getByRole('list', { name: 'Team composition' })
    .getByRole('button', { name: /^Request\b/ })
    .click();
  const settings = editorSettings(page);
  await settings.getByRole('textbox', { name: 'Brief', exact: true }).fill('Compare build logs');
  await settings.getByRole('textbox', { name: /^Criteria/ }).fill('Include timestamps');
  await addAgentAndOutput(page);
  await saveNewTeam(page);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await page.reload();

  await page.setViewportSize({ width: 390, height: 844 });
  const run = await openTestRun(page);
  await expect(run.getByText('Compare build logs', { exact: true })).toBeVisible();
  await run.getByRole('button', { name: 'Edit request', exact: true }).click();
  const teamSettings = page.getByRole('complementary', { name: 'Settings', exact: true });
  const request = teamSettings.getByRole('textbox', { name: 'Brief', exact: true });
  await expect(request).toBeFocused();
  await expect(request).toHaveValue('Compare build logs');
  await expect(teamSettings.getByRole('textbox', { name: /^Criteria/ })).toHaveValue(
    'Include timestamps',
  );
  await request.fill('Compare test logs');
  await openTestRun(page);
  await expect(run.getByText('Compare test logs', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
});

test('a local goal draft saves opt-in artifact review as a shared Outrider setting', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Teams');
  await page.getByRole('link', { name: 'New Corral', exact: true }).click();
  await propose(
    page,
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

test('a goal requiring review confirms the producer before adding a gate to the saved Output', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Templates');
  await page.getByRole('link', { name: 'Draft from a goal' }).click();
  await propose(page, 'Write a launch note. The result must pass review before submitting.');
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
