import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true, reasoningApi: true, imageInput: true });

test('[TC-COMPOSER-001-H] attachment inputs survive their menu, the draft and a reload', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Keep my draft');
  await page.getByRole('button', { name: 'Attachments', exact: true }).click({ timeout: 3000 });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Attach text files', exact: true }).click();
  await (await chooser).setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Fixture notes'),
  });
  await expect(page.getByRole('button', { name: 'Remove notes.txt', exact: true })).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Keep my draft');
  // CR-055 §6: the composer has no request options, so no templates to insert.
  await expect(page.getByRole('button', { name: 'Request options', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove notes.txt', exact: true })).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Keep my draft');
});

test('[TC-COMPOSER-001-N] independent choices preserve effort and block conflicting saves or unsupported new requests', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Keep this request');
  const chip = page.getByRole('button', { name: 'Model', exact: true });
  await chip.click({ timeout: 3000 });
  await page.getByRole('menuitem', { name: 'Reasoning effort', exact: true }).hover();
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await expect(chip).toContainText('Low');
  const saved: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/sessions/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    saved.push(route.request().postDataJSON());
    await pending;
    await route.continue();
  });
  await chip.click();
  await page.getByRole('menuitemradio', { name: 'OpenAI · Test B', exact: true }).click();
  await expect(chip).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    auto: { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'low' } },
  });
  release();
  await expect(chip).toBeEnabled();
  await expect(chip).toContainText('Test B · Low');
  await page.unroute('**/api/v1/sessions/*');
  await page.route('**/api/v1/model-profiles', async (route) => {
    const response = await route.fetch();
    const profiles = await response.json();
    await route.fulfill({
      response,
      json: profiles.map((p: { profileId: string }) =>
        p.profileId === 'model-b'
          ? { ...p, reasoningCapabilities: { levels: [], providerDefault: true } }
          : p,
      ),
    });
  });
  await page.reload();
  await expect(chip).toContainText('Test B · Low');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByTestId('reasoning-not-supported')).toBeVisible();
  await chip.click();
  await page.getByRole('menuitemradio', { name: 'OpenAI · Test A', exact: true }).click();
  await expect(chip).toContainText('Test A · Low');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.route('**/api/v1/sessions/*', async (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'REVISION_CONFLICT', message: 'Fixture save conflict' } },
        })
      : route.continue(),
  );
  await chip.click();
  await page.getByRole('menuitemradio', { name: 'OpenAI · Test B', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fixture save conflict' })).toBeVisible();
  await expect(chip).toContainText('Test A · Low');
  await expect(requestBox(page)).toHaveValue('Keep this request');
  await page.setViewportSize({ width: 390, height: 844 });
  await chip.press('Enter');
  const effortMenu = page.getByRole('menuitem', { name: 'Reasoning effort', exact: true });
  await effortMenu.focus();
  await effortMenu.press('ArrowRight');
  await expect(page.getByRole('menuitemradio', { name: 'Low', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
});
