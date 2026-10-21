import { expect, test } from '@playwright/test';

// Korean UI (roadmap UX-A5).

test('[TC-UX-001-H] choosing 한국어 switches the whole UI and survives a reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).click();
  await page.getByRole('option', { name: '한국어', exact: true }).click();
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^세션/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.reload();
  await expect(page.getByRole('tab', { name: /^세션/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('combobox', { name: '언어', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Sessions/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
