import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeSettings,
  openConversationDetails,
  openFolderSettings,
  openLibraryTeams,
  openProject,
  panelTab,
  requestBox,
} from '../workbench.ts';
import { expect, test } from './harness.ts';

// Work folder → working copy → a run that writes through the broker → review and a check
//. The team comes from a definition file that gives its role file tools.

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
        maxQuestions: 6,
        questionTimeoutMs: 120000,
      },
    }),
  );
  return path;
}

test('a session works in its own copy, and its changes are reviewed and checked', async ({
  page,
  corral,
}) => {
  // The whole loop: link, copy, run, review, a second run, approve, apply, revert.
  test.setTimeout(60_000);
  const original = gitRepo();
  const scratch = mkdtempSync(join(tmpdir(), 'corral-e2e-def-'));
  try {
    await corral.open('/');
    const folder = await openFolderSettings(page);
    await folder.getByLabel('Folder path on this computer').fill(original);
    await folder.getByRole('button', { name: 'Link folder' }).click();
    await expect(folder).toContainText('no uncommitted changes');
    const trust = folder.getByRole('switch', { name: /Trust this repository/ });
    await trust.click();
    await expect(trust).toBeChecked();
    await folder
      .getByRole('textbox', { name: /Checks/ })
      .fill("Notes exist = node -e \"require('fs').statSync('notes/team_writer_role.md')\"");
    await folder.getByRole('button', { name: 'Save checks' }).click();
    await closeSettings(page);

    await openLibraryTeams(page);
    await page.locator('input[type=file]').setInputFiles([writerWithFiles(scratch)]);
    await expect(page).toHaveURL(/\/edit$/);
    await openProject(page);
    const details = await openConversationDetails(page);
    await details.getByLabel('Purpose').fill('Keep notes in the repository');
    // this journey runs the imported team; the session's lead calls its writer, whose
    // node is team_writer_role.
    await details.getByRole('combobox', { name: 'Corral', exact: true }).click();
    await page.getByRole('option', { name: 'Writer with files', exact: true }).click();
    await details.getByRole('button', { name: 'Start chat' }).click();
    await expect(page).toHaveURL(/\/sessions\/session_/);
    const sessionPath = new URL(page.url()).pathname;

    await panelTab(page, 'Files');
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
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
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(page.getByTestId('pre-run')).toContainText('can change the working copy');

    await requestBox(page).fill('Write the notes');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // The turn's run card begins with its state, for screen readers: in a conversation the line
    // above the composer is where a finished run's status shows. Not an exact text match: the
    // card's process rows (Writer · Succeeded) carry the same word, so it finds more than one.
    const card = page
      .getByTestId('chat-timeline')
      .getByRole('region', { name: 'Run #1', exact: true });
    await expect(card).toContainText(/^Succeeded/, { timeout: 20_000 });
    await expect(card.getByTestId('run-change-summary')).toContainText(/1 changed file · \+\d+ −0/);
    await expect(card.getByRole('link', { name: /1 changed file/ })).toHaveAttribute(
      'href',
      /scope=run/,
    );

    // With changes to read, the Changes view opens on its review (workbench.md: "변경 화면은
    // 검토 보기로 열린다").
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    const views = page.getByRole('tablist', { name: 'Changes views', exact: true });
    await expect(views.getByRole('tab', { name: 'Review', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page).toHaveURL(new URL(`${sessionPath}?panel=changes`, corral.server.url).href);
    const file = page.getByRole('button', { name: /notes\/team_writer_role\.md/ });
    await expect(file).toContainText('Added');
    await expect(file).toContainText('Corral');
    await file.click();
    await expect(
      page.getByTestId('file-diff').locator('[data-line-type="change-addition"]').first(),
    ).toBeVisible();
    // Checks are a Changes view of their own beside the review (workbench.md: "보조 보기로
    // Git·체크포인트·**검사**를 둔다").
    await views.getByRole('tab', { name: 'Checks', exact: true }).click();
    await page.getByRole('button', { name: 'Run Notes exist' }).click();
    // A completed run shows its verdict alone.
    await expect(
      page.getByTestId('check-result').first().getByText('Pass', { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByTestId('check-result').first().getByText('Completed', { exact: true }),
    ).toHaveCount(0);

    // The linked folder itself was never written by the run.
    expect(existsSync(join(original, 'notes'))).toBe(false);
    await views.getByRole('tab', { name: 'Review', exact: true }).click();
    await expect(
      page.getByTestId('file-diff').locator('[data-line-type="change-addition"]').first(),
    ).toBeVisible();

    // a comment on a line goes out as a request for changes, as a new run.
    const decisionArea = page.getByRole('complementary', {
      name: 'Comments and decision',
      exact: true,
    });
    await decisionArea.getByRole('button', { name: 'Add comment', exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Comment on line 1' });
    await draft.fill('Start with a title.');

    await page.setViewportSize({ width: 1024, height: 800 });
    const diff = page.getByRole('region', { name: 'notes/team_writer_role.md', exact: true });
    await expect
      .poll(async () => (await diff.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(400);
    // Narrower than its three columns, the review puts the diff first: the file list folds into
    // its head while a file is read and the decision area follows, keeping the draft
    // (workbench.md: "중앙 diff를 우선하고 파일·검사·의견을 재배치하되 초안을 유지한다").
    const fileList = page
      .getByRole('navigation', { name: 'Review changes', exact: true })
      .getByRole('button', { name: '1 file', exact: true });
    await expect(fileList).toBeVisible();
    await expect(decisionArea).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBe(0);
    await expect(fileList).toBeVisible();
    await expect(diff).toBeVisible();
    await expect(draft).toHaveValue('Start with a title.');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(draft).toHaveValue('Start with a title.');
    await decisionArea
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
      'notes/team_writer_role.md · Will write',
    );
    await page.getByRole('button', { name: /^Apply \d+ files?$/ }).click();
    await expect(page.getByTestId('integration').first()).toContainText('Applied');
    expect(existsSync(join(original, 'notes', 'team_writer_role.md'))).toBe(true);
    await page
      .getByTestId('integration')
      .first()
      .getByRole('button', { name: 'Revert', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Revert applied files', exact: true })
      .click();
    await expect(page.getByTestId('integration').first()).toContainText('Reverted');
    expect(existsSync(join(original, 'notes', 'team_writer_role.md'))).toBe(false);
    const parts = page.getByRole('region', { name: 'Apply or revert a part', exact: true });
    await parts.getByRole('button', { name: 'Apply or revert a part' }).click();
    await parts
      .getByRole('checkbox', { name: /^Lines? \d/ })
      .first()
      .check();
    await parts.getByRole('button', { name: 'Preview applying to the folder' }).click();
    await expect(parts).toContainText('Target: original folder');
    await parts.getByRole('button', { name: 'Approve and apply to the folder' }).click();
    await expect.poll(() => existsSync(join(original, 'notes', 'team_writer_role.md'))).toBe(true);
    // Checkpoints are the Changes view beside the review (workbench.md: "보조 보기로
    // Git·체크포인트·**검사**를 둔다").
    await views.getByRole('tab', { name: 'Checkpoints', exact: true }).click();
    await expect(page).toHaveURL(new URL(`${sessionPath}?panel=changes`, corral.server.url).href);
    const checkpoints = page.getByRole('region', { name: 'File checkpoints', exact: true });
    await checkpoints.getByRole('button', { name: 'Refresh checkpoints', exact: true }).click();
    const originalBackup = checkpoints
      .getByTestId('checkpoint-row')
      .filter({ hasText: 'Before restore' })
      .filter({ hasText: 'Original folder' })
      .first();
    await originalBackup.getByRole('button', { name: 'Preview restore' }).click();
    const originalPreview = checkpoints.getByRole('region', { name: 'Preview restore' });
    await expect(originalPreview).toContainText('Original folder');
    await originalPreview.getByRole('button', { name: 'Restore original folder' }).click();
    await expect.poll(() => existsSync(join(original, 'notes', 'team_writer_role.md'))).toBe(false);

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
    await expect(preview).toContainText('notes/team_writer_role.md');
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
