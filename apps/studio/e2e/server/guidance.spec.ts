import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test.describe('settings guidance', () => {
  test.use({ live: true });
  test('direct settings entry selects one category and retains the current project', async ({
    page,
    corral,
  }) => {
    await corral.open('/projects/default?settings=models');
    const menu = page.getByTestId('settings-sidebar');
    await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(menu.locator('[aria-current="page"]')).toHaveAccessibleName('Models');
    await expect(menu.locator('[data-active="true"]')).toHaveCount(1);
    await expect(menu.getByRole('link', { name: 'Models', exact: true })).toBeFocused();
    await page.screenshot({ path: '/tmp/corral-guidance-settings.png' });
    await menu.getByRole('link', { name: 'Folders & tools', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: 'Applies to project', exact: true }),
    ).toContainText('My project');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('combobox', { name: 'Applies to project', exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: '/tmp/corral-guidance-settings-narrow.png' });
    expect(corral.errors).toEqual([]);
  });
});

test('static loading status appears while the application bundle is pending', async ({
  page,
  corral,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/*.js', async (route) => {
    await ready;
    await route.continue();
  });
  const opening = corral.open('/');
  try {
    await expect(page.getByRole('status').filter({ hasText: 'Corral · Loading' })).toBeVisible();
  } finally {
    release();
  }
  await opening;
  await expect(page.getByRole('status').filter({ hasText: 'Corral · Loading' })).toHaveCount(0);
});

test('server restart explains reconnection while keeping the unsent request', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Keep this unsent draft after reconnection.');
  await corral.restart();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Connect to the local server.' }),
  ).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Keep this unsent draft after reconnection.');
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Connect to the local server.' }),
  ).toBeVisible();
  await expect(page.getByText('Something went wrong:', { exact: false })).toHaveCount(0);
});

test('file setup remains reachable after a request without a working copy', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Add a comment to example.js.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toContainText('Add a comment to example.js.');
  const notice = page.getByTestId('work-folder-notice');
  await expect(notice).toContainText('cannot change files');
  const dismiss = notice.getByRole('button', { name: 'Hide working copy notice', exact: true });
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(notice).toHaveCount(0);
  const setup = page.getByTestId('work-folder-setup');
  await expect(setup).toBeFocused();
  await page.reload();
  await expect(setup).toBeVisible();
  await expect(notice).toHaveCount(0);
  await setup.click();
  await expect(page.getByRole('link', { name: 'Open Folders & tools', exact: true })).toBeVisible();
});

test.describe('no connected models', () => {
  test.use({ live: true, codexLogin: false });
  test('keeps the draft and offers connection and a separate demo', async ({ page, corral }) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await requestBox(page).fill('Do not send without a connection.');
    const banner = page.getByTestId('models-not-ready');
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText('choose another model');
    await expect(banner.getByRole('link', { name: 'Try the simulation demo' })).toHaveAttribute(
      'href',
      '/demo',
    );
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(requestBox(page)).toHaveValue('Do not send without a connection.');
    await page.getByRole('button', { name: 'Connect a model', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Live requests are blocked');
    await page.evaluate(() => localStorage.setItem('corral:locale', 'ko'));
    await page.reload();
    await expect(page.getByTestId('models-not-ready')).toBeVisible();
    await page.getByRole('button', { name: '모델 연결 필요', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('실제 모델 요청은 차단됩니다');
    await corral.open('/projects/default?settings=project-defaults');
    await expect(
      page.getByRole('combobox', { name: '프로젝트 기본값', exact: true }),
    ).toContainText('없음');
    await page.screenshot({ path: '/tmp/corral-followup-select-ko.png' });
  });
});
