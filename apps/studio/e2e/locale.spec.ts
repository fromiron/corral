import { expect, test } from '@playwright/test';

// Korean UI (roadmap UX-A5).

test('[TC-UX-001-H] choosing 한국어 switches the whole UI and survives a reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Language').selectOption('ko');
  await page.getByRole('link', { name: 'Corral 목록', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Corral 목록' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Corral 목록' })).toBeVisible();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByLabel('언어').selectOption('en');
  await page.getByRole('link', { name: 'Corrals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Corrals' })).toBeVisible();
});
