import { readFileSync } from 'node:fs';
import { simulatedReply } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, type Harness, test } from './harness.ts';

const messages = (locale: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../packages/react/src/messages/${locale}.json`, import.meta.url),
      'utf8',
    ),
  );
const title = 'Follow-up meeting';
async function createMeeting(page: Page, corral: Harness) {
  await corral.open('/');
  const id = await page.evaluate(async (name) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        projectId: 'default',
        title: name,
        meeting: {
          version: 1,
          participants: [
            { participantId: 'p1', name: 'Alpha', prompt: '', modelProfile: 'model-a' },
            { participantId: 'p2', name: 'Beta', prompt: '', modelProfile: 'model-b' },
          ],
          secretary: { modelProfile: 'model-a' },
        },
      }),
    });
    if (!response.ok) throw new Error('Could not create meeting fixture');
    return (await response.json()).session.sessionId as string;
  }, title);
  await page.goto(`${corral.server.url}/sessions/${id}`);
  return id;
}
async function state(page: Page, id: string) {
  return (
    await page.request.get(new URL(`/api/v1/sessions/${id}/meeting`, page.url()).href)
  ).json();
}
async function finish(page: Page, id: string, index: number) {
  await expect
    .poll(async () =>
      (await state(page, id)).rounds[index]?.answers.every(
        (answer: { status: string }) => answer.status === 'answered',
      ),
    )
    .toBe(true);
}

for (const locale of ['en', 'ko']) {
  test.describe(`meeting follow-up ${locale}`, () => {
    test.use({ timezoneId: 'Asia/Tokyo', agentReply: { reply: simulatedReply } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((language) => {
        localStorage.setItem('corral:locale', language);
        if (!localStorage.getItem('corral:workbench:v1'))
          localStorage.setItem(
            'corral:workbench:v1',
            JSON.stringify({ version: 1, sendKey: 'mod-enter' }),
          );
      }, locale);
    });
    test('respects send keys and restores an archived meeting from notice, menu and palette', async ({
      page,
      corral,
    }) => {
      const m = messages(locale);
      const id = await createMeeting(page, corral);
      const box = page.getByRole('textbox', { name: m.Meetings.message, exact: true });
      await box.fill('First line');
      await box.press('Enter');
      await expect(box).toHaveValue('First line\n');
      expect((await state(page, id)).rounds).toHaveLength(0);
      await box.press('Control+Enter');
      await finish(page, id, 0);
      await box.fill('Preserve my draft');
      const menu = page.getByRole('banner').getByRole('button', {
        name: m.Desktop.sessionActions.replace('{title}', title),
        exact: true,
      });
      const archive = async () => {
        await menu.click();
        await page.getByRole('menuitem', { name: m.Sessions.archive, exact: true }).click();
      };
      const notice = page.getByText(m.Sessions.archivedSending, { exact: true });
      await archive();
      await expect(notice).toBeVisible();
      await page.reload();
      await expect(notice).toBeVisible();
      await expect(box).toHaveValue('Preserve my draft');
      await page.getByRole('button', { name: m.Sessions.restoreSession, exact: true }).click();
      await expect(notice).toHaveCount(0);
      await archive();
      await menu.click();
      await page.getByRole('menuitem', { name: m.Sessions.restore, exact: true }).click();
      await expect(notice).toHaveCount(0);
      await archive();
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog');
      await palette.getByRole('combobox').fill(m.Commands.restore);
      await palette.getByRole('option').filter({ hasText: m.Commands.restore }).click();
      await expect(notice).toHaveCount(0);
      await expect(
        page.getByTestId('app-sidebar').locator(`a[href="/sessions/${id}?compose=true"]`),
      ).toBeVisible();
      await expect(box).toHaveValue('Preserve my draft');
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem('corral:workbench:v1') ?? '{}');
        localStorage.setItem('corral:workbench:v1', JSON.stringify({ ...saved, sendKey: 'enter' }));
      });
      await page.reload();
      await expect(box).toHaveValue('Preserve my draft');
      await box.press('End');
      await box.press('Shift+Enter');
      await expect(box).toHaveValue('Preserve my draft\n');
      expect((await state(page, id)).rounds).toHaveLength(1);
      await box.press('Enter');
      await finish(page, id, 1);
      await page.screenshot({ path: test.info().outputPath(`meeting-restored-${locale}.png`) });
      expect(corral.errors).toEqual([]);
    });
    test('formats minutes in local time and keeps decision IDs in collapsed copyable details', async ({
      page,
      corral,
    }) => {
      const m = messages(locale);
      const id = await createMeeting(page, corral);
      const box = page.getByRole('textbox', { name: m.Meetings.message, exact: true });
      await box.fill('Discuss a plan');
      await box.press('Control+Enter');
      await finish(page, id, 0);
      await page.getByRole('button', { name: m.Meetings.summarise, exact: true }).click();
      await finish(page, id, 1);
      await page.getByRole('button', { name: m.Meetings.viewMinutes, exact: true }).first().click();
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: corral.server.url });
      const minutes = (await state(page, id)).minutes[0];
      const time = page.locator(`time[datetime="${minutes.createdAt}"]`);
      await expect(time).toHaveText(
        new Intl.DateTimeFormat(locale, {
          dateStyle: 'short',
          timeStyle: 'medium',
          timeZone: 'Asia/Tokyo',
        }).format(new Date(minutes.createdAt)),
      );
      await page
        .getByRole('button', { name: m.MeetingsDecisions.editCandidate, exact: true })
        .click();
      await page.getByRole('button', { name: m.MeetingsDecisions.adopt, exact: true }).click();
      await expect.poll(async () => (await state(page, id)).decisions.length).toBe(1);
      const decision = (await state(page, id)).decisions[0];
      await expect(
        page.getByRole('heading', {
          name: m.MeetingsDecisions.decisionLabel
            .replace('{number}', '1')
            .replace('{goal}', decision.content.goal),
          exact: true,
        }),
      ).toBeVisible();
      const diagnostic = page
        .locator('details')
        .filter({ has: page.locator('pre').filter({ hasText: decision.versionId }) })
        .last();
      await expect(diagnostic).not.toHaveAttribute('open');
      await expect(diagnostic.locator('pre')).not.toBeVisible();
      await diagnostic.locator('summary').click();
      await expect(diagnostic.locator('pre')).toHaveText(decision.versionId);
      await diagnostic
        .getByRole('button', { name: m.Meetings.copyDiagnostics, exact: true })
        .click();
      await expect(
        diagnostic.getByRole('button', { name: m.Meetings.diagnosticsCopied, exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`meeting-decision-${locale}.png`) });
      expect(corral.errors).toEqual([]);
    });
    test.describe('provider failure', () => {
      test.use({
        agentReply: {
          reply: simulatedReply,
          beforeReply: async (_turn, input) => {
            if (input.role.name === 'Secretary') throw new Error('HTTP 500: provider unavailable');
          },
        },
      });
      test('shows the reported cause in diagnostics with a readable localized explanation', async ({
        page,
        corral,
      }) => {
        const m = messages(locale);
        const id = await createMeeting(page, corral);
        const box = page.getByRole('textbox', { name: m.Meetings.message, exact: true });
        await box.fill('Discuss a plan');
        await box.press('Control+Enter');
        await finish(page, id, 0);
        await page.getByRole('button', { name: m.Meetings.summarise, exact: true }).click();
        await expect(
          page.getByText(m.Meetings.requestFailed.replace('{status}', '500'), { exact: true }),
        ).toBeVisible();
        const answer = page.getByRole('article', { name: m.Meetings.secretary, exact: true });
        await expect(answer.locator('details')).not.toHaveAttribute('open');
        await expect(answer.locator('pre')).not.toBeVisible();
        await answer.locator('summary').click();
        await expect(answer.locator('pre')).toContainText('HTTP 500: provider unavailable');
        await expect(
          page.getByRole('button', { name: m.Meetings.retrySummary, exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`meeting-failure-${locale}.png`) });
        expect(corral.errors).toEqual([]);
      });
    });
  });
}
