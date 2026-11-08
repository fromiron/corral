import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('conversation smoke', () => {
  test.use({ live: true, codexLogin: true });

  test('a request receives an answer and survives reload', async ({ page, corral }) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    corral.fake?.answerWith('Smoke answer.');
    await requestBox(page).fill('Answer the smoke request.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('chat-timeline')).toContainText('Smoke answer.');
    await page.reload();
    await expect(page.getByTestId('chat-timeline')).toContainText('Smoke answer.');
    expect(corral.errors).toEqual([]);
  });
});

test('canvas handles receive a pointer connection', async ({ page, corral }) => {
  await corral.open('/');
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page.getByRole('button', { name: 'New team', exact: true }).click();
  const canvas = page.locator('[data-team-canvas]');
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  // With nothing selected the output lands on its own, unconnected.
  await canvas.press('Escape');
  await page.getByRole('button', { name: 'Add Output', exact: true }).click();
  await expect(canvas.locator('[data-edge]')).toHaveCount(0);
  await canvas
    .locator('[data-port="agent_1:out"]')
    .dragTo(canvas.locator('[data-node="output_1"]').first());
  await expect(canvas.locator('[data-edge]')).toHaveCount(1);
  expect(corral.errors).toEqual([]);
});
