import {
  addCustomAgent,
  editorSettings,
  newTeam,
  openFlowGraph,
  openLibraryTeams,
  requestBox,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('conversation smoke', () => {
  test.use({ live: true, codexLogin: true });

  test('a request receives an answer and survives reload', async ({ page, corral }) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
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
  await openLibraryTeams(page);
  await newTeam(page);
  await openFlowGraph(page);
  const canvas = page.locator('[data-team-canvas]');
  await addCustomAgent(page);
  await editorSettings(page)
    .getByRole('button', { name: 'Remove the connection from Agent 1 to Output' })
    .click();
  await expect(canvas.locator('[data-edge]')).toHaveCount(0);
  await canvas
    .locator('[data-port="agent_1:out"]')
    .dragTo(canvas.locator('[data-node="output_1"]').first());
  await expect(canvas.locator('[data-edge]')).toHaveCount(1);
  expect(corral.errors).toEqual([]);
});
