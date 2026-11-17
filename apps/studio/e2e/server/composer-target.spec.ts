import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activityBar,
  chooseRun,
  closePanel,
  closeSettings,
  confirmStop,
  openFolderSettings,
  openPanelTab,
  panelContent,
  panelTabNamed,
  panelToggle,
  requestBox,
  runGoing,
  slash,
  stopConfirmation,
  stopRun,
} from '../workbench.ts';
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
    // The file viewer is the panel's Files tab now.
    await openPanelTab(page, 'Files');
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
    await page.getByRole('button', { name: 'More actions for README.md', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reference lines…', exact: true }).click();
    const reference = page.getByRole('dialog', { name: 'Reference lines', exact: true });
    await reference.getByLabel('To line', { exact: true }).fill('3');
    await reference.getByRole('button', { name: 'Reference lines', exact: true }).click();
    await closePanel(page);
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
      'Send to: new run in this conversation · next request',
    );
    await expect(page.getByTestId('composer-destination')).toHaveText(
      'Send to: new run in this conversation · next request',
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
  // it; choosing an instruction and then the next request again keeps the draft, and visiting the
  // run record changes neither the draft nor where it goes. The conversation speaks of the active
  // run although the address still selects Run #1 (chat-widgets-contract.md 3.1).
  test('speaks of the active run whatever the address selects and keeps a next request waiting behind it', async ({
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
      await stopRun(page);
      releaseReply();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
      // The address selects Run #1: its tab opens beside the conversation.
      const sessionUrl = new URL(page.url());
      sessionUrl.search = new URLSearchParams({ panel: 'run', run: first.runId }).toString();
      await page.goto(sessionUrl.href);
      holdReply();
      await box.fill('Second request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      // The address still selects Run #1; the activity bar follows Run #2 and nothing in the
      // composer tells of Run #1.
      await expect(runGoing(page)).toBeVisible();
      expect(new URL(page.url()).searchParams.get('run')).toBe(first.runId);
      await expect(page.getByTestId('viewed-run-warning')).toHaveCount(0);
      await expect(activityBar(page)).not.toContainText('Selected run');
      await expect(
        page.getByTestId('chat-composer').getByRole('button', { name: 'View active run' }),
      ).toHaveCount(0);
      // While Run #2 goes the send key joins it.
      await expect(page.getByTestId('composer-destination')).toContainText('Send to: Run #2');
      await expect(page.getByTestId('composer-destination')).toContainText('· Join');
      // `/next` picks a next request once; it waits behind the active run.
      await slash(page, 'next');
      await box.fill('Keep this next request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: after the current run in this conversation · next request',
      );
      await page.screenshot({ path: testInfo.outputPath('composer-active-run.png') });
      // The active run's record, then back to the conversation alone.
      await openPanelTab(page, 'Runs', { run: 2 });
      await closePanel(page);
      await expect(runGoing(page)).toBeVisible();
      await expect(box).toHaveValue('Keep this next request');
      await expect(page.getByTestId('composer-destination')).toHaveText(
        'Send to: after the current run in this conversation · next request',
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
      await stopRun(page);
      releaseReply();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('cancelled');

      // Run #1's record beside the conversation.
      const sessionUrl = new URL(page.url());
      sessionUrl.search = new URLSearchParams({ panel: 'run', run: first.runId }).toString();
      await page.goto(sessionUrl.href);
      holdReply();
      await box.fill('Second request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(runGoing(page)).toBeVisible();
      const second = corral.server.coordinator.listRuns()[0];
      if (!second || second.runId === first.runId) throw new Error('Active run missing');
      await expect(panelTabNamed(page, 'Run #1')).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(first.runId);

      const cancellations: { runId: string; type: string }[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
        const command = request.postDataJSON() as { runId: string; type: string };
        if (command.type === 'cancel') cancellations.push(command);
      });
      await page.keyboard.press('ControlOrMeta+.');
      await expect(stopConfirmation(page)).toBeVisible();
      expect(cancellations).toEqual([]);
      expect(corral.server.coordinator.getSnapshot(second.runId).projection.status).toBe('running');
      await confirmStop(page);
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

  // features/execution-monitor.md: while the run record shows a past run and another run of the
  // session goes, one line above the header names that run and leads to it.
  test('the run record of a past run names the active run on one line and opens it', async ({
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
      await stopRun(page);
      releaseReply();
      await expect.poll(() => corral.server.coordinator.listRuns()[0]?.status).toBe('cancelled');
      holdReply();
      await box.fill('Second request');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(runGoing(page)).toBeVisible();
      const second = corral.server.coordinator.listRuns()[0];
      if (!second || second.runId === first.runId) throw new Error('Active run missing');

      await openPanelTab(page, 'Runs', { run: 2 });
      const header = (run: string) => panelContent(page, run).getByTestId('run-header');
      const line = header('Run #1').getByTestId('run-active-elsewhere');
      // The newest run is the one going: no line while it shows.
      await expect(page.getByRole('banner').getByRole('button', { name: /Run #2/ })).toBeVisible();
      await expect(header('Run #2').getByTestId('run-active-elsewhere')).toHaveCount(0);
      // Choosing Run #1 in the path opens its tab.
      await chooseRun(page, 1);
      await expect(page.getByRole('banner').getByRole('button', { name: /Run #1/ })).toBeVisible();
      await expect(line).toBeVisible();
      await expect(line).toContainText('Run #2');
      await expect(line.getByRole('button')).toHaveCount(1);
      // On a narrow header the line keeps its control on screen. Without room beside the
      // conversation the panel withdraws, and its toggle brings it back as a drawer.
      await page.setViewportSize({ width: 390, height: 844 });
      await panelToggle(page).click();
      await expect(
        line.getByRole('button', { name: 'View active run', exact: true }),
      ).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('run-active-elsewhere-narrow.png') });
      await page.setViewportSize({ width: 1280, height: 800 });
      // The line selects the active run's tab, which takes the focus (features/session-panel.md
      // 접근성); Run #1's tab stays.
      await line.getByRole('button', { name: 'View active run', exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(second.runId);
      await expect(page.getByRole('banner').getByRole('button', { name: /Run #2/ })).toBeVisible();
      await expect(panelTabNamed(page, 'Run #2')).toBeFocused();
      await expect(panelTabNamed(page, 'Run #1')).toHaveAttribute('aria-selected', 'false');
      // Choosing it changed neither the draft nor where the composer sends.
      await closePanel(page);
      await expect(page.getByTestId('composer-destination')).toContainText('Send to: Run #2');
      expect(corral.errors).toEqual([]);
    } finally {
      releaseReply();
    }
  });
});
