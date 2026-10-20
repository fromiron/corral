import type { Locator } from '@playwright/test';
import { closeRequestOptions, openRequestOptions } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true, reasoningApi: true });

async function expectReasoningVisible(chip: Locator, label: string) {
  const bounds = await chip.evaluate((button, label) => {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.textContent?.includes(label)) text = walker.nextNode();
    if (!text) throw new Error('The selected reasoning must appear in the model button');
    const start = text.textContent?.indexOf(label) ?? -1;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + label.length);
    const glyph = range.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    let left = Math.max(0, buttonBounds.left);
    let right = Math.min(window.innerWidth, buttonBounds.right);
    for (
      let parent = text.parentElement;
      parent && parent !== button;
      parent = parent.parentElement
    ) {
      if (!['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowX))
        continue;
      const clip = parent.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    return { glyphLeft: glyph.left, glyphRight: glyph.right, glyphWidth: glyph.width, left, right };
  }, label);
  expect(bounds.glyphWidth).toBeGreaterThan(0);
  expect(bounds.glyphLeft).toBeGreaterThanOrEqual(bounds.left);
  expect(bounds.glyphRight).toBeLessThanOrEqual(bounds.right);
}

test('[TC-UX-005-N] a long model name keeps explicit reasoning visible on a narrow composer', async ({
  page,
  corral,
}, testInfo) => {
  // Only the provider's catalog label is synthetic. Selection, persistence and
  // rendering use the normal chat UI and server without injected session state.
  const model = corral.fake?.live.models.getModel('openai', 'gpt-test-a');
  if (!model) throw new Error('The reasoning-capable provider model must be available');
  const modelName = 'A long model name for complex programming and research tasks';
  model.name = modelName;

  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const chip = page.getByRole('button', { name: 'Model', exact: true });
  await expect(chip).toContainText(modelName);
  await chip.click();
  const reasoning = page.getByRole('menuitem', { name: 'Reasoning effort', exact: true });
  await reasoning.focus();
  await reasoning.press('ArrowRight');
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
  const description = `OpenAI · ${modelName} · High`;
  await expect(chip).toHaveAttribute('title', description);
  await expect(chip).toHaveAttribute('aria-description', description);

  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        new URL(`/api/v1/sessions/${sessionId}`, page.url()).href,
      );
      expect(response.ok()).toBeTruthy();
      return (await response.json()).auto;
    })
    .toMatchObject({ modelProfile: 'model-a', reasoning: { mode: 'fixed', level: 'high' } });
  await page.reload();
  await expect(chip).toHaveAttribute('title', description);

  const screenshot = testInfo.outputPath('long-model-explicit-reasoning.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('long-model-explicit-reasoning', {
    path: screenshot,
    contentType: 'image/png',
  });
  await expectReasoningVisible(chip, 'High');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(corral.errors).toEqual([]);
});

test('[TC-UX-005-N] long reasoning labels and Korean Ultra remain inside the narrow model control', async ({
  page,
  corral,
}, testInfo) => {
  const model = corral.fake?.live.models.getModel('openai', 'gpt-test-a');
  if (!model) throw new Error('The reasoning-capable provider model must be available');
  model.name = 'A long model name for complex programming and research tasks';
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const sessionUrl = page.url();
  await page.setViewportSize({ width: 390, height: 844 });
  const chip = page.getByRole('button', { name: 'Model', exact: true });
  await chip.click();
  const reasoning = page.getByRole('menuitem', { name: 'Reasoning effort', exact: true });
  await reasoning.focus();
  await reasoning.press('ArrowRight');
  const automatic = 'Automatic (local judge)';
  await page.getByRole('menuitemradio', { name: automatic, exact: true }).click();
  await expect(chip).toContainText(automatic);
  await expectReasoningVisible(chip, automatic);

  await openRequestOptions(page);
  await page.getByRole('combobox', { name: 'Quality preset', exact: true }).click();
  await page.getByRole('option', { name: 'Ultra · plan, work and review', exact: true }).click();
  await closeRequestOptions(page);
  await expect(chip).toContainText('Maximum supported reasoning');
  const screenshot = testInfo.outputPath('long-model-ultra.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('long-model-ultra', { path: screenshot, contentType: 'image/png' });
  await expectReasoningVisible(chip, 'Maximum supported reasoning');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: '한국어', exact: true }).click();
  await page.goto(sessionUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  const koreanChip = page.getByRole('button', { name: '모델', exact: true });
  await expect(koreanChip).toContainText('최대 지원 추론');
  const koreanScreenshot = testInfo.outputPath('long-model-ultra-korean.png');
  await page.screenshot({ path: koreanScreenshot });
  await testInfo.attach('long-model-ultra-korean', {
    path: koreanScreenshot,
    contentType: 'image/png',
  });
  await expectReasoningVisible(koreanChip, '최대 지원 추론');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(corral.errors).toEqual([]);
});
