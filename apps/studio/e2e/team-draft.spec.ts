import { expect, test } from '@playwright/test';
import { openLibrary } from './workbench.ts';

test('a local security review suggestion has specific roles and a short name before saving', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: 'Draft from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a Corral from a goal' });
  const goal =
    'Review a pull request for security issues, then have a second agent double check the findings and write a summary for me to approve';
  await dialog.getByLabel('What should the team do?').fill(goal);
  // The local suggestion says on its own button that it calls no model.
  await expect(dialog.getByRole('button', { name: /^Suggest a Corral/ })).toContainText(
    'No model call',
  );
  await expect(dialog).not.toContainText('Picks a team shape');
  await dialog.getByRole('button', { name: 'Suggest a Corral' }).click();
  await expect(dialog.getByLabel('Corral name', { exact: true })).toHaveValue('Security PR review');
  await expect(dialog.getByRole('textbox', { name: 'Brief', exact: true })).toHaveValue(goal);
  await expect(dialog.getByLabel('Name of role 1', { exact: true })).toHaveValue(
    'Security reviewer',
  );
  await expect(dialog.getByLabel('Name of role 3', { exact: true })).toHaveValue(
    'Independent verifier',
  );
  // Even a goal that mentions approving gets no approval by default; the person can turn it on.
  await expect(
    dialog.getByRole('switch', { name: 'Ask me to approve the final result', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  // The editor names the team in its title; the name is edited in the team's settings.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Security PR review', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('application', { name: 'Corral graph' })).toContainText(
    'Security reviewer',
  );
});

test('the blank team keeps its request and lets you edit it from the narrow test panel', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Teams');
  await page.getByRole('button', { name: 'New Corral', exact: true }).click();
  const methods = page.getByRole('dialog', { name: 'New Corral' });
  await expect(methods.getByRole('button', { name: 'Draft from a goal' })).toBeVisible();
  await expect(methods.getByRole('button', { name: 'Start from a template' })).toBeVisible();
  await methods.getByRole('button', { name: 'Build a blank team' }).click();
  const form = page.getByRole('dialog', { name: 'Build a blank team' });
  await expect(form.getByRole('button', { name: 'Create and edit' })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Request' }).fill('Compare build logs');
  await form.getByRole('textbox', { name: 'Completion criterion' }).fill('Include timestamps');
  await form.getByRole('button', { name: 'Create and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);

  await page.getByRole('button', { name: 'Add the first agent', exact: true }).click();
  await page
    .getByRole('button', { name: 'Use this result as the final output', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'No problems', exact: true })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Test run', exact: true }).click();
  const run = page.getByRole('complementary', { name: 'Test run', exact: true });
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
  await page.getByRole('button', { name: 'Test run', exact: true }).click();
  await expect(run.getByText('Compare test logs', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
});

test('a local goal draft saves opt-in artifact review as a shared Outrider setting', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Teams');
  await page.getByRole('button', { name: 'New Corral', exact: true }).click();
  await page.getByRole('button', { name: 'Draft from a goal', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a Corral from a goal' });
  await dialog
    .getByLabel('What should the team do?')
    .fill(
      'Let the writer ask for manuscript review when needed. The writer should revise it and submit.',
    );
  await dialog.getByRole('button', { name: 'Suggest a Corral' }).click();
  await expect(dialog.getByText(/Workers can ask the shared Outrider for feedback/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.reload();
  await page.getByRole('button', { name: 'Outrider · Entire team', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Artifact review', exact: true })).toBeChecked();
});
