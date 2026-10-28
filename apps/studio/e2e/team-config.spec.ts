import { expect, test } from '@playwright/test';

test('opening a template waits for an explicit named copy and cancel leaves no team', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Edit this team' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Save a team copy' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('No teams yet.')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Edit this team' }).first().click();
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
  for (let team = 1; team <= 2; team++) {
    await page.goto(projectUrl);
    await page.getByRole('tab', { name: /^Teams/ }).click();
    await page.getByRole('button', { name: 'Edit this team' }).first().click();
    await page.getByRole('button', { name: 'Save copy and edit' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    const name = `Saved research ${team}`;
    await page.getByRole('textbox', { name: 'Team name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(name);
    await page.locator('.react-flow__node[data-id="research"]').click();
    const inputs = page.getByRole('group', { name: 'Inputs', exact: true });
    const inputKind = await inputs
      .getByRole('combobox', { name: 'Kind', exact: true })
      .boundingBox();
    const inputSource = await inputs
      .getByRole('combobox', { name: 'From', exact: true })
      .boundingBox();
    expect(inputKind && inputSource && inputKind.x + inputKind.width <= inputSource.x).toBe(true);
    const calls = page.getByRole('group', { name: 'May call', exact: true });
    const kind = calls.getByRole('combobox', { name: 'Kind', exact: true });
    const target = calls.getByRole('combobox', { name: 'Callable agent', exact: true });
    const add = calls.getByRole('button', { name: 'Add call link', exact: true });
    await add.scrollIntoViewIfNeeded();
    for (const control of [kind, target, add]) {
      await expect(control).toBeInViewport();
      const box = await control.boundingBox();
      const panel = await page.locator('.editor-inspector').boundingBox();
      expect(
        box && panel && box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1,
      ).toBe(true);
    }
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
