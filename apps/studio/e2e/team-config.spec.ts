import { expect, type Locator, test } from '@playwright/test';
import {
  openFlowGraph,
  openLibrary,
  openSeatAdvanced,
  savedTeams,
  saveNewTeam,
  saveTemplateCopy,
  teamNode,
} from './workbench.ts';

test('a template can be discarded or saved as a named team without losing its selection or undo history', async ({
  page,
}) => {
  await page.goto('/');
  const editCopy = page.getByRole('link', { name: 'Edit a copy of Research team', exact: true });
  const roster = page.getByRole('list', { name: 'Team composition', exact: true });
  const writer = roster.getByRole('button', { name: 'Writer', exact: true });
  const settings = page.getByRole('complementary', { name: 'Settings' });
  const name = settings.getByRole('textbox', { name: 'Name', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await openLibrary(page, 'Templates');
    await editCopy.click();
    await expect(writer).toBeVisible();
    await expect(save).toBeEnabled();
    const prompt = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept();
    });
    await page.getByTestId('app-sidebar').getByRole('link', { name: 'Library' }).click();
    await prompt;
    await expect(page).toHaveURL(/\/library\/teams$/);
    await expect(page.getByText('No Corrals yet', { exact: true })).toBeVisible();
  }
  await openLibrary(page, 'Templates');
  const templatesUrl = page.url();
  await editCopy.click();
  await roster.getByRole('button', { name: /^Request\b/ }).click();
  await name.fill('Research copy');
  await writer.click();
  await openFlowGraph(page);
  const graph = page.getByRole('tab', { name: 'Flow graph', exact: true });
  const selectedWriter = teamNode(page, 'write');
  await expect(selectedWriter).toHaveAttribute('aria-pressed', 'true');
  await saveNewTeam(page);
  await expect(graph).toHaveAttribute('aria-selected', 'true');
  await expect(selectedWriter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(
    'Research copy',
  );
  await page.getByRole('tab', { name: 'Team composition' }).click();
  await expect(writer).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await roster.getByRole('button', { name: /^Request\b/ }).click();
  await expect(name).toHaveValue('Research team');
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(save).toBeDisabled();
  await page.goBack();
  await expect(page).toHaveURL(templatesUrl);
  await openLibrary(page, 'Teams');
  await expect(savedTeams(page)).toHaveCount(1);
  await expect(savedTeams(page).getByRole('button', { name: 'Research copy' })).toBeVisible();
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
    await saveTemplateCopy(page, 'Research team');
    await openFlowGraph(page);
    const name = `Saved research ${team}`;
    await page.getByRole('button', { name: 'Team settings', exact: true }).click();
    await settings.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Current location' })).toContainText(name);
    await page.locator('[data-team-canvas] [data-node="research"]').click();
    await settings.getByRole('button', { name: 'Other kinds of material', exact: true }).click();
    const inputs = settings.getByRole('group', { name: 'Inputs', exact: true });
    for (const label of ['Kind', 'From'])
      await inSheet(inputs.getByRole('combobox', { name: label, exact: true }));
    await openSeatAdvanced(page);
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
