import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { linearCorral } from '@corral/testkit';
import { panelTab } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('runtime continuation', () => {
  test.use({ live: true, codexLogin: true });
  test('continues a failed Run after reload and preserves the source', async ({ page, corral }) => {
    corral.fake!.setResponses([
      fauxAssistantMessage('Stopped before an output.', {
        stopReason: 'error',
        errorMessage: 'Fixture failure',
      }),
    ]);
    await corral.open('/projects');
    const started = await page.evaluate(
      async (definition) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const call = async (path: string, body: unknown) => {
          const response = await fetch(`/api/v1${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
          return response.json();
        };
        const saved = await call('/corrals', {
          definition,
          layout: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} },
        });
        const session = (
          await call('/sessions', {
            projectId: 'default',
            title: 'Recovery fixture',
            corralId: saved.record.corralId,
          })
        ).session;
        const result = await call('/runs', {
          schemaVersion: '0.1',
          commandId: 'start-recovery',
          sessionId: session.sessionId,
          corralId: saved.record.corralId,
          definitionRevision: saved.record.definitionRevision,
          mode: 'live',
        });
        return { sessionId: session.sessionId as string, runId: result.runId as string };
      },
      linearCorral(['writer']),
    );
    await page.goto(
      `${corral.server.url}/sessions/${started.sessionId}?panel=run&run=${started.runId}&view=run`,
    );
    await page.reload();
    const detail = page.getByTestId('run-monitor');
    await detail.getByRole('button', { name: 'Details', exact: true }).click();
    await detail.getByTestId('status-context').locator(':scope > summary').click();
    const recovery = detail.getByTestId('runtime-recovery');
    await expect(
      recovery.getByRole('button', { name: 'Continue in a new Run' }).first(),
    ).toBeEnabled();
    corral.fake!.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(
          'Earlier messages are historical context only',
        );
        return fauxAssistantMessage(
          [fauxToolCall('write_artifact', { text: 'Continued with preserved context.' })],
          { stopReason: 'toolUse' },
        );
      },
      (context) =>
        fauxAssistantMessage(
          [
            fauxToolCall('submit_result', {
              artifactVersionIds: [
                [...JSON.stringify(context.messages).matchAll(/artv_[a-f0-9]{32}/g)].at(-1)?.[0] ??
                  '',
              ],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
    ]);
    await recovery.getByRole('button', { name: 'Continue in a new Run' }).first().click();
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).not.toBe(started.runId);
    await expect(page.getByTestId('run-monitor')).toContainText('Succeeded');
    const source = await page.evaluate(
      async (runId) => (await fetch(`/api/v1/runs/${runId}/runtime-checkpoints`)).json(),
      started.runId,
    );
    expect(source[0].blockers).toContain('already_resumed');
    await panelTab(page, 'Conversation');
    await page
      .getByTestId('chat-timeline')
      .getByRole('button', { name: 'Branch from this message' })
      .first()
      .click();
    const branch = page.getByRole('dialog');
    await expect(branch).toContainText('Continue with the captured context');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await branch.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(
      branch.getByRole('button', { name: 'Start a new session from here' }),
    ).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 800 });
    corral.fake!.answerWith('A separate branch result.');
    await branch.getByRole('button', { name: 'Start a new session from here' }).click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .not.toBe(`/sessions/${started.sessionId}`);
    await expect(page.getByTestId('run-monitor')).toContainText('Succeeded');
    await page
      .getByTestId('run-monitor')
      .getByRole('button', { name: 'Details', exact: true })
      .click();
    await expect(
      page.getByTestId('run-monitor').getByRole('link', { name: 'Open the source Run' }),
    ).toBeVisible();
    await panelTab(page, 'Conversation');
    await page
      .getByTestId('chat-timeline')
      .getByRole('button', { name: 'Branch before this request' })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toContainText('before any model response');
    corral.fake!.answerWith('Original request branch.');
    const priorSession = new URL(page.url()).pathname;
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Start a new session from here' })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(priorSession);
    await expect(page.getByTestId('run-monitor')).toContainText('Succeeded');
    expect(corral.errors).toEqual([]);
  });
});
