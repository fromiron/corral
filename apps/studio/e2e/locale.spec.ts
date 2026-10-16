import { expect, test } from '@playwright/test';

// Korean UI (roadmap UX-A5).

test('[TC-UX-001-H] choosing 한국어 switches the whole UI and survives a reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
  await page.getByLabel('Language').selectOption('ko');
  await expect(page.getByRole('heading', { name: 'Corral 목록' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Corral 목록' })).toBeVisible();
  await page.getByLabel('언어').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
});

test.describe('a Korean browser', () => {
  test.use({ locale: 'ko-KR' });

  test('[TC-UX-001-H] starts in Korean, including the demo and the run controls', async ({
    page,
  }) => {
    await page.goto('/demo?delay=200');
    await expect(page.getByText('데모 / 시뮬레이션 에이전트')).toBeVisible();
    await expect(page.getByRole('region', { name: '데모 안내' })).toBeVisible();
    await page.getByRole('button', { name: '실행', exact: true }).click();
    await expect(page.getByTestId('run-status')).toContainText(/진행 중|결정 대기|성공/);
  });
});
