import assert from 'node:assert/strict';
import { linearCorral } from '@corral/testkit';
import { addCustomAgent, editorSettings, startTestRun, teamNode } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({
  agentReply: {
    reply: (_turn, input) =>
      input.nodeId === 'writer' ? 'Original manuscript.' : 'Edited manuscript.',
  },
});

for (const width of [1280, 390]) {
  test(`output source at ${width}px selects the submitted version while both agents run`, async ({
    page,
    corral,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await corral.open('/');
    const definition = linearCorral(['writer']);
    const { csrfToken } = await (
      await page.request.get(`${corral.server.url}/api/v1/session`)
    ).json();
    const created = await page.request.post(`${corral.server.url}/api/v1/corrals`, {
      headers: { origin: corral.server.url, 'x-corral-csrf': csrfToken },
      data: { definition },
    });
    expect(created.ok()).toBe(true);
    const { record } = await created.json();
    await page.goto(`${corral.server.url}/corrals/${record.corralId}/edit`);
    const output = teamNode(page, 'output');
    await expect(output).toContainText('Result to receive · writer');
    const outline = page.getByRole('complementary', { name: 'Corral structure' });
    await outline.getByRole('button', { name: 'writer', exact: true }).click();
    await addCustomAgent(page);
    const offer = page.getByRole('button', { name: 'Use Agent 1’s result' });
    await expect(offer).toBeInViewport();
    await expect(output).toContainText('Result to receive · writer');
    await page.screenshot({ path: testInfo.outputPath('inserted-producer.png') });
    if (width === 390) await offer.press('Enter');
    else await offer.click();
    await expect(teamNode(page, 'agent_1')).toBeFocused();
    await expect(output).toContainText('Result to receive · Agent 1');

    for (const source of ['agent_1', 'writer']) {
      if (source === 'writer') {
        await outline.getByRole('button', { name: 'Output', exact: true }).click();
        const settings = editorSettings(page);
        const change = settings.getByRole('button', { name: 'Change result source' });
        await change.click();
        await settings.getByRole('combobox', { name: 'Result source for final' }).click();
        await page.getByRole('option', { name: 'writer', exact: true }).press('Enter');
        await settings.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(change).toBeFocused();
        await expect(output).toContainText('Result to receive · writer');
      }
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await page.reload();
      await expect(output).toContainText(
        `Result to receive · ${source === 'writer' ? 'writer' : 'Agent 1'}`,
      );
      const saved = await (
        await page.request.get(`${corral.server.url}/api/v1/corrals/${record.corralId}`)
      ).json();
      expect(
        saved.definition.nodes.find((node: { id: string }) => node.id === 'output').inputBindings,
      ).toEqual([{ name: 'final', kind: 'task_output', sourceNodeId: source }]);
      const panel = await startTestRun(page);
      await expect(panel.getByTestId('run-output')).toContainText(
        source === 'writer' ? 'Original manuscript.' : 'Edited manuscript.',
      );
      const run = corral.server.coordinator.listRuns()[0];
      assert(run);
      const { projection } = corral.server.coordinator.getSnapshot(run.runId);
      const [versionId] = projection.output?.artifactVersionIds ?? [];
      assert(versionId);
      const artifact = projection.artifacts[versionId];
      assert(artifact);
      expect(projection.executions[artifact.authorExecutionId]?.nodeId).toBe(source);
      await expect(
        panel.getByText(`Submitted result · ${source === 'writer' ? 'writer' : 'Agent 1'}`, {
          exact: true,
        }),
      ).toBeVisible();
      await panel
        .getByRole('button', { name: `${artifact.name} v${artifact.version}`, exact: true })
        .click();
      const viewer = panel.getByTestId('artifact-viewer');
      await expect(viewer).toContainText(
        source === 'writer' ? 'Original manuscript.' : 'Edited manuscript.',
      );
      await viewer.getByRole('button', { name: 'Close', exact: true }).click();
      expect(Object.keys(projection.nodeExecutions)).toEqual(
        expect.arrayContaining(['writer', 'agent_1']),
      );
      await panel.getByRole('button', { name: 'Close test panel', exact: true }).click();
      await expect(teamNode(page, 'output')).toContainText('Result to receive');
    }
    await outline.getByRole('button', { name: 'Output', exact: true }).click();
    await expect(
      editorSettings(page).getByRole('button', { name: 'Change result source' }),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('output-source.png') });
    expect(corral.errors).toEqual([]);
  });
}
