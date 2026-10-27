import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('file and line references remain independent and Escape clears only an empty command trigger', async ({
  page,
  corral,
}, testInfo) => {
  const original = mkdtempSync(join(tmpdir(), 'corral-e2e-reference-'));
  try {
    execFileSync('git', ['init', '-q', original]);
    writeFileSync(join(original, 'README.md'), 'first\nsecond\nthird\n');
    execFileSync('git', ['add', '.'], { cwd: original });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'Fixture',
      ],
      { cwd: original },
    );
    await corral.open('/');
    await page.setViewportSize({ width: 1262, height: 833 });
    await page.getByRole('tab', { name: /^Project folder/ }).click();
    await page.getByLabel('Folder path on this computer').fill(original);
    await page.getByRole('button', { name: 'Link folder', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Project folder', exact: true })).toContainText(
      'no uncommitted changes',
    );
    await page.getByRole('tab', { name: /^Sessions/ }).click();
    await page.getByRole('button', { name: 'Start chat', exact: true }).click();
    const box = requestBox(page);
    await box.fill('@README');
    await page
      .getByRole('listbox', { name: 'References' })
      .getByRole('option')
      .filter({ hasText: 'README.md' })
      .click();
    await page.getByRole('button', { name: 'Open file viewer', exact: true }).click();
    await page.getByRole('button', { name: 'Open README.md', exact: true }).click();
    await page.getByLabel('To line', { exact: true }).fill('3');
    await page.getByRole('button', { name: 'Reference lines', exact: true }).click();
    await page
      .getByRole('complementary', { name: 'File viewer', exact: true })
      .getByRole('button', { name: 'Close file viewer', exact: true })
      .click();
    const full = page.getByRole('button', { name: 'Remove reference README.md', exact: true });
    const range = page.getByRole('button', {
      name: 'Remove reference README.md:L1-L3',
      exact: true,
    });
    await expect(full).toBeVisible();
    await expect(range).toBeVisible();
    await full.click();
    await expect(range).toBeVisible();
    await expect(box).toHaveValue(/@README\.md:L1-L3/);
    await page.reload();
    await expect(range).toBeVisible();
    await range.click();
    await expect(box).not.toHaveValue(/:L1-L3/);
    await box.fill('/');
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
    await box.press('Escape');
    await expect(box).toHaveValue('');
    await expect(box).toBeFocused();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await box.fill('/typed-command');
    await box.press('Escape');
    await expect(box).toHaveValue('/typed-command');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('composer-destination')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('composer-destination-narrow.png') });
    expect(corral.server.coordinator.listRuns()).toHaveLength(0);
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(original, { recursive: true, force: true });
  }
});

test.describe('viewed and active execution', () => {
  let reply = Promise.resolve();
  let releaseReply = () => {};
  const holdReply = () => {
    reply = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
  };
  test.use({ agentReply: { reply: () => 'Deterministic reply', beforeReply: () => reply } });
  test('shows the historical selection and preserves queue intent when opening the active run', async ({
    page,
    corral,
  }, testInfo) => {
    holdReply();
    try {
      await corral.open('/');
      await page.getByRole('button', { name: 'Start chat', exact: true }).click();
      const box = requestBox(page);
      await box.fill('First request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('running');
      const first = corral.server.coordinator.listRuns()[0];
      if (!first) throw new Error('First run missing');
      await page.getByRole('button', { name: 'Cancel whole run', exact: true }).first().click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
      releaseReply();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
      const sessionUrl = new URL(page.url());
      sessionUrl.searchParams.set('run', first.runId);
      await page.goto(sessionUrl.href);
      holdReply();
      await box.fill('Second request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByTestId('viewed-run-warning')).toContainText(
        'Viewing Run #1 while Run #2 is active',
      );
      await box.fill('Keep this queued request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: next run in this session · queue',
      );
      await page.screenshot({ path: testInfo.outputPath('viewed-run-warning.png') });
      await page.getByRole('button', { name: 'View active run', exact: true }).click();
      await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
      await expect(page.getByTestId('viewed-run-warning')).toHaveCount(0);
      await expect(box).toHaveValue('Keep this queued request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: next run in this session · queue',
      );
      expect(corral.errors).toEqual([]);
    } finally {
      releaseReply();
    }
  });
});
