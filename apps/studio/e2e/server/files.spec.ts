import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelTab, requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

// Work folder → working copy → a run that writes through the broker → review and a check
// (CR-012; WBTST-016). The team comes from a definition file that gives its role file tools.

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-e2e-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return dir;
}

function writerWithFiles(dir: string) {
  const path = join(dir, 'writer-files.corral.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: '0.1',
      id: 'writer_files',
      name: 'Writer with files',
      entryNodeId: 'writer',
      input: { brief: 'Write notes.', criteria: ['Be brief.'] },
      roles: [
        {
          id: 'writer_role',
          name: 'Writer',
          prompt: 'Write the notes file.',
          modelProfile: 'model-a',
          allowedWorkTools: ['write_artifact', 'list_files', 'read_file', 'write_file'],
          allowedCollaborationTools: ['submit_result'],
          outputContract: 'text',
        },
      ],
      nodes: [
        {
          id: 'writer',
          type: 'agent',
          label: 'Writer',
          roleId: 'writer_role',
          invocation: 'scheduled',
          inputBindings: [{ kind: 'run_input', name: 'brief' }],
          outputName: 'notes',
        },
        {
          id: 'output',
          type: 'output',
          label: 'Output',
          inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'writer' }],
          requireApproval: false,
        },
      ],
      controlEdges: [
        { id: 'e1', source: 'writer', sourcePort: 'out', target: 'output', targetPort: 'in' },
      ],
      capabilityLinks: [],
      limits: {
        maxDelegationDepth: 2,
        maxModelConcurrency: 3,
        maxSpawns: 12,
        maxModelCalls: 40,
        maxOutputTokens: 64000,
        maxOutputTokensPerCall: 4096,
        maxQuestions: 6,
        questionTimeoutMs: 120000,
        modelTimeoutMs: 180000,
        runDeadlineMs: 3600000,
      },
    }),
  );
  return path;
}

