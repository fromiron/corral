import { newConversation, openAllProjects, requestBox } from '../workbench.ts';
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
    await expect(page.getByRole('combobox', { name: 'Settings for', exact: true })).toContainText(
      'My project',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('combobox', { name: 'Settings for', exact: true }),
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
  await newConversation(page);
  await requestBox(page).fill('Keep this unsent draft after reconnection.');
  await corral.restart();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Connect to the local server.' }),
  ).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Keep this unsent draft after reconnection.');
  await openAllProjects(page);
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
  await newConversation(page);
  await requestBox(page).fill('Add a comment to example.js.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toContainText('Add a comment to example.js.');
  // One chip in the composer row says it, and nothing above the conversation repeats it.
  const setup = page.getByRole('button', {
    name: 'No working copy · Set up file work',
    exact: true,
  });
  await expect(setup).toHaveText('No working copy');
  await expect(page.getByTestId('chat-timeline')).not.toContainText('No working copy');
  await page.reload();
  await expect(setup).toBeVisible();
  await setup.click();
  await expect(page.getByRole('link', { name: 'Open Folders & tools', exact: true })).toBeVisible();
});

test.describe('no connected models', () => {
  test.use({ live: true, codexLogin: false });
  test('keeps the draft and offers connection and a separate demo', async ({ page, corral }) => {
    await corral.open('/');
    await newConversation(page);
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
    // The sidebar head's connection word is the connection entry point; no card repeats the
    // banner (workbench.md: "모델 미연결의 연결 진입점과 데모·시뮬레이션 표시는 머리의 연결 상태
    // 낱말 하나가 맡고, 같은 사실을 카드나 문장으로 반복하지 않는다").
    const word = page.getByTestId('app-sidebar').getByTestId('sidebar-connection');
    await expect(word).toHaveText('No model');
    await expect(word).toHaveRole('button');
    await expect(word).toHaveAccessibleName('No model: open model settings');
    await expect(page.getByTestId('app-sidebar')).not.toContainText('Live requests are blocked');
    await page.evaluate(() => localStorage.setItem('corral:locale', 'ko'));
    await page.reload();
    await expect(page.getByTestId('models-not-ready')).toBeVisible();
    await expect(word).toHaveText('모델 없음');
    await expect(word).toHaveAccessibleName('모델 없음: 모델 설정 열기');
    await corral.open('/projects/default?settings=project-defaults');
    await expect(
      page.getByRole('combobox', { name: '프로젝트 기본값', exact: true }),
    ).toContainText('없음');
    await page.screenshot({ path: '/tmp/corral-followup-select-ko.png' });
  });
});
