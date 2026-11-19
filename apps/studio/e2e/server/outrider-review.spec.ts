import { linearCorral } from '@corral/testkit';
import { editorSettings, openLibraryTeams, startTestRun } from '../workbench.ts';
import { expect, test } from './harness.ts';

const opinion = 'Add the picnic location to the invitation.';
const finalText = 'Join our bicycle picnic at the park.';

test.use({
  agentReply: {
    reply: () => 'Plan a bicycle picnic.',
    script: async (input, host) => {
      if (input.assignment.kind === 'question') {
        const answer = await host.invokeTool({
          name: 'reply',
          args: {
            questionId: input.assignment.questionId,
            body: input.inputs.some((i) => i.artifactVersionId)
              ? opinion
              : 'Keep the invitation short.',
          },
        });
        return answer.ok
          ? { outcome: 'succeeded' }
          : { outcome: 'failed', error: answer.error.message };
      }
      const advisor = input.capabilities.askTo[0];
      if (!advisor) return { outcome: 'failed', error: 'Missing consultation target' };
      if (input.nodeId === 'planner') {
        // The default simulated planner asks its enabled target and completes its own work.
        return null;
      }
      const v1 = await host.invokeTool({
        name: 'write_artifact',
        args: { text: 'Join our bicycle picnic.' },
      });
      if (!v1.ok) throw new Error(v1.error.message);
      const response = await host.invokeTool({
        name: 'ask',
        args: {
          targetNodeId: advisor.nodeId,
          body: 'Review my invitation.',
          reviewArtifactVersionId: v1.result.artifactVersionId,
        },
      });
      if (!response.ok) throw new Error(response.error.message);
      const v2 = await host.invokeTool({ name: 'write_artifact', args: { text: finalText } });
      if (!v2.ok) throw new Error(v2.error.message);
      const result = await host.invokeTool({
        name: 'submit_result',
        args: { artifactVersionIds: [v2.result.artifactVersionId] },
      });
      return result.ok
        ? { outcome: 'succeeded' }
        : { outcome: 'failed', error: result.error.message };
    },
  },
});

test('team workers ask one advisor and the writer opens the reviewed final version', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await openLibraryTeams(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'picnic.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(linearCorral(['planner', 'writer']))),
  });
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('button', { name: 'Add shared Outrider', exact: true }).click();
  const settings = editorSettings(page);
  await settings.getByRole('switch', { name: 'Artifact review', exact: true }).click();
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.reload();
  const panel = await startTestRun(page);
  await expect(panel.getByText('Submitted result · writer', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  const reviews = panel.locator('[data-testid^="question-"]').filter({ hasText: opinion });
  await expect(reviews).toHaveCount(1);
  await expect(reviews).toContainText(/review of .*v1/i);
  await expect(reviews).toContainText('writer');
  await expect(
    panel.locator('[data-testid^="question-"]').filter({ hasText: 'planner' }),
  ).toHaveCount(1);
  await panel.getByRole('button', { name: /text v2/i }).click();
  const opened = page.getByTestId('artifact-viewer');
  await expect(opened).toContainText(finalText);
  await expect(opened).toContainText('writer');
  expect(corral.errors).toEqual([]);
});
