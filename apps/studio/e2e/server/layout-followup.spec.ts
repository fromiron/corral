import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

async function copyFixture(
  page: import('@playwright/test').Page,
  corral: import('./harness.ts').Harness,
) {
  const original = join(corral.workspace, 'fixture');
  mkdirSync(original);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: original },
    );
  git('init', '-q');
  writeFileSync(join(original, 'README.md'), 'layout fixture\n');
  writeFileSync(join(original, 'other.txt'), 'other fixture\n');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  await corral.open('/');
  return page.evaluate(async (path) => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, method: string, body: unknown) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Fixture setup: ${response.status}`);
      return response.json();
    };
    await call('/projects/default/workspace', 'PUT', { path });
    await call('/projects/default/workspace', 'PATCH', { trusted: true });
    const made = await call('/sessions', 'POST', {
      projectId: 'default',
      title: 'Layout followup',
    });
    await call(`/sessions/${made.session.sessionId}/worktree`, 'POST', {});
    return made.session.sessionId as string;
  }, original);
}

for (const locale of ['en', 'ko'] as const) {
  const messages = locale === 'en' ? en : ko;
  test(`drawer Escape and icon tooltips work in ${locale}`, async ({ page, corral }) => {
    await page.addInitScript((locale) => localStorage.setItem('corral:locale', locale), locale);
    const sessionId = await copyFixture(page, corral);
    await page.setViewportSize({ width: 636, height: 757 });
    await page.goto(`${corral.server.url}/sessions/${sessionId}`);
    const trigger = page
      .getByRole('banner')
      .getByRole('button', { name: messages.Workbench.expandSidebar, exact: true });
    await trigger.hover();
    await expect(
      page.getByRole('tooltip', { name: new RegExp(messages.Workbench.expandSidebar) }),
    ).toBeVisible();
    await trigger.click();
    const drawer = page.getByRole('dialog', {
      name: messages.Workbench.expandSidebar,
      exact: true,
    });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await drawer
      .getByRole('button', { name: messages.Workbench.collapseSidebar, exact: true })
      .hover();
    await expect(
      page.getByRole('tooltip', { name: new RegExp(messages.Workbench.collapseSidebar) }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    const filter = drawer.getByRole('searchbox');
    await filter.focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 1179, height: 757 });
    const sidebar = page.getByTestId('app-sidebar');
    const actions = sidebar.getByRole('button', {
      name: messages.Desktop.sessionActions.replace('{title}', 'Layout followup'),
      exact: true,
    });
    const collapse = sidebar.getByRole('button', {
      name: messages.Desktop.toggleProject.replace('{name}', messages.Projects.defaultName),
      exact: true,
    });
    await page.goto(`${corral.server.url}/sessions/${sessionId}?panel=files`);
    await page
      .getByRole('button', {
        name: messages.Desktop.openFile.replace('{path}', 'README.md'),
        exact: true,
      })
      .click();
    const close = page.getByRole('button', {
      name: `${messages.Docking.close}: README.md`,
      exact: true,
    });
    const sessionClose = page.getByRole('button', {
      name: messages.SessionTabs.close.replace('{title}', 'Layout followup'),
      exact: true,
    });
    for (const control of [actions, collapse, close, sessionClose]) {
      const name = await control.getAttribute('aria-label');
      await control.hover();
      await expect(page.getByRole('tooltip', { name: name ?? '', exact: true })).toBeVisible();
      await page.mouse.move(700, 700);
      await expect(page.getByRole('tooltip', { name: name ?? '', exact: true })).toBeHidden();
      await control.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(control).toBeFocused();
      await expect(page.getByRole('tooltip', { name: name ?? '', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test(`editor palette is visible without its own scroll in ${locale}`, async ({
    page,
    corral,
  }, testInfo) => {
    await page.addInitScript((locale) => localStorage.setItem('corral:locale', locale), locale);
    await corral.open('/');
    await page.getByRole('tab', { name: new RegExp(`^${messages.Workspace.heading}`) }).click();
    await page.getByRole('button', { name: messages.Workspace.new, exact: true }).click();
    for (const width of [1179, 1440]) {
      await page.setViewportSize({ width, height: width === 1179 ? 757 : 900 });
      await page.screenshot({ path: testInfo.outputPath(`palette-${width}.png`) });
      for (const kind of ['agent', 'decision', 'loop', 'output'] as const) {
        const button = page.getByRole('button', {
          name: messages.Palette.add.replace('{kind}', messages.Palette[kind]),
          exact: true,
        });
        await expect
          .poll(() =>
            button.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              const top = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return top !== null && (top === node || node.contains(top));
            }),
          )
          .toBe(true);
      }
    }
    await page.setViewportSize({ width: 1179, height: 757 });
    await page
      .getByRole('button', {
        name: messages.Palette.add.replace('{kind}', messages.Palette.agent),
        exact: true,
      })
      .click();
    for (let index = 0; index < 5; index++) {
      await page
        .getByRole('button', {
          name: messages.Palette.add.replace('{kind}', messages.Palette.decision),
          exact: true,
        })
        .click();
    }
    await expect(page.getByTestId('diagnostics').locator('li')).toHaveCount(6);
    await expect
      .poll(async () => (await page.locator('.editor-canvas').boundingBox())?.height ?? 0)
      .toBeGreaterThan(100);
    await page
      .locator('[data-palette-item="output"]')
      .dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 400, y: 180 } });
    const agent = page.locator('.react-flow__node[data-id="agent_1"]');
    const output = page.locator('.react-flow__node[data-id="output_1"]');
    await expect(output).toBeVisible();
    await agent.locator('[data-handleid="out"]').dragTo(output.locator('[data-handleid="in"]'));
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath('palette-diagnostics-and-connected-canvas.png'),
    });
    expect(corral.errors).toEqual([]);
  });
}

for (const locale of ['en', 'ko'] as const) {
  const messages = locale === 'en' ? en : ko;
  test(`file search stays usable at 172, 252 and 400px in ${locale}`, async ({
    page,
    corral,
  }, testInfo) => {
    await page.addInitScript((locale) => localStorage.setItem('corral:locale', locale), locale);
    const sessionId = await copyFixture(page, corral);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${corral.server.url}/sessions/${sessionId}?panel=files`);
    await page
      .getByRole('button', {
        name: messages.Desktop.openFile.replace('{path}', 'README.md'),
        exact: true,
      })
      .click();
    await expect(page.getByTestId('dock-document-panel')).toBeVisible();
    await page.getByRole('tab', { name: messages.Docking.files, exact: true }).last().click();
    await expect(page.getByTestId('file-panel')).toBeVisible();
    const group = page
      .locator('.dv-groupview')
      .filter({ has: page.getByRole('tab', { name: messages.Docking.files, exact: true }) });
    await group.getByRole('button', { name: messages.Docking.paneActions, exact: true }).click();
    await page.getByRole('menuitem', { name: messages.Docking.moveTo, exact: true }).hover();
    await page.getByRole('menuitem', { name: messages.Docking.aux, exact: true }).click();
    const panel = page.getByTestId('file-panel');
    const field = panel.getByRole('textbox', { name: messages.Desktop.filterFiles, exact: true });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [172, 252, 400]) {
        const current = await panel.boundingBox();
        const box = await group.boundingBox();
        expect(current && box).toBeTruthy();
        const sashes = await page
          .locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash')
          .evaluateAll((nodes) =>
            nodes
              .map((node) => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              })
              .filter((box) => box.height > 0),
          );
        const sash = sashes.sort(
          (a, b) => Math.abs(a.x - (box?.x ?? 0)) - Math.abs(b.x - (box?.x ?? 0)),
        )[0];
        expect(sash).toBeTruthy();
        if (!sash || !current) throw new Error('Missing pane splitter');
        await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          sash.x + sash.width / 2 + current.width - width,
          sash.y + sash.height / 2,
        );
        await page.mouse.up();
        await expect
          .poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width))
          .toBeLessThan(2);
        await field.fill('README.md');
        await expect.poll(() => field.evaluate((input) => input.scrollLeft)).toBe(0);
        await expect(
          panel.getByRole('button', {
            name: messages.Desktop.openFile.replace('{path}', 'README.md'),
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          panel.getByRole('button', {
            name: messages.Desktop.openFile.replace('{path}', 'other.txt'),
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(field).toBeFocused();
        const longQuery = 'README-with-a-long-editable-search-query.md';
        await field.fill(longQuery);
        await expect(field).toHaveValue(longQuery);
        await field.press('End');
        await expect
          .poll(() => field.evaluate((input: HTMLInputElement) => input.selectionStart))
          .toBe(longQuery.length);
        await field.press('Home');
        await expect.poll(() => field.evaluate((input) => input.scrollLeft)).toBe(0);
        const inputBox = await field.boundingBox();
        const panelBox = await panel.boundingBox();
        if (!inputBox || !panelBox) throw new Error('Missing search field');
        expect(inputBox.x).toBeGreaterThanOrEqual(panelBox.x);
        expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
        await field.fill('README.md');
        await page.screenshot({
          path: testInfo.outputPath(`search-panel-${colorScheme}-${width}.png`),
        });
        await page.reload();
        await expect(panel).toBeVisible();
        await expect
          .poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width))
          .toBeLessThan(2);
        await field.fill('README.md');
        await expect(field).toBeFocused();
        await expect.poll(() => field.evaluate((input) => input.scrollLeft)).toBe(0);
        await expect(
          panel.getByRole('button', {
            name: messages.Desktop.openFile.replace('{path}', 'README.md'),
            exact: true,
          }),
        ).toBeVisible();
        await panel.getByRole('combobox', { name: messages.ContentSearch.mode }).click();
        await page
          .getByRole('option', { name: messages.ContentSearch.contents, exact: true })
          .click();
        const contentQuery = panel.getByRole('textbox', {
          name: messages.ContentSearch.placeholder,
        });
        await contentQuery.fill('layout fixture');
        await expect(contentQuery).toBeFocused();
        await expect.poll(() => contentQuery.evaluate((input) => input.scrollLeft)).toBe(0);
        await contentQuery.press('Enter');
        await expect(
          panel.getByRole('button', {
            name: messages.ContentSearch.open.replace('{path}', 'README.md').replace('{line}', '1'),
            exact: true,
          }),
        ).toBeVisible();
        await panel.getByRole('combobox', { name: messages.ContentSearch.mode }).click();
        await page.getByRole('option', { name: messages.ContentSearch.names, exact: true }).click();
      }
    }
    await page.setViewportSize({ width: 636, height: 757 });
    await field.fill('README.md');
    await expect(field).toBeFocused();
    await expect.poll(() => field.evaluate((input) => input.scrollLeft)).toBe(0);
    expect(corral.errors).toEqual([]);
  });
}

