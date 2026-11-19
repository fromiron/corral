import { linearCorral } from '@corral/testkit';
import { openLibraryTeams } from '../workbench.ts';
import { expect, test } from './harness.ts';

for (const [width, height] of [
  [1280, 800],
  [390, 844],
] as const) {
  test(`previews the outgoing branches and cancels cleanly at ${width}px`, async ({
    page,
    corral,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const korean = width === 390;
    const team = linearCorral(['Author', 'Editor', 'Verifier']);
    const branch = team.controlEdges.find((edge) => edge.source === 'Editor');
    if (!branch) throw new Error('fixture needs an outgoing branch');
    branch.source = 'Author';
    if (korean) {
      const names: Record<string, string> = {
        Author: '작성자',
        Editor: '편집자',
        Verifier: '검토자',
      };
      for (const node of team.nodes) node.label = names[node.id] ?? node.label;
    }
    await corral.open('/');
    await openLibraryTeams(page);
    await page.locator('input[type=file]').setInputFiles({
      name: 'branch.corral.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(team)),
    });
    await expect(page).toHaveURL(/\/edit$/);
    if (korean) {
      await page.addInitScript(() => localStorage.setItem('corral:locale', 'ko'));
      await page.reload();
    }
    const canvas = page.locator('[data-team-canvas]');
    const author = canvas.locator('[data-node="Author"]');
    await author.click();
    const palette = page.getByRole('toolbar', { name: korean ? '단계' : 'Steps' });
    await expect(
      palette.getByText(korean ? '작성자 다음에 추가' : 'Add after Author', { exact: true }),
    ).toBeVisible();
    const add = palette.getByRole('button', { name: korean ? '에이전트 추가' : 'Add Agent' });
    const inspector = page.getByRole('complementary', { name: korean ? '설정' : 'Settings' });
    const fields = inspector.locator('div.grid.content-start');
    const priorScroll = await fields.evaluate((el) => {
      el.scrollTop = 64;
      return el.scrollTop;
    });
    if (width === 1280) await add.dragTo(author);
    else await add.click();
    const dialog = page.getByRole('dialog', {
      name: korean ? '연결 미리보기' : 'Preview connections',
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(korean ? '작성자 · 출력 → 편집자 · 입력' : 'Author · out → Editor · in', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByText(korean ? '작성자 · 출력 → 검토자 · 입력' : 'Author · out → Verifier · in', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(author).toHaveAttribute('aria-pressed', 'true');
    await expect(author).toBeFocused();
    expect(await fields.evaluate((el) => el.scrollTop)).toBe(priorScroll);
    await expect(canvas.locator('[data-node]')).toHaveCount(4);
    await expect(
      page.getByRole('button', { name: korean ? '저장' : 'Save', exact: true }),
    ).toBeDisabled();
    await add.focus();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: korean ? '적용' : 'Apply' }).click();
    await expect(canvas.locator('[data-node]')).toHaveCount(5);
    await add.focus();
    await page.keyboard.press('Control+z');
    await expect(canvas.locator('[data-node]')).toHaveCount(4);
    expect(corral.errors).toEqual([]);
  });
}
