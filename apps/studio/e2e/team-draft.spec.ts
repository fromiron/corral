import { expect, test } from '@playwright/test';
import { openLibrary } from './workbench.ts';

test('a local security review suggestion has specific roles and a short name before saving', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: 'Draft from a goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draft a team from a goal' });
  const goal =
    'Review a pull request for security issues, then have a second agent double check the findings and write a summary for me to approve';
  await dialog.getByLabel('What should the team do?').fill(goal);
  // The local suggestion says on its own button that it calls no model.
  await expect(dialog.getByRole('button', { name: /^Suggest a team/ })).toContainText(
    'No model call',
  );
  await expect(dialog).not.toContainText('Picks a team shape');
  await dialog.getByRole('button', { name: 'Suggest a team' }).click();
  await expect(dialog.getByLabel('Team name', { exact: true })).toHaveValue('Security PR review');
  await expect(dialog.getByRole('textbox', { name: 'Brief', exact: true })).toHaveValue(goal);
  await expect(dialog.getByLabel('Name of role 1', { exact: true })).toHaveValue(
    'Security reviewer',
  );
  await expect(dialog.getByLabel('Name of role 3', { exact: true })).toHaveValue(
    'Independent verifier',
  );
  await dialog.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
  // The editor names the team in its title; the name is edited in the team's settings.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Security PR review', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('application', { name: 'Team graph' })).toContainText(
    'Security reviewer',
  );
});
