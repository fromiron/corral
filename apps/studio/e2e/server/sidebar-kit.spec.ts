import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './harness.ts';

const preferencesKey = 'corral:workbench:v1';

async function savedSidebar(page: Page) {
  return page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { width: saved.sidebarWidth, open: saved.sidebarOpen };
  }, preferencesKey);
}

async function dragRail(page: Page, rail: Locator, distance: number) {
  // Hover waits for the source shell's width animation before measuring the rail.
  await rail.hover();
  const box = await rail.boundingBox();
  if (!box) throw new Error('Missing sidebar resize rail');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 12 });
  await page.mouse.up();
}

test('source sidebar rail persists keyboard and pointer width changes and click collapse', async ({
  page,
  corral,
}) => {
  await corral.open('/projects');
  const rail = page.getByRole('separator', { name: 'Sidebar width', exact: true });
  await expect(rail).toHaveAttribute('aria-valuemin', '220');
  await expect(rail).toHaveAttribute('aria-valuemax', '420');
  await expect(rail).toHaveAttribute('aria-valuenow', '256');
  await rail.focus();
  await rail.press('ArrowRight');
  await expect(rail).toHaveAttribute('aria-valuenow', '272');
  await expect.poll(() => savedSidebar(page)).toEqual({ width: 272, open: true });

  await dragRail(page, rail, 240);
  await expect(rail).toHaveAttribute('aria-valuenow', '420');
  await expect.poll(() => savedSidebar(page)).toEqual({ width: 420, open: true });
  await page.reload();
  await expect(rail).toHaveAttribute('aria-valuenow', '420');
  await rail.press('ArrowRight');
  await expect(rail).toHaveAttribute('aria-valuenow', '420');

  await dragRail(page, rail, -200);
  await expect(rail).toHaveAttribute('aria-valuenow', '220');
  await rail.press('ArrowLeft');
  await expect(rail).toHaveAttribute('aria-valuenow', '220');
  await expect.poll(() => savedSidebar(page)).toEqual({ width: 220, open: true });
  await page.reload();
  await expect(rail).toHaveAttribute('aria-valuenow', '220');

  await rail.click();
  await expect.poll(() => savedSidebar(page)).toEqual({ width: 220, open: false });
  await page.reload();
  const show = page.getByRole('button', { name: 'Show the sidebar', exact: true });
  await expect(show).toBeVisible();
  await show.click();
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute('aria-valuenow', '220');
  await expect.poll(() => savedSidebar(page)).toEqual({ width: 220, open: true });
  expect(corral.errors).toEqual([]);
});

test('500 conversations retain source project hierarchy and offscreen keyboard navigation', async ({
  page,
  corral,
}) => {
  await corral.open('/projects');
  // Like workbench-measure.spec.ts, seed only the generated test workspace in one
  // transaction. The real API's write-rate limit stays enabled for normal clients.
  const require = createRequire(
    join(import.meta.dirname, '..', '..', '..', 'server', 'package.json'),
  );
  const Database = require('better-sqlite3');
  const db = new Database(join(corral.workspace, '.corral', 'corral.db'));
  const createdAt = '2026-11-01T00:00:00.000Z';
  try {
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision,
          created_at, updated_at, archived_at, entries_json)
         VALUES (?, 'default', NULL, ?, '', ?, 1, ?, ?, NULL, '[]')`,
      );
      for (let index = 0; index < 500; index++) {
        insert.run(
          `session_sidebar_${index}`,
          index === 123 ? 'Pinned conversation' : `Conversation ${index}`,
          index === 123 ? 1 : 0,
          createdAt,
          new Date(Date.parse(createdAt) - index * 1000).toISOString(),
        );
      }
    })();
  } finally {
    db.close();
  }
  await page.reload();
  const sidebar = page.getByTestId('app-sidebar');
  const conversations = sidebar.locator('a[href^="/sessions/"]');
  const project = sidebar.getByRole('link', { name: 'My project', exact: true });
  await expect(project).toBeVisible();
  await expect(conversations.first()).toContainText('Pinned conversation');
  await expect.poll(() => conversations.count()).toBeGreaterThan(0);
  await expect.poll(() => conversations.count()).toBeLessThan(80);
  expect(
    await conversations.first().evaluate((link) => {
      const submenu = link.closest('[data-sidebar="menu-sub"]');
      return (
        submenu?.tagName === 'UL' &&
        Boolean(
          submenu
            .closest('[data-sidebar="menu-item"]')
            ?.querySelector('a[href="/projects/default"]'),
        )
      );
    }),
  ).toBe(true);

  await page.screenshot({ path: test.info().outputPath('sidebar-kit-overview.png') });
  const last = sidebar.locator('a[href="/sessions/session_sidebar_499"]');
  await expect(last).toHaveCount(0);
  const actions = sidebar.getByRole('button', {
    name: 'Actions for Pinned conversation',
    exact: true,
  });
  await actions.focus();
  await actions.press('End');
  await expect(actions).toBeFocused();
  await expect(last).toHaveCount(0);
  await actions.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename session', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await project.focus();
  await project.press('End');
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect.poll(() => conversations.count()).toBeLessThan(80);
  await last.press('Home');
  await expect(project).toBeFocused();
  await expect(project).toBeInViewport({ ratio: 1 });
  await expect(conversations.first()).toContainText('Pinned conversation');
  await page.screenshot({ path: test.info().outputPath('sidebar-kit-hierarchy.png') });
  expect(corral.errors).toEqual([]);
});
