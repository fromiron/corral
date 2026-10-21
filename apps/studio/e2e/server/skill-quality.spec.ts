import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './harness.ts';

test.use({ agentReply: 'fixture output' });
test('[TC-QEVAL-003-H] [TC-QEVAL-004-H] evaluate, review, retry a lost adoption response and roll back after reload', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/skills');
  const seeded = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`/api/v1/harness${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
      return response.json();
    };
    const make = async (description: string) => {
      const review = await call('/documents/review', {
        kind: 'skill',
        name: 'Writing',
        content: `---\nname: writing\ndescription: ${description}\n---\nAnswer briefly.`,
      });
      const saved = await call('/resources', { reviewId: review.reviewId });
      await call(`/resources/${saved.hash}/trust`, { trusted: true }, 'PUT');
      return { resourceHash: saved.hash, kind: 'skill', entry: saved.skills[0].entry };
    };
    const baseline = await make('Original fixture writer');
    const candidate = await make('Updated fixture writer');
    await call(
      '/profiles/personal',
      {
        expectedRevision: 0,
        profile: {
          name: 'Personal writer',
          policy: 'strict',
          allowedTools: ['read', 'read_artifact', 'write_artifact', 'submit_result'],
          startupCommands: [],
          resources: [{ ...baseline, required: true, skillMode: 'auto' }],
        },
      },
      'PUT',
    );
    await call(
      '/defaults/personal/default',
      { expectedRevision: 0, binding: { profileId: 'personal', revision: 1 } },
      'PUT',
    );
    return { baseline, candidate };
  });
  await page.reload();
  await page.getByRole('button', { name: /Updated fixture writer/ }).click();
  const panel = page.getByTestId('skill-quality');
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  await panel.getByRole('combobox', { name: 'Baseline Skill', exact: true }).click();
  await page
    .getByRole('option', { name: new RegExp(seeded.baseline.resourceHash.slice(0, 7)) })
    .click();
  await panel.getByText('Review changes (1)', { exact: true }).click();
  await panel.getByText('Source · Changed · skills/SKILL.md', { exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Before', exact: true })).toContainText(
    'Original fixture writer',
  );
  await expect(panel.getByRole('region', { name: 'After', exact: true })).toContainText(
    'Updated fixture writer',
  );
  for (let index = 0; index < 2; index++) {
    await panel
      .getByRole('textbox', { name: 'Test request', exact: true })
      .nth(index)
      .fill(index ? 'Calculate 2+2' : 'Write a note');
    await panel
      .getByRole('textbox', { name: 'Expected exact answer', exact: true })
      .nth(index)
      .fill('fixture output');
  }
  await panel.getByRole('button', { name: 'Run evaluation', exact: true }).click();
  await expect(
    panel.getByRole('region', { name: 'Evaluation results' }).getByRole('status'),
  ).toContainText('Evaluation completed · Simulated · 4/4');
  await expect(
    panel.getByRole('button', { name: 'Adopt reviewed Skill', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Apply to', exact: true }).click();
  await page.getByRole('option', { name: 'Personal default', exact: true }).click();
  await panel.getByRole('checkbox').check();
  let loseResponse = true;
  const operationIds: string[] = [];
  await page.route('**/api/v1/harness/skill-quality/adopt', async (route) => {
    operationIds.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (loseResponse) {
      loseResponse = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'STORAGE_UNAVAILABLE', message: 'Injected lost adoption response' },
        }),
      });
    } else await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: 'Adopt reviewed Skill', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Injected lost adoption response');
  await panel.getByRole('button', { name: 'Adopt reviewed Skill', exact: true }).click();
  await expect(
    panel.getByText('Applied to the selected default. Existing runs keep their original version.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(operationIds).toHaveLength(2);
  expect(operationIds[0]).toBe(operationIds[1]);
  const readDefault = () =>
    page.evaluate(async () => (await fetch('/api/v1/harness/defaults/personal/default')).json());
  expect((await readDefault()).binding.revision).toBe(2);
  await page.reload();
  await page.getByRole('button', { name: /Updated fixture writer/ }).click();
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  await panel.getByRole('combobox', { name: 'Apply to', exact: true }).click();
  await page.getByRole('option', { name: 'Personal default', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: 'Roll back this adoption', exact: true }),
  ).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="skill-quality"]').analyze()).violations,
  ).toEqual([]);
  await panel.getByRole('button', { name: 'Roll back this adoption', exact: true }).click();
  await expect.poll(async () => (await readDefault()).binding.revision).toBe(1);
  await expect(
    panel.getByRole('button', { name: 'Roll back this adoption', exact: true }),
  ).toHaveCount(0);
  const saved = await page.evaluate(async (candidate) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    return (
      await fetch('/api/v1/harness/skill-quality/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(candidate),
      })
    ).json();
  }, seeded.candidate);
  expect(saved).toHaveLength(1);
  expect(saved[0].results).toHaveLength(4);
  expect(corral.errors.filter((message) => !message.includes('503'))).toEqual([]);
});
