import { expect, type Locator, type Page, test } from '@playwright/test';

// Focus is reached with Tab, never click/focus(), so missing keyboard paths fail the journey.
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    const reverse = await target.evaluate((element) => {
      const active = document.activeElement;
      return (
        active !== document.body &&
        Boolean(
          active && element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
        )
      );
    });
    await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`Tab could not reach ${target}`);
}
async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

const canvas = (page: Page) => page.locator('[data-team-canvas]');
const nodes = (page: Page) => canvas(page).locator('[data-node]');
const edges = (page: Page) => canvas(page).locator('[data-edge]');
const settings = (page: Page) => page.getByRole('complementary', { name: 'Settings' });

test('keyboard alone adds, deletes, undoes, selects, connects, wraps and steers a run', async ({
  page,
}) => {
  // Every focus move is a walk of Tab presses through the page.
  test.slow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/demo?template=starter&delay=2500');
  // Nothing is selected, so the new agent stands on its own and its settings open.
  await activate(page, page.getByRole('button', { name: 'Add Agent', exact: true }));
  await expect(nodes(page)).toHaveCount(3);
  await activate(page, settings(page).getByRole('button', { name: 'Delete', exact: true }));
  await expect(nodes(page)).toHaveCount(2);
  await activate(page, page.getByRole('button', { name: 'Undo', exact: true }));
  await expect(nodes(page)).toHaveCount(3);
  await activate(page, page.getByRole('button', { name: 'Redo', exact: true }));
  await expect(nodes(page)).toHaveCount(2);

  // Arrows move the selection and the focus to the nearest step that way.
  const agent = canvas(page).locator('[data-node="agent_1"]');
  const output = canvas(page).locator('[data-node="output_1"]');
  await activate(page, agent);
  await expect(agent).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(output).toBeFocused();
  await expect(output).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(agent).toBeFocused();

  await activate(
    page,
    settings(page).getByRole('button', { name: 'Remove the connection from Agent 1 to Output' }),
  );
  await expect(edges(page)).toHaveCount(0);
  const connect = settings(page).getByRole('combobox', { name: 'Connect out to…', exact: true });
  await tabTo(page, connect);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(edges(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'No problems', exact: true })).toBeVisible();

  // The editor's commands open from inside it; one wrap is one undo.
  await tabTo(page, agent);
  await page.keyboard.press('Control+k');
  const commands = page.getByRole('dialog', { name: 'Commands' });
  await expect(commands).toBeVisible();
  await page.keyboard.insertText('Wrap in a Loop');
  await page.keyboard.press('Enter');
  await expect(canvas(page).locator('[data-box]')).toHaveCount(1);
  await activate(page, page.getByRole('button', { name: 'Undo', exact: true }));
  await expect(canvas(page).locator('[data-box]')).toHaveCount(0);
  await expect(edges(page)).toHaveCount(1);

  await activate(page, page.getByRole('button', { name: 'Test run', exact: true }));
  const panel = page.getByRole('complementary', { name: 'Test run' });
  await activate(page, panel.getByRole('button', { name: 'Run', exact: true }));
  await activate(page, page.getByRole('button', { name: 'Pause run', exact: true }));
  await expect(page.getByTestId('run-status')).toContainText('Paused', { timeout: 10_000 });
  await tabTo(page, page.getByLabel('Instruction'));
  await page.keyboard.insertText('Keyboard instructions reach the next request.');
  await page.keyboard.press('Enter');
  await activate(page, page.getByRole('button', { name: 'Resume run', exact: true }));
  await expect(page.getByTestId('run-output')).toContainText(
    'Keyboard instructions reach the next request.',
    // Two simulated replies of 2.5 s each, after the pause.
    { timeout: 20_000 },
  );
});

for (const instruction of ['일차 자료만 사용하고 확인하지 못한 내용은 구분해 주세요.']) {
  test(`IME composition Enter does not submit ${instruction.slice(0, 4)}`, async ({ page }) => {
    await page.goto('/demo?template=starter&delay=3000');
    await page.getByRole('button', { name: 'Test run', exact: true }).click();
    await page
      .getByRole('complementary', { name: 'Test run' })
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await page.getByRole('button', { name: 'Pause run', exact: true }).click();
    await expect(page.getByTestId('run-status')).toContainText('Paused', { timeout: 10_000 });
    const input = page.getByLabel('Instruction');
    await input.fill(instruction);
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.dispatchEvent('compositionupdate', { data: instruction });
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      keyCode: 229,
      bubbles: true,
    });
    await expect(input).toHaveValue(instruction);
    await expect(page.getByRole('listitem').filter({ hasText: instruction })).toHaveCount(0);
    await input.dispatchEvent('compositionend', { data: instruction });
    await input.press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: instruction })).toHaveCount(1);
    await page.getByRole('button', { name: 'Resume run', exact: true }).click();
    await expect(page.getByTestId('run-output')).toContainText(instruction, { timeout: 20_000 });
  });
}
