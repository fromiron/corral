import { closeRequestOptions, openRequestOptions, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('Auto restores an explicit work style and keeps its reviewed revision after a newer revision is saved', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const saveProfile = (revision: number) =>
    page.evaluate(async (revision) => {
      const { csrfToken } = await fetch('/api/v1/session').then((response) => response.json());
      const response = await fetch('/api/v1/harness/profiles/pinned-style', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          expectedRevision: revision,
          profile: {
            name: 'Pinned review',
            policy: 'strict',
            allowedTools: ['write_artifact', 'read_artifact', 'submit_result', 'update_plan'],
            resources: [],
            startupCommands: [],
          },
        }),
      });
      if (!response.ok) throw new Error(`Profile setup failed: ${response.status}`);
    }, revision);
  await saveProfile(0);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await openRequestOptions(page);
  const picker = page.getByRole('combobox', { name: 'Work style for next request', exact: true });
  await picker.click();
  await page.getByRole('option', { name: 'Pinned review · r1', exact: true }).click();
  await closeRequestOptions(page);
  await requestBox(page).fill('Summarize the reviewed work style.');
  await page.reload();
  await openRequestOptions(page);
  await expect(picker).toContainText('Pinned review · r1');
  await closeRequestOptions(page);
  await saveProfile(1);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(1);
  const run = corral.server.coordinator.listRuns()[0];
  if (!run) throw new Error('Auto request did not start');
  const snapshot = corral.server.coordinator.getRunSnapshot(run.runId);
  expect(
    snapshot?.definition.roles.every(
      (role) => role.harness?.profileId === 'pinned-style' && role.harness.revision === 1,
    ),
  ).toBe(true);
  expect(snapshot?.autoRoute?.harness).toEqual({ profileId: 'pinned-style', revision: 1 });
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        new URL(`/api/v1/sessions/${sessionId}`, page.url()).href,
      );
      return (await response.json()).entries[0]?.harness;
    })
    .toEqual({ profileId: 'pinned-style', revision: 1 });
});
