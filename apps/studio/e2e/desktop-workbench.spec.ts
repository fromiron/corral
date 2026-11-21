import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  closePanel,
  lastRunSucceeded,
  newConversation,
  openPane,
  openPanelTab,
  panelTabNamed,
  requestBox,
  selectPanelTab,
  showTree,
  startSession,
  teamFromTemplate,
} from './workbench.ts';

async function openSession(page: Page, blank = false) {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  if (blank) {
    await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
    await newConversation(page);
    await expect(requestBox(page)).toHaveValue('');
    await expect(page.getByTestId('chat-timeline').getByRole('article')).toHaveCount(0);
  } else await startSession(page, 'Desktop workbench');
}

test('DW-08 narrow navigation contains focus and Escape restores its trigger', async ({ page }) => {
  await openSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole('button', { name: 'Show the sidebar', exact: true });
  await trigger.click();
  const navigation = page.getByRole('dialog');
  await expect(navigation).toBeVisible();
  await expect(navigation).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        navigation.evaluate((node) =>
          node.contains(document.activeElement) ? 'inside' : document.activeElement?.outerHTML,
        ),
      )
      .toBe('inside');
  }
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('DW-02/03 settings overlay keeps the same mounted work and draft', async ({ page }) => {
  await openSession(page, true);
  const composer = page.getByTestId('chat-composer');
  const input = requestBox(page);
  await expect(composer).toBeVisible();
  await input.fill(
    Array.from({ length: 30 }, (_, i) => `Requirement ${i}: keep the conversation readable.`).join(
      '\n',
    ),
  );
  await input.press('Control+Enter');
  await expect(lastRunSucceeded(page)).toBeVisible({ timeout: 20_000 });
  await input.fill('Preserve this follow-up draft');
  await openPanelTab(page, 'Runs');
  const workUrl = page.url();
  const originalInput = await input.elementHandle();
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(4, 4));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(page).toHaveURL(/settings=general/);
  await expect(page.getByTestId('app-sidebar')).toHaveCount(1);
  expect(await originalInput?.evaluate((node) => node.isConnected)).toBe(true);
  await settings.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  expect(await originalInput?.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(4);
  await expect(page).toHaveURL(workUrl);
  await expect(panelTabNamed(page, 'Run #1')).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveValue('Preserve this follow-up draft');
  expect(
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((finding) => finding.impact === 'serious' || finding.impact === 'critical')
      .map((finding) => ({
        id: finding.id,
        nodes: finding.nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      })),
  ).toEqual([]);
  await closePanel(page);
  const before = await composer.boundingBox();
  await page.getByTestId('chat-timeline').evaluate((node) => {
    node.scrollTop = 0;
  });
  const after = await composer.boundingBox();
  expect(after?.y).toBe(before?.y);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Preserve this follow-up draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('DW-05 a file opens in a remembered preview and its line reference enters the draft', async ({
  page,
}) => {
  const keyWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('same key')) keyWarnings.push(message.text());
  });
  await openSession(page);
  // Without a folder or a run the panel has no toggle; the palette opens the Files tab.
  await openPane(page, 'Files');
  await expect(page.getByText('Link a project source folder to browse files.')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Folders & tools', exact: true }).click();
  await page.getByRole('button', { name: 'Link the example folder', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(panelTabNamed(page, 'Files')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'File content', exact: true })
      .getByText('# Release notes', { exact: true }),
  ).toBeVisible();
  await expect(requestBox(page)).toHaveValue('Desktop workbench');
  await page.getByRole('button', { name: 'More actions for README.md', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reference lines…', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reference lines', exact: true })
    .getByRole('button', { name: 'Reference lines', exact: true })
    .click();
  await expect(requestBox(page)).toHaveValue('@README.md:L1 Desktop workbench');
  await expect(page.getByRole('list', { name: 'References' })).toContainText('README.md:L1');
  await openPanelTab(page, 'Changes');
  // An original-folder file is a read-only 문서 tab of its own, kept while another tab is chosen.
  await selectPanelTab(page, /^README\.md, project source folder$/);
  await expect(page.getByRole('region', { name: 'README.md', exact: true })).toBeVisible();
  // A nested file shows in the tree once its folder is expanded, and opens a tab of its own.
  await showTree(page);
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'version.ts', exact: true }).click();
  await expect(page.getByRole('region', { name: 'src/version.ts', exact: true })).toBeVisible();
  await expect(panelTabNamed(page, /^README\.md, project source folder$/)).toBeVisible();
  await closePanel(page);
  const request = requestBox(page);
  await request.fill('@version');
  await expect(page.getByRole('listbox', { name: 'References' })).toBeVisible();
  await request.press('Enter');
  await expect(request).toHaveValue('@src/version.ts ');
  await request.fill('@src');
  await expect(page.getByRole('option', { name: /^src\/?$/ }).first()).toBeVisible();
  await expect(page.getByTestId('chat-timeline').getByRole('article')).toHaveCount(0);
  expect(keyWarnings).toEqual([]);
});
