import { mkdirSync } from 'node:fs';
import { fauxAssistantMessage } from '@corral/server/testing';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { expect, test } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { waitForStill } from './probe.ts';

// The conversation's advisor on the tool line (features/advisor.md "두는 곳" 대화, "보이는 곳";
// features/composer-flow.md "튐 없는 본문"): turning it on and off moves neither the tool line nor
// the input, at every width; a request refused for the advisor's model says so once, on its
// message's meta line, and that line's action opens the advisor control.

/** Where a run of this scene leaves its screenshots, when one is asked for. */
const SHOTS = process.env.CORRAL_REFUSAL_SHOTS;

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
    const line = page
      .locator('[data-chat-item]')
      .filter({ hasText: 'Find why login is slow' })
      .getByTestId('entry-status');
    await expect(line).toContainText(en.Refusal.advisor);
    expect(corral.server.coordinator.listRuns()).toEqual([]);
    // Said once: on the message's meta line, not again under the input. Assistive tech is told
    // once, from the composer.
    const drawn = (text: string) =>
      page.evaluate(
        (words) =>
          [...document.querySelectorAll('body *')].filter(
            (node) =>
              !node.closest('.sr-only') &&
              [...node.childNodes].some(
                (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() === words,
              ),
          ).length,
        text,
      );
    expect(await drawn(en.Refusal.advisor)).toBe(1);
    await expect(page.getByTestId('refusal')).toHaveCount(0);
    await expect(page.getByTestId('refusal-said')).toHaveText(en.Refusal.advisor);
    const action = page.getByRole('button', { name: en.Refusal.chooseAdvisor });
    await expect(action).toHaveCount(1);
    await expect(line.getByRole('button', { name: en.Refusal.chooseAdvisor })).toHaveCount(1);
    await page.mouse.move(4, 4);
    await waitForStill(page);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      await waitForStill(page);
      await page.screenshot({ path: `${SHOTS}/refused-light.png` });
      await page.emulateMedia({ colorScheme: 'dark' });
      await waitForStill(page);
      await page.screenshot({ path: `${SHOTS}/refused-dark.png` });
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await action.click();
    await expect(page.getByRole('switch', { name: 'Advisor' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('switch', { name: 'Advisor' })).toHaveCount(0);
    // The refused start's own 422, which the browser logs, and nothing else.
    expect(corral.errors).toEqual([
      'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)',
    ]);
  });
});
