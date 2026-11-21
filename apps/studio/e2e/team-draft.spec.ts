import { expect, test } from '@playwright/test';
import {
  addAgentAndOutput,
  collapseTeamAssistant,
  editorSettings,
  openLibrary,
  openTestRun,
  saveNewTeam,
} from './workbench.ts';

// Proposals need a model, which the browser demo does not have: those cases run against a
// server in e2e/server/team-draft.spec.ts.
test('the browser demo switches the team request off and sends nothing', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/team-assistant')) calls.push(r.url());
  });
  await page.goto('/');
  await openLibrary(page, 'Templates');
  await page.getByRole('link', { name: 'Draft from a goal' }).click();
  const assistant = page.getByRole('region', { name: 'Build the team with AI', exact: true });
  const off = assistant.getByRole('button', { name: 'Available on the local server', exact: true });
  await expect(off).toBeFocused();
  await expect(off).toHaveAttribute('aria-disabled', 'true');
  await expect(assistant.getByRole('textbox')).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(
    assistant.getByRole('button', { name: 'Use one writer to write this guide.' }),
  ).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/corrals\/new\/edit/);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
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
