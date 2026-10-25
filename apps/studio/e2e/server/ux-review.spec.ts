import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { requestBox, selectSessionTeam } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// Workbench UX review (docs/plans/Workbench-UX-Review-Plan.md): pinpoint checks of the fixes
// that need the local server's persistent runs.

async function session(page: Page, corral: Harness) {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'review.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['writer']))),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'New session', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  // CR-055: these checks run the imported team; the session conversation starts it.
  await selectSessionTeam(page, linearCorral(['writer']).name);
}

test('[TC-UX-02-H] a referenced result keeps its exact version through a reload', async ({
  page,
  corral,
}, testInfo) => {
  await session(page, corral);
  const sendAcrossSettings = async (nextDraft?: string) => {
    let release!: () => void,
      entered!: () => void,
      heldOnce = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route('**/api/v1/runs/auto', async (route) => {
      if (route.request().method() !== 'POST' || heldOnce) return route.fallback();
      heldOnce = true;
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response });
    });
    const finished = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/runs/auto') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await committed;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Shortcuts', exact: true }).click();
    if (nextDraft !== undefined) {
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await requestBox(page).fill(nextDraft);
    }
    release();
    await finished;
    if (nextDraft === undefined)
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(requestBox(page)).toHaveValue(nextDraft ?? '');
    await page.unroute('**/api/v1/runs/auto');
  };
  await requestBox(page).fill('First draft');
  await sendAcrossSettings();
  await expect(
    page.getByTestId('chat-timeline').getByText('Succeeded', { exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  const [first] = corral.server.coordinator.listRuns();
  const version = first?.runId
    ? corral.server.coordinator.getSnapshot(first.runId).projection.output?.artifactVersionIds[0]
    : undefined;
  expect(version).toBeTruthy();

  await requestBox(page).fill('Compare with @');
  const references = page.getByRole('listbox', { name: 'References' });
  await expect(references.getByRole('option').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('references-popup.png') });
  await references.getByRole('group', { name: 'Results' }).getByRole('option').first().click();
  const chips = page.getByRole('list', { name: 'References' });
  await expect(chips.getByRole('listitem')).toHaveCount(1);

  await page.reload();
  await expect(chips.getByRole('listitem')).toHaveCount(1);
  await expect(chips.locator('[data-missing]')).toHaveCount(0);
  await sendAcrossSettings('Keep this newer unsent draft');
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(2);
  const second = corral.server.coordinator.listRuns().find((r) => r.runId !== first?.runId);
  // The reference reached the run as that exact version: its text is in the new brief (CR-016).
  const text = corral.server.coordinator.getArtifactText(first?.runId as string, version as string);
  const brief = corral.server.coordinator.getRunSnapshot(second?.runId as string)?.definition.input
    .brief;
  expect(text).toBeTruthy();
  expect(brief).toContain('References');
  expect(brief).toContain(text as string);
  expect(corral.errors).toEqual([]);
});

test.describe('live models', () => {
  test.use({ live: true });
  test('[TC-UX-04-H] a role whose model is not connected stops the request before it is sent', async ({
    page,
    corral,
  }) => {
    await session(page, corral);
    await requestBox(page).fill('Use the live model');
    // CR-024: with live models possible, a session runs live; it offers no simulated way out.
    await expect(page.getByRole('combobox', { name: 'Run mode' })).toHaveCount(0);
    await expect(page.getByTestId('models-not-ready')).toContainText('model-a');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByTestId('app-sidebar')).toContainText('Connect a model');
    await expect(page.getByRole('button', { name: 'Use simulated agents' })).toHaveCount(0);
    await expect(requestBox(page)).toHaveValue('Use the live model');
    // /model shows each role's model and that it needs a sign-in.
    await requestBox(page).fill('/model');
    await requestBox(page).press('Enter');
    await expect(page.getByTestId('model-assignments')).toContainText('Sign-in needed');
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
  });
});
