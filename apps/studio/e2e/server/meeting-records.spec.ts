import { expect, test } from './harness.ts';

test('expanded meeting records stay scrollable with the composer reachable on a narrow screen', async ({
  page,
  corral,
}) => {
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${corral.server.url}/sessions/${id}`);
  await page.getByText('Minutes, plan and handoff', { exact: true }).click();
  await page.getByRole('button', { name: 'Expand records', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toBeHidden();
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByRole('button', { name: 'Compact records', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('meeting-records-expanded.png') });
  await page.getByRole('button', { name: 'Compact records', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toBeVisible();
  expect(corral.errors).toEqual([]);
});
