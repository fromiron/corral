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

test('[TC-UX-001-H] keyboard alone adds, selects, moves, connects, deletes, undoes and steers a run', async ({
  page,
}) => {
  await page.goto('/demo?delay=2500');
  await activate(page, page.getByRole('button', { name: 'Add Agent', exact: true }));
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await activate(page, page.getByRole('button', { name: 'Delete node', exact: true }));
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await activate(page, page.getByRole('button', { name: 'Undo', exact: true }));
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await activate(page, page.getByRole('button', { name: 'Redo', exact: true }));
  await expect(page.locator('.react-flow__node')).toHaveCount(2);

  const agent = page.locator('.react-flow__node[data-id="agent_1"]');
  await activate(page, agent);
  const before = await agent.getAttribute('style');
  await page.keyboard.press('ArrowRight');
  await expect(agent).not.toHaveAttribute('style', before ?? '');
  await activate(page, page.getByRole('button', { name: 'Remove connection to Output' }));
  await tabTo(page, page.getByLabel('From out'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await activate(page, page.getByRole('button', { name: 'Connect', exact: true }));
  await expect(page.getByText('Ready to run.')).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Run', exact: true }));
  await activate(page, page.getByRole('button', { name: 'Pause run', exact: true }));
  await expect(page.getByTestId('run-status')).toContainText('Paused', { timeout: 10_000 });
  await tabTo(page, page.getByLabel('Instruction'));
  await page.keyboard.insertText('Keyboard instructions reach the next request.');
  await page.keyboard.press('Enter');
  await activate(page, page.getByRole('button', { name: 'Resume run', exact: true }));
  await expect(page.getByTestId('run-output')).toContainText(
    'Keyboard instructions reach the next request.',
    { timeout: 10_000 },
  );
});

for (const instruction of [
  '일차 자료만 사용하고 확인하지 못한 내용은 구분해 주세요.',
  '一次資料のみを使い、未確認の内容は区別してください。',
]) {
  test(`[TC-UX-001-N] IME composition Enter does not submit ${instruction.slice(0, 4)}`, async ({
    page,
  }) => {
    await page.goto('/demo?delay=3000');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
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
    await expect(page.getByTestId('run-output')).toContainText(instruction, { timeout: 10_000 });
  });
}

test('[TC-UX-001-H] wide layouts and reduced motion keep the editor controls reachable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/demo');
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await expect(page.getByLabel('Corral name')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