test('observed run labels keep a gap from port names and other labels in both themes', async ({
  page,
  corral,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await corral.open('/');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await requestBox(page).fill('Show delegation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline')).toContainText('Succeeded');
  await page.getByRole('tab', { name: 'Execution history', exact: true }).click();
  const flow = page.locator('.corral-flow').first();
  const observed = flow.locator('.corral-observed-link .react-flow__edge-text');
  await expect(observed.first()).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() =>
        flow.evaluate((root) => {
          const labels = [...root.querySelectorAll('.react-flow__edge-text')];
          const ports = [...root.querySelectorAll('.react-flow__node > span')];
          const cards = [...root.querySelectorAll('.react-flow__node')];
          return labels
            .filter((label) => label.closest('.corral-observed-link'))
            .every((label) => {
              const box = label.getBoundingClientRect();
              return [...cards, ...ports, ...labels.filter((other) => other !== label)].every(
                (other) => {
                  const bounds = other.getBoundingClientRect();
                  return (
                    box.right + 4 <= bounds.left ||
                    bounds.right + 4 <= box.left ||
                    box.bottom + 4 <= bounds.top ||
                    bounds.bottom + 4 <= box.top
                  );
                },
              );
            });
        }),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`run-label-spacing-${colorScheme}.png`) });
  }
  expect(corral.errors).toEqual([]);
});
