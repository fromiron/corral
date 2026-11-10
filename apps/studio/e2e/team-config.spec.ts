import { expect, type Locator, test } from '@playwright/test';
import { openLibrary } from './workbench.ts';

test('opening a template waits for an explicit named copy and cancel leaves no team', async ({
  page,
}) => {
  await page.goto('/');
  // Templates and the saved teams are two views of the library.
  for (let attempt = 0; attempt < 2; attempt++) {
    await openLibrary(page, 'Templates');
    await page
      .getByRole('button', { name: /^Edit a copy of / })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Save a team copy' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await openLibrary(page, 'Teams');
    await expect(page.getByText('No teams yet', { exact: true })).toBeVisible();
  }
  await openLibrary(page, 'Templates');
  await page
    .getByRole('button', { name: /^Edit a copy of / })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Save a team copy' });
  await dialog.getByRole('textbox', { name: 'Team name' }).fill('Research copy');
  await dialog.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'Research copy',
  );
});

test('saved names refresh the breadcrumb and call controls fit two independent teams at 1179px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1179, height: 757 });
  await page.goto('/');
  const projectUrl = page.url();
  const settings = page.getByRole('complementary', { name: 'Settings' });
  /** Every control lies inside the settings sheet, across its width. */
  const inSheet = async (control: Locator) => {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    const box = await control.boundingBox();
    const sheet = await settings.boundingBox();
    expect(box && sheet && box.x >= sheet.x && box.x + box.width <= sheet.x + sheet.width + 1).toBe(
      true,
    );
  };
  for (let team = 1; team <= 2; team++) {
    await page.goto(projectUrl);
    await openLibrary(page, 'Templates');
    await page
      .getByRole('button', { name: /^Edit a copy of / })
      .first()
      .click();
    await page.getByRole('button', { name: 'Save copy and edit' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    const name = `Saved research ${team}`;
    await page.getByRole('button', { name: 'Limits and criteria', exact: true }).click();
    await settings.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(name);
    await page.locator('[data-team-canvas] [data-node="research"]').click();
    const inputs = settings.getByRole('group', { name: 'Inputs', exact: true });
    for (const label of ['Kind', 'From'])
      await inSheet(inputs.getByRole('combobox', { name: label, exact: true }));
    const calls = settings.getByRole('group', { name: 'May call', exact: true });
    const kind = calls.getByRole('combobox', { name: 'Kind', exact: true });
    const target = calls.getByRole('combobox', { name: 'Callable agent', exact: true });
    const add = calls.getByRole('button', { name: 'Add call link', exact: true });
    for (const control of [kind, target, add]) await inSheet(control);
    await calls
      .getByRole('button', { name: /^Remove link/ })
      .first()
      .click();
    await target.click();
    await page.getByRole('option', { name: 'Research Helper', exact: true }).click();
    await add.click();
    await expect(
      calls.getByRole('button', { name: 'Remove link to Research Helper', exact: true }),
    ).toBeVisible();
    await add.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/team-call-${team}.png` });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
});
