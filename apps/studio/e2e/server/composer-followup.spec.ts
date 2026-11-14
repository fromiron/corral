import { requestBox, slash, stopRun } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('saved requests with a stale instruction draft', () => {
  let reply = Promise.resolve();
  let release = () => {};
  const hold = () => {
    reply = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  test.use({ agentReply: { reply: () => 'Saved request response', beforeReply: () => reply } });
  for (const path of ['retry', 'queue', 'auto'] as const) {
    test(`${path} starts its saved request and preserves the stale draft`, async ({
      page,
      corral,
    }) => {
      hold();
      try {
        await corral.open('/');
        await page.getByRole('button', { name: 'New conversation', exact: true }).click();
        const box = requestBox(page);
        await box.fill('Original request');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('running');
        const first = corral.server.coordinator.listRuns()[0];
        if (!first) throw new Error('First run missing');
        // A next request (Alt+Enter) sent while the run works waits behind it. The server starts
        // it when the run ends unless the session's auto start is off.
        await expect(page.locator('[data-slot="composer-keys"]')).toContainText('Next');
        await box.fill('Saved queued request');
        await box.press('Alt+Enter');
        await expect(page.getByRole('button', { name: 'Start now', exact: true })).toBeVisible();
        if (path !== 'auto')
          await page
            .getByRole('switch', {
              name: 'Start the next queued task when the run ends',
              exact: true,
            })
            .click();
        await slash(page, 'steer');
        await expect(page.getByTestId('composer-destination')).toContainText('· Join');
        await box.fill('Keep this  stale instruction');
        await stopRun(page);
        release();
        hold();
        await expect
          .poll(
            () =>
              corral.server.coordinator.listRuns().find((run) => run.runId === first.runId)?.status,
          )
          .toBe('cancelled');
        await expect(box).toHaveValue('Keep this  stale instruction');
        if (path === 'retry')
          await page.getByRole('button', { name: 'Retry request', exact: true }).click();
        if (path === 'queue')
          await page.getByRole('button', { name: 'Start now', exact: true }).click();
        await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(2);
        await expect(box).toHaveValue('Keep this  stale instruction');
        const sessionId = new URL(page.url()).pathname.split('/').at(-1);
        // `/steer` chose the send once; no target was picked, so the kept draft is not fixed to
        // the ended run's execution (composer-flow.md "합류 대상").
        expect(
          await page.evaluate(
            (id) => JSON.parse(localStorage.getItem(`corral:session-draft:${id}`) ?? '{}').intent,
            sessionId,
          ),
        ).toBeNull();
        expect(corral.errors).toEqual([]);
      } finally {
        release();
      }
    });
  }
});

// Needs a new scenario: once Run #2 succeeds, Run #1's results are released (api-contract.md
// 산출물 본문 수명) and leave the @ menu, so two same-name results no longer come from two runs.
test.fixme('same-name result references stay distinct after reload and deleting one', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const box = requestBox(page);
  for (const [index, text] of ['First result', 'Second result'].entries()) {
    await box.fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(index + 1);
    await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('succeeded');
    await expect(page.getByTestId('composer-destination')).toContainText(
      'new run in this session · next request',
    );
  }
  await box.fill('@notes');
  const results = page.getByRole('listbox', { name: 'References', exact: true });
  await results
    .getByRole('option')
    .filter({ hasText: /notes v1 · Run #2/ })
    .first()
    .click();
  await box.press('End');
  await box.press('Space');
  await box.press('@');
  await results
    .getByRole('option')
    .filter({ hasText: /notes v1 · Run #1/ })
    .first()
    .click();
  const remove = page.getByRole('list', { name: 'References', exact: true }).getByRole('button');
  await expect(remove).toHaveCount(2);
  expect(await remove.nth(0).getAttribute('aria-label')).not.toBe(
    await remove.nth(1).getAttribute('aria-label'),
  );
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  const before = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`corral:session-draft:${id}`) ?? '{}'),
    sessionId,
  );
  await page.reload();
  await expect(remove).toHaveCount(2);
  await remove.nth(0).click();
  await expect(remove).toHaveCount(1);
  const after = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`corral:session-draft:${id}`) ?? '{}'),
    sessionId,
  );
  expect(after.references.map((item: { reference: unknown }) => item.reference)).toEqual([
    before.references[1].reference,
  ]);
  await expect(results).toHaveCount(0);
  let submitted: { references: unknown[] } | undefined;
  await page.route('**/api/v1/runs/auto', async (route) => {
    submitted = route.request().postDataJSON();
    await route.continue();
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => submitted?.references).toEqual([before.references[1].reference]);
  await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(3);
  await expect(remove).toHaveCount(0);
  expect(corral.errors).toEqual([]);
});

for (const locale of ['en', 'ko']) {
  for (const width of [636, 1179, 1440]) {
    test(`live voice tooltip is visible on hover and focus (${locale}, ${width}px)`, async ({
      page,
      corral,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('corral:locale', value), locale);
      await corral.open('/');
      await page
        .getByRole('button', {
          name: locale === 'ko' ? '새 대화' : 'New conversation',
          exact: true,
        })
        .click();
      const label = locale === 'ko' ? '라이브 음성' : 'Live voice';
      const trigger = page.getByRole('button', { name: label, exact: true });
      await trigger.hover();
      await expect(page.getByRole('tooltip')).toHaveText(label);
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await trigger.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('tooltip')).toHaveText(label);
      expect(corral.server.coordinator.listRuns()).toHaveLength(0);
      if (width === 636) await page.screenshot({ path: testInfo.outputPath('voice-tooltip.png') });
    });
  }
}
