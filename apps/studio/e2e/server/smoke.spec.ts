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
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('button', { name: 'Add Output', exact: true }).click();
  const agent = page.locator('.react-flow__node[data-id="agent_1"]');
  const output = page.locator('.react-flow__node[data-id="output_1"]');
  await agent.locator('[data-handleid="out"]').dragTo(output.locator('[data-handleid="in"]'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  expect(corral.errors).toEqual([]);
});
