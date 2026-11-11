import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSettings, openFolderSettings, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('file and line references remain independent and Escape clears only an empty command trigger', async ({
  page,
  corral,
}, testInfo) => {
  const original = mkdtempSync(join(tmpdir(), 'corral-e2e-reference-'));
  try {
    execFileSync('git', ['init', '-q', original]);
    writeFileSync(join(original, 'README.md'), 'first\nsecond\nthird\n');
    writeFileSync(join(original, 'my  notes.md'), 'Keep the two spaces in this filename.\n');
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
    const folder = await openFolderSettings(page);
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder', exact: true }).click();
    await expect(folder).toContainText('no uncommitted changes');
    await closeSettings(page);
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const box = requestBox(page);
    await box.fill('@README');
    await page
      .getByRole('listbox', { name: 'References' })
      .getByRole('option')
      .filter({ hasText: 'README.md' })
      .click();
    await page.getByRole('button', { name: 'Open file viewer', exact: true }).click();
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
    await page.getByRole('button', { name: 'More actions for README.md', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reference lines…', exact: true }).click();
    const reference = page.getByRole('dialog', { name: 'Reference lines', exact: true });
    await reference.getByLabel('To line', { exact: true }).fill('3');
    await reference.getByRole('button', { name: 'Reference lines', exact: true }).click();
    await page
      .getByRole('complementary', { name: 'File viewer', exact: true })
      .getByRole('button', { name: 'Close file viewer', exact: true })
      .click();
    await box.press('End');
    await box.press('Space');
    await box.press('@');
    await page
      .getByRole('listbox', { name: 'References' })
      .getByRole('option')
      .filter({ hasText: 'my  notes.md' })
      .click();
    const prefix = 'a  b\n```ts\n    indented();\n```\nRead ';
    await box.fill(`${prefix}@README.md @README.md:L1-L3 @"my  notes.md"`);
    const full = page.getByRole('button', { name: 'Remove reference README.md', exact: true });
    const range = page.getByRole('button', {
      name: 'Remove reference README.md:L1-L3',
      exact: true,
    });
    await expect(full).toBeVisible();
    await expect(range).toBeVisible();
    await full.click();
    await expect(page.getByRole('listbox', { name: 'References' })).toHaveCount(0);
    await expect(box).toHaveValue(`${prefix}@README.md:L1-L3 @"my  notes.md"`);
    await expect(range).toBeVisible();
    await expect(box).toHaveValue(/@README\.md:L1-L3/);
    await page.evaluate(() => localStorage.setItem('corral:locale', 'ko'));
    await page.reload();
    const koreanBox = page.getByRole('combobox', { name: '요청', exact: true });
    const koreanRange = page.getByRole('button', {
      name: 'README.md:L1-L3 참조 빼기',
      exact: true,
    });
    await expect(koreanRange).toBeVisible();
    await koreanRange.click();
    await expect(koreanBox).toHaveValue(`${prefix}@"my  notes.md"`);
    await expect(page.getByRole('listbox', { name: '참조', exact: true })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('corral:locale', 'en'));
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Remove reference "my  notes.md"', exact: true }),
    ).toBeVisible();
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
    await expect(box).toBeInViewport();
    await expect(box).toHaveAccessibleDescription(
      'Send to: new run in this session · next request',
    );
    await expect(page.getByTestId('composer-destination')).toHaveText(
      'Send to: new run in this session · next request',
    );
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
  // workbench.md: a next request is decided when it is sent, so while Run #2 works it waits behind
  // it; choosing an instruction and then the next request again keeps the draft, and opening the
  // active run changes neither the draft nor where it goes.
  test('shows the historical selection and keeps a next request waiting behind the active run when opening it', async ({
    page,
    corral,
  }, testInfo) => {
    holdReply();
    try {
      await corral.open('/');
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
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
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: after the current run in this session · next request',
      );
      const intent = page.getByRole('combobox', { name: 'What this is', exact: true });
      await intent.click();
      await page.getByRole('option', { name: /^Instruction/ }).click();
      await expect(intent).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('composer-destination')).toContainText('Send to: Run #2');
      await expect(page.getByTestId('composer-destination')).toContainText('instruction');
      await intent.click();
      await page.getByRole('option', { name: /^Next request/ }).click();
      await box.fill('Keep this next request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: after the current run in this session · next request',
      );
      await page.screenshot({ path: testInfo.outputPath('viewed-run-warning.png') });
      await page.getByRole('button', { name: 'View active run', exact: true }).click();
      await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
      await expect(page.getByTestId('viewed-run-warning')).toHaveCount(0);
      await expect(box).toHaveValue('Keep this next request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: after the current run in this session · next request',
      );
      expect(corral.errors).toEqual([]);
    } finally {
      releaseReply();
    }
  });

  test('the stop shortcut confirms the active run while viewing an older execution record', async ({
    page,
    corral,
  }) => {
    holdReply();
    try {
      await corral.open('/');
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
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
      const second = corral.server.coordinator.listRuns()[0];
      if (!second || second.runId === first.runId) throw new Error('Active run missing');
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(first.runId);

      const cancellations: { runId: string; type: string }[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
        const command = request.postDataJSON() as { runId: string; type: string };
        if (command.type === 'cancel') cancellations.push(command);
      });
      await page.keyboard.press('ControlOrMeta+.');
      const confirmation = page.getByRole('dialog', { name: 'Cancel whole run', exact: true });
      await expect(confirmation).toBeVisible();
      expect(cancellations).toEqual([]);
      expect(corral.server.coordinator.getSnapshot(second.runId).projection.status).toBe('running');
      await confirmation
        .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
        .click();
      await expect
        .poll(() => cancellations.map((command) => command.runId))
        .toEqual([second.runId]);
      releaseReply();
      await expect
        .poll(() => corral.server.coordinator.getSnapshot(second.runId).projection.status)
        .toBe('cancelled');
      expect(corral.errors).toEqual([]);
    } finally {
      releaseReply();
    }
  });
});