test('[TC-HUNK-001-H] [TC-CKPT-001-H] [TC-CHAT-002-H] [TC-WBUI-003-H] [TC-WBUI-003-N] [WBTST-016] a session works in its own copy, and its changes are reviewed and checked', async ({
  page,
  corral,
}) => {
  // The whole loop: link, copy, run, review, a second run, approve, apply, revert.
  test.setTimeout(60_000);
  const original = gitRepo();
  const scratch = mkdtempSync(join(tmpdir(), 'corral-e2e-def-'));
  try {
    await corral.open('/');
    await page.getByRole('tab', { name: /^Project folder/ }).click();
    const folder = page.getByRole('tabpanel', { name: 'Project folder', exact: true });
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder' }).click();
    await expect(folder).toContainText('no uncommitted changes');
    const trust = folder.getByRole('switch', { name: /Trust this repository/ });
    await trust.click();
    await expect(trust).toBeChecked();
    await folder
      .getByRole('textbox', { name: /Checks/ })
      .fill("Notes exist = node -e \"require('fs').statSync('notes/writer.md')\"");
    await folder.getByRole('button', { name: 'Save checks' }).click();

    await page.getByRole('tab', { name: /^Teams/ }).click();
    await page.locator('input[type=file]').setInputFiles([writerWithFiles(scratch)]);
    await expect(page).toHaveURL(/\/edit$/);
    await page.getByRole('link', { name: 'Project home', exact: true }).click();
    await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
    await page.getByLabel('Purpose').fill('Keep notes in the repository');
    // CR-024: a new session starts in auto mode; this journey runs the imported team.
    await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
    await page.getByRole('option', { name: 'Writer with files', exact: true }).click();
    await page.getByRole('button', { name: 'Start chat' }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);

    await panelTab(page, 'Files');
    await page.getByRole('button', { name: 'Open README.md', exact: true }).click();
    const content = page.getByRole('region', { name: 'File content', exact: true });
    await expect(content.getByText('hello', { exact: true })).toBeVisible();
    writeFileSync(join(original, 'README.md'), 'updated outside Corral\n');
    await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await expect(content.getByText('updated outside Corral', { exact: true })).toBeVisible();
    writeFileSync(join(original, 'README.md'), 'hello\n');
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();

    const copy = page.getByRole('region', { name: 'Working copy' });
    await copy.getByRole('button', { name: /Make a working copy from/ }).click();
    await expect(copy.getByRole('link', { name: 'Review changes' })).toBeVisible();
    await expect(page.getByTestId('pre-run')).toContainText('can change the working copy');

    await requestBox(page).fill('Write the notes');
    await page.getByRole('button', { name: 'Send' }).click();
    const card = page.locator('[data-testid^="entry-"]').first();
    await expect(card.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('run-change-summary')).toContainText(/1 changed file · \+\d+ −0/);
    await expect(card.getByRole('link', { name: /1 changed file/ })).toHaveAttribute(
      'href',
      /scope=run/,
    );

    await copy.getByRole('link', { name: 'Review changes' }).click();
    await expect(page).toHaveURL(/\/review/);
    const file = page.getByRole('button', { name: /notes\/writer\.md/ });
    await expect(file).toContainText('Added');
    await expect(file).toContainText('Corral');
    await file.click();
    await expect(
      page.getByTestId('file-diff').locator('[data-line-type="change-addition"]').first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Run Notes exist' }).click();
    await expect(
      page.getByTestId('check-result').first().getByText('Completed', { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByTestId('check-result').first().getByText('Pass', { exact: true }),
    ).toBeVisible();

    // The linked folder itself was never written by the run.
    expect(existsSync(join(original, 'notes'))).toBe(false);

    // CR-013: a comment on a line goes out as a request for changes, as a new run.
    await page.getByRole('button', { name: 'Comment on line 1' }).first().click();
    const draft = page.getByRole('textbox', { name: 'Comment on line 1' });
    await draft.fill('Start with a title.');

    await page.setViewportSize({ width: 1024, height: 800 });
    const diff = page.getByRole('region', { name: 'notes/writer.md', exact: true });
    await expect
      .poll(async () => (await diff.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(400);
    await expect(file).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run Notes exist' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
    await expect(file).toBeVisible();
    await expect(diff).toBeVisible();
    await expect(draft).toHaveValue('Start with a title.');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(draft).toHaveValue('Start with a title.');
    await page
      .getByTestId('pierre-diff')
      .locator('form')
      .getByRole('button', { name: 'Add comment', exact: true })
      .click();
    await expect(page.getByTestId('inline-comment')).toContainText('Start with a title.');
    await page.getByRole('button', { name: 'Send for changes' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent.' })).toBeVisible();

    // Approve, see the plan, apply to the folder, then revert.
    await page.reload();
    await page.getByRole('button', { name: 'Approve these changes' }).click();
    await expect(page.getByTestId('decision')).toContainText('Approved');
    await page.getByRole('button', { name: 'Plan applying the approved changes' }).click();
    await expect(page.getByTestId('integration-plan')).toContainText(
      'notes/writer.md · Will write',
    );
    await page.getByRole('button', { name: /^Apply \d+ files?$/ }).click();
    await expect(page.getByTestId('integration').first()).toContainText('Applied');
    expect(existsSync(join(original, 'notes', 'writer.md'))).toBe(true);
    await page.getByRole('button', { name: 'Revert' }).click();
    await expect(page.getByTestId('integration').first()).toContainText('Reverted');
    expect(existsSync(join(original, 'notes', 'writer.md'))).toBe(false);
    const parts = page.getByRole('region', { name: 'Selected changes', exact: true });
    await parts.getByRole('button', { name: 'Select changed parts' }).click();
    await parts.getByRole('checkbox', { name: /Part 1/ }).check();
    await parts.getByRole('button', { name: 'Preview original-folder changes' }).click();
    await expect(parts).toContainText('Target: original folder');
    await parts.getByRole('button', { name: 'Approve and apply to original' }).click();
    await expect.poll(() => existsSync(join(original, 'notes', 'writer.md'))).toBe(true);
    await page.goto(
      new URL(
        `/sessions/${new URL(page.url()).pathname.split('/')[2]}?panel=changes`,
        page.url(),
      ).toString(),
    );
    const checkpoints = page.getByRole('region', { name: 'File checkpoints', exact: true });
    const originalBackup = checkpoints
      .getByTestId('checkpoint-row')
      .filter({ hasText: 'Before restore' })
      .filter({ hasText: 'Original folder' })
      .first();
    await originalBackup.getByRole('button', { name: 'Preview restore' }).click();
    const originalPreview = checkpoints.getByRole('region', { name: 'Preview restore' });
    await expect(originalPreview).toContainText('Original folder');
    await originalPreview.getByRole('button', { name: 'Restore original folder' }).click();
    await expect.poll(() => existsSync(join(original, 'notes', 'writer.md'))).toBe(false);

    await checkpoints.getByLabel('Checkpoint name').fill('After review');
    await checkpoints.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
    await expect(
      checkpoints.getByTestId('checkpoint-row').filter({ hasText: 'After review' }),
    ).toContainText('Ready');
    const baseline = checkpoints
      .getByTestId('checkpoint-row')
      .filter({ hasText: 'Before Run' })
      .last();
    await baseline.getByRole('button', { name: 'Preview restore' }).click();
    const preview = checkpoints.getByRole('region', { name: 'Preview restore' });
    await expect(preview).toContainText('notes/writer.md');
    await preview.getByRole('button', { name: 'Restore working copy' }).click();
    await expect(
      checkpoints
        .getByTestId('checkpoint-restore')
        .filter({ hasText: 'Session working copy' })
        .first(),
    ).toContainText('Restore: Applied');
    await expect(
      checkpoints
        .getByTestId('checkpoint-row')
        .filter({ hasText: 'Before restore' })
        .filter({ hasText: 'Session working copy' }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(original, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
