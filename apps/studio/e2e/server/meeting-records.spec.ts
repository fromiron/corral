import type { Page } from '@playwright/test';
import { expect, type Harness, test } from './harness.ts';

/** A meeting whose records hold 40 long minutes points, open on a screen of the given size. */
async function openLongRecords(
  page: Page,
  corral: Harness,
  size: { width: number; height: number },
) {
  await corral.open('/');
  const id = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const response = await fetch('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
      body: JSON.stringify({
        projectId: 'default',
        title: 'Reading meeting records',
        meeting: {
          version: 1,
          participants: [
            { participantId: 'p1', name: 'Reader', prompt: '', modelProfile: 'model-a' },
            { participantId: 'p2', name: 'Reviewer', prompt: '', modelProfile: 'model-b' },
          ],
          secretary: { modelProfile: 'model-a' },
        },
      }),
    });
    if (!response.ok) throw new Error('Could not create meeting fixture');
    return (await response.json()).session.sessionId as string;
  });
  await page.route(`**/api/v1/sessions/${id}/meeting`, async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    await route.fulfill({
      response,
      json: {
        ...view,
        rounds: [
          {
            roundId: 'reading_round',
            commandId: 'reading_command',
            kind: 'all',
            message: 'Shall we ship?',
            basedOnRoundId: null,
            rebuttalNo: null,
            participantIds: ['p1', 'p2'],
            createdAt: '2026-01-01T00:00:00.000Z',
            stoppedAt: null,
            active: false,
            answers: ['p1', 'p2'].map((participantId) => ({
              participantId,
              runId: null,
              status: 'answered',
              text: `${participantId} agrees.`,
              detail: null,
              usage: null,
            })),
          },
        ],
        minutes: [
          {
            minutesId: 'reading_minutes',
            roundId: 'reading_round',
            createdAt: '2026-01-01T00:00:00.000Z',
            error: null,
            document: {
              issues: Array.from(
                { length: 40 },
                (_, index) =>
                  `Discussion point ${index + 1}: a longer explanation that needs space to read.`,
              ),
              claims: [],
              agreements: [],
              remainingDissent: [],
              unverifiedFacts: [],
              candidates: [],
            },
          },
        ],
      },
    });
  });
  await page.setViewportSize(size);
  await page.goto(`${corral.server.url}/sessions/${id}`);
  await page.getByRole('button', { name: 'Minutes, plan and handoff', exact: true }).click();
}

// Records widen only beside the conversation on a wide screen (workbench.md, 회의 화면).
test('expanded meeting records stay scrollable with the composer reachable', async ({
  page,
  corral,
}) => {
  await openLongRecords(page, corral, { width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Expand records', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toBeHidden();
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByRole('button', { name: 'Compact records', exact: true })).toBeInViewport();
  const last = page.getByText(
    'Discussion point 40: a longer explanation that needs space to read.',
  );
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(composer).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({ path: test.info().outputPath('meeting-records-expanded.png') });
  await page.getByRole('button', { name: 'Compact records', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toBeVisible();
  expect(corral.errors).toEqual([]);
});

// Below 1024px the records are a drawer over the conversation with no side to widen into.
test('meeting records open as a drawer on a narrow screen and leave the send button reachable', async ({
  page,
  corral,
}) => {
  await openLongRecords(page, corral, { width: 390, height: 844 });
  const drawer = page.getByRole('dialog', { name: 'Minutes, plan and handoff', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Expand records', exact: true })).toHaveCount(0);
  const last = drawer.getByText(
    'Discussion point 40: a longer explanation that needs space to read.',
  );
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(drawer.getByRole('button', { name: 'Close records', exact: true })).toBeInViewport();
  await drawer.getByRole('button', { name: 'Close records', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('chat-timeline')).toBeVisible();
  await page
    .getByTestId('chat-composer')
    .getByRole('textbox')
    .first()
    .fill('A draft to send\nwith a second line\nand a third\nand a fourth');
  const send = page.getByTestId('chat-composer').getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled();
  await expect(page.getByTestId('chat-composer')).toBeInViewport({ ratio: 1 });
  await expect(send).toBeInViewport({ ratio: 1 });
  await send.click({ trial: true });
  await page.screenshot({ path: test.info().outputPath('meeting-records-compact.png') });
  expect(corral.errors).toEqual([]);
});
