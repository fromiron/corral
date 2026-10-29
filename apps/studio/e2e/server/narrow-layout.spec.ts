import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { Locator, Page } from '@playwright/test';
import { expect, type Harness, test } from './harness.ts';

async function reachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      target.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top !== null && (top === node || node.contains(top));
      }),
    )
    .toBe(true);
}

async function fixture(page: Page, corral: Harness) {
  await corral.open('/');
  const { csrfToken } = await (
    await page.request.get(`${corral.server.url}/api/v1/session`)
  ).json();
  const cookie = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const call: typeof fetch = (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', corral.server.url);
    headers.set('cookie', cookie);
    headers.set('x-corral-csrf', csrfToken);
    return fetch(url, { ...init, headers });
  };
  const options = { baseUrl: corral.server.url, fetch: call };
  const repository = new RestCorralRepository(options);
  const workspaces = new WorkspacesApi(options);
  const original = join(corral.workspace, 'fixture');
  mkdirSync(original);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: original },
    );
  git('init', '-q');
  const text = `${Array.from(
    { length: 40 },
    (_, index) => `Line ${index + 1}: layout marker ${index + 1}`,
  ).join('\n')}\n`;
  writeFileSync(join(original, 'README.md'), text);
  writeFileSync(join(original, 'other.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  const binding = await workspaces.bind('default', original);
  await workspaces.configure('default', { trusted: true });
  const created = await repository.createSession({ projectId: 'default', title: 'Layout fixture' });
  assert(created.ok);
  const sessionId = created.session.sessionId;
  await workspaces.createWorktree(sessionId);
  const copy = join(`${corral.workspace}-worktrees`, binding.bindingId, sessionId);
  writeFileSync(join(copy, 'README.md'), text.replace('Line 1:', 'Changed line 1:'));
  writeFileSync(join(copy, 'other.txt'), 'after\n');
  return { sessionId, original, text };
}

for (const width of [390, 636, 967])
  test(`navigation drawer at ${width}px stays in the viewport and closes from its shortcut`, async ({
    page,
    corral,
  }, testInfo) => {
    await corral.open('/');
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const sessionUrl = page.url();
    await page.setViewportSize({ width, height: 757 });
    for (const url of [`${corral.server.url}/projects/default`, sessionUrl]) {
      await page.goto(url);
      const trigger = page
        .getByRole('banner')
        .getByRole('button', { name: 'Show the sidebar', exact: true });
      await trigger.click();
      const drawer = page.getByRole('dialog', { name: 'Show the sidebar', exact: true });
      await expect(drawer).toBeVisible();
      await expect
        .poll(async () => {
          const box = await drawer.boundingBox();
          return (
            box &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= width &&
            box.y + box.height <= 758
          );
        })
        .toBe(true);
      await reachable(drawer.getByRole('button', { name: 'Settings', exact: true }));
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Control+b');
      await expect(drawer).toBeVisible();
      await page.keyboard.press('Control+b');
      await expect(drawer).toBeHidden();
      await page.reload();
      await trigger.click();
      await reachable(drawer.getByRole('button', { name: 'Settings', exact: true }));
      await page.screenshot({
        path: testInfo.outputPath(
          `drawer-${width}-${url === sessionUrl ? 'session' : 'project'}.png`,
        ),
      });
      await page.keyboard.press('Escape');
    }
  });

test('review file choices and expanded original preview remain reachable at narrow widths', async ({
  page,
  corral,
}, testInfo) => {
  const { sessionId, original, text } = await fixture(page, corral);
  await page.setViewportSize({ width: 636, height: 757 });
  await page.goto(`${corral.server.url}/sessions/${sessionId}/review`);
  const files = page.getByRole('navigation', { name: 'Review changes', exact: true });
  const readme = files.getByRole('button', { name: /^README.md/ });
  await reachable(readme);
  await readme.click();
  await reachable(files.getByRole('button', { name: /^other.txt/ }));
  await files.getByRole('button', { name: /^other.txt/ }).click();
  await readme.click();
  const parts = page.getByRole('region', { name: 'Selected changes', exact: true });
  await parts.getByRole('button', { name: 'Select changed parts', exact: true }).click();
  await parts.getByRole('checkbox', { name: /Part 1/ }).check();
  await parts.getByRole('button', { name: 'Preview original-folder changes', exact: true }).click();
  const apply = parts.getByRole('button', { name: 'Approve and apply to original', exact: true });
  for (const width of [967, 1179, 636, 1600]) {
    await page.setViewportSize({ width, height: 757 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await reachable(apply);
      const comments = page.locator('#comments-heading');
      const applyBox = await apply.boundingBox();
      const commentBox = await comments.boundingBox();
      expect(
        applyBox &&
          commentBox &&
          (applyBox.y + applyBox.height <= commentBox.y ||
            applyBox.x + applyBox.width <= commentBox.x),
      ).toBe(true);
      await reachable(comments);
      await reachable(readme);
      await page.screenshot({ path: testInfo.outputPath(`review-${width}-${colorScheme}.png`) });
    }
  }
  expect(readFileSync(join(original, 'README.md'), 'utf8')).toBe(text);
});

test('line navigation reveals the selection above the bottom dock', async ({
  page,
  corral,
}, testInfo) => {
  const { sessionId } = await fixture(page, corral);
  await page.setViewportSize({ width: 1179, height: 757 });
  await page.goto(`${corral.server.url}/sessions/${sessionId}?panel=files`);
  await page.getByRole('button', { name: 'Open README.md', exact: true }).click();
  const editorPanel = page.getByTestId('dock-document-panel');
  await expect(editorPanel.locator('.monaco-editor')).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Terminal', exact: true }).click();
  const expectLine = async (line: number) => {
    const selected = editorPanel.locator('.view-line').filter({ hasText: `Line ${line}:` });
    await expect
      .poll(() =>
        selected.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + 40, box.top + box.height / 2);
          return Boolean(top && (top === node || node.contains(top)));
        }),
      )
      .toBe(true);
  };
  await page.getByRole('tab', { name: 'Files', exact: true }).last().click();
  await page.getByRole('combobox', { name: 'Search mode', exact: true }).click();
  await page.getByRole('option', { name: 'Contents', exact: true }).click();
  for (const line of [7, 9]) {
    await page.getByRole('tab', { name: 'Files', exact: true }).last().click();
    await page
      .getByRole('textbox', { name: 'Find text in files', exact: true })
      .fill(`layout marker ${line}`);
    await page
      .getByTestId('file-panel')
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    await page.getByRole('button', { name: `Open README.md:${line}`, exact: true }).click();
    await expectLine(line);
  }
  for (const line of [7, 9, 35, 2]) {
    await editorPanel
      .getByRole('spinbutton', { name: 'From line', exact: true })
      .fill(String(line));
    await editorPanel.getByRole('spinbutton', { name: 'To line', exact: true }).fill(String(line));
    await editorPanel.getByRole('button', { name: 'Go to lines', exact: true }).click();
    await expectLine(line);
    await expect(
      editorPanel.getByRole('spinbutton', { name: 'From line', exact: true }),
    ).toHaveValue(String(line));
  }
  await page.screenshot({ path: testInfo.outputPath('editor-with-bottom-dock.png') });
  await page.getByRole('button', { name: 'Close pane: Terminal', exact: true }).click();
  await editorPanel.getByRole('spinbutton', { name: 'From line', exact: true }).fill('9');
  await editorPanel.getByRole('spinbutton', { name: 'To line', exact: true }).fill('9');
  await editorPanel.getByRole('button', { name: 'Go to lines', exact: true }).click();
  await expectLine(9);
});

test('filename search keeps the entered filename readable at 636px', async ({
  page,
  corral,
}, testInfo) => {
  const { sessionId } = await fixture(page, corral);
  await page.setViewportSize({ width: 636, height: 757 });
  await page.goto(`${corral.server.url}/sessions/${sessionId}?panel=files`);
  const field = page.getByRole('textbox', { name: 'Filter files', exact: true });
  await field.fill('README.md');
  await expect(page.getByRole('button', { name: 'Open README.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open other.txt', exact: true })).toHaveCount(0);
  await expect.poll(() => field.evaluate((input) => input.scrollLeft)).toBe(0);
  await testInfo.attach('filename-field-size', {
    body: JSON.stringify(await field.boundingBox()),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('filename-search-636.png') });
});
