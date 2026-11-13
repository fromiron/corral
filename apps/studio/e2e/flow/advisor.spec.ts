import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { waitForStill } from './probe.ts';

// The conversation's advisor on the tool line (features/advisor.md "두는 곳" 대화, "보이는 곳";
// features/composer-flow.md "튐 없는 본문"): turning it on and off moves neither the tool line nor
// the input, at every width; a request refused for the advisor's model says so on one line, and
// its action opens the advisor control.

/** Where the input and every control on the tool line sit, rounded to the pixel. */
async function toolLine(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-slot="composer-host"]');
    if (!host) return null;
    const place = (node: Element) => {
      const box = node.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height].map((value) => Math.round(value));
    };
    return {
      input: place(host.querySelector('textarea') as Element),
      host: place(host),
      controls: [...host.querySelectorAll('button, [data-slot="composer-keys"]')]
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => [node.getAttribute('aria-label') ?? node.textContent ?? '', ...place(node)]),
    };
  });
}

const advisor = (page: Page) => page.locator('[data-slot="composer-advisor"]');

async function turn(page: Page, state: 'on' | 'off') {
  await advisor(page).click();
  await page.getByRole('switch', { name: 'Advisor' }).click();
  await expect(advisor(page)).toHaveAttribute('data-state', state);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('switch', { name: 'Advisor' })).toHaveCount(0);
}

test.describe("the conversation's advisor", () => {
  test.use({ live: true, codexLogin: true });

  test('turning it on and off moves nothing on the tool line or in the input, at 1280, 760 and 390', async ({
    page,
    corral,
  }) => {
    await corral.open('/projects/default');
    await newConversation(page);
    await requestBox(page).fill('Find why login is slow');
    for (const width of [1280, 760, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(advisor(page)).toBeVisible();
      await waitForStill(page);
      const off = await toolLine(page);
      await turn(page, 'on');
      await waitForStill(page);
      expect(await toolLine(page), `${width}: on`).toEqual(off);
      await turn(page, 'off');
      await waitForStill(page);
      expect(await toolLine(page), `${width}: off`).toEqual(off);
    }
    expect(corral.errors).toEqual([]);
  });

  test("a request refused for the advisor's model says so and opens the advisor", async ({
    page,
    corral,
  }) => {
    corral.fake?.setResponses([async () => fauxAssistantMessage('Done.')]);
    await corral.open('/projects/default');
    await newConversation(page);
    // The advisor's saved model is one this installation no longer has.
    await page.route('**/api/v1/sessions/*', async (route) => {
      const request = route.request();
      const body = request.method() === 'PATCH' ? request.postDataJSON() : null;
      if (!body?.advisor) return route.continue();
      await route.continue({
        postData: JSON.stringify({ ...body, advisor: { modelProfile: 'model-gone' } }),
      });
    });
    await turn(page, 'on');
    await requestBox(page).fill('Find why login is slow');
    await requestBox(page).press('Enter');
    const refusal = page.locator('[data-kind="advisor"]').first();
    await expect(refusal).toBeVisible();
    await expect(
      page.getByText('The advisor’s model could not be prepared.').first(),
    ).toBeVisible();
    expect(corral.server.coordinator.listRuns()).toEqual([]);
    // The message's meta line and the refusal under the input each open the advisor control.
    const actions = page.getByRole('button', { name: 'Change or turn off' });
    await expect(actions).toHaveCount(2);
    for (const index of [0, 1]) {
      await actions.nth(index).click();
      await expect(page.getByRole('switch', { name: 'Advisor' })).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('switch', { name: 'Advisor' })).toHaveCount(0);
    }
    // The refused start's own 422, which the browser logs, and nothing else.
    expect(corral.errors).toEqual([
      'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
    ]);
  });
});
