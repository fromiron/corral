import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('[WBTST-016] a session works in its own copy, and its changes are reviewed and checked', async ({
  page,
  corral,
}) => {
  // The whole loop: link, copy, run, review, a second run, approve, apply, revert.
  test.setTimeout(60_000);
  const original = gitRepo();
  const scratch = mkdtempSync(join(tmpdir(), 'corral-e2e-def-'));
  try {
    await corral.open('/');
    const folder = page.getByRole('region', { name: 'Work folder' });
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder' }).click();
    await expect(folder).toContainText('no uncommitted changes');
    const trust = folder.getByRole('checkbox', { name: /Trust this repository/ });
    await trust.click();
    await expect(trust).toBeChecked();
    await folder
      .getByRole('textbox', { name: /Checks/ })
      .fill("Notes exist = node -e \"require('fs').statSync('notes/writer.md')\"");
    await folder.getByRole('button', { name: 'Save checks' }).click();

    await page.locator('input[type=file]').setInputFiles([writerWithFiles(scratch)]);
    await expect(page).toHaveURL(/\/edit$/);
    await page.getByRole('link', { name: 'Corrals', exact: true }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    await page.getByLabel('Purpose').fill('Keep notes in the repository');
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);

    const copy = page.getByRole('region', { name: 'Working copy' });
    await copy.getByRole('button', { name: /Make a working copy from/ }).click();
    await expect(copy.getByRole('link', { name: 'Review changes' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Request' }).fill('Write the notes');
    await page.getByRole('button', { name: 'Send' }).click();
    const card = page.locator('[data-testid^="entry-"]').first();
    await expect(card.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });

    await copy.getByRole('link', { name: 'Review changes' }).click();
    await expect(page).toHaveURL(/\/review/);
    const file = page.getByRole('button', { name: /notes\/writer\.md/ });
    await expect(file).toContainText('Added');
    await expect(file).toContainText('Corral');
    await file.click();
    await expect(
      page.getByTestId('file-diff').locator('[data-diff="added"]').first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Run Notes exist' }).click();
    await expect(page.getByTestId('check-result').first()).toContainText('Passed', {
      timeout: 20_000,
    });

    // The linked folder itself was never written by the run.
    expect(existsSync(join(original, 'notes'))).toBe(false);

    // CR-013: a comment on a line goes out as a request for changes, as a new run.
    await page.getByRole('button', { name: 'Comment on line 1' }).first().click();
    await page.getByRole('textbox', { name: 'Comment on line 1' }).fill('Start with a title.');
    await page.getByRole('button', { name: 'Add comment' }).click();
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
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(original, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
