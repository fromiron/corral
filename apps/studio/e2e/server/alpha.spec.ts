import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { panelTab, requestBox } from '../workbench.ts';
import { expect, type Harness, test } from './harness.ts';

// Alpha acceptance: the development workbench end to end in the real app, with a real
// Git repository, a local bare remote, a real node task and the scripted agent. No paid models.

test.describe.configure({ timeout: 120_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd })
    .toString()
    .trim();

/** A trusted project folder with package scripts, a check and a bare remote it pushes to. */
async function project(page: Page, corral: Harness, options: { check?: string } = {}) {
  const original = join(corral.workspace, 'repo');
  const remote = join(corral.workspace, 'remote.git');
  mkdirSync(join(original, 'src'), { recursive: true });
  git(corral.workspace, 'init', '-q', '-b', 'main', original);
  writeFileSync(
    join(original, 'package.json'),
    JSON.stringify({
      name: 'alpha',
      scripts: { serve: 'node server.js', typecheck: 'node check.js' },
    }),
  );
  writeFileSync(
    join(original, 'server.js'),
    "require('http').createServer((q,s)=>s.end('hello from alpha')).listen(0,'127.0.0.1',function(){console.log('listening '+this.address().port)});\n",
  );
  // Reports a tsc-style location while src/a.ts still assigns a string to a number.
  writeFileSync(
    join(original, 'check.js'),
    "const t=require('fs').readFileSync('src/a.ts','utf8');if(t.includes('\"x\"')){console.log('src/a.ts(2,19): error TS2322: Type string is not assignable to type number.');process.exit(1)}console.log('ok');\n",
  );
  writeFileSync(join(original, 'src', 'a.ts'), 'const a = 1;\nconst b: number = "x";\n');
  writeFileSync(join(original, 'app.js'), 'console.log("one");\n');
  git(original, 'add', '.');
  git(original, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'first');
  git(corral.workspace, 'init', '-q', '--bare', '-b', 'main', remote);
  git(original, 'remote', 'add', 'origin', remote);
  git(original, 'push', '-q', 'origin', 'main');
  // The author comes from the repository's own Git settings.
  git(original, 'config', 'user.name', 'Alpha Person');
  git(original, 'config', 'user.email', 'alpha@example.test');
  git(original, 'config', 'commit.gpgsign', 'false');
  const before = {
    head: git(original, 'rev-parse', 'HEAD'),
    status: git(original, 'status', '--porcelain'),
  };

  await corral.open('/projects/default');
  await page.getByRole('tab', { name: /^Project folder/ }).click();
  const folder = page.getByRole('tabpanel', { name: 'Project folder', exact: true });
  await folder.getByLabel('Folder path on this computer').fill(original);
  await folder.getByRole('button', { name: 'Link folder' }).click();
  const trust = folder.getByRole('switch', { name: /Trust this repository/ });
  await trust.click();
  await expect(trust).toBeChecked();
  await folder
    .getByRole('textbox', { name: /Checks/ })
    .fill(options.check ?? 'Typecheck = node check.js');
  await folder.getByRole('button', { name: 'Save checks' }).click();
  return { original, remote, before };
}

async function startSession(page: Page, fromSessionsTab = true) {
  if (fromSessionsTab) await page.getByRole('tab', { name: /^Sessions/ }).click();
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
  const sessionId = new URL(page.url()).pathname.split('/')[2] as string;
  await panelTab(page, 'Changes');
  const copy = page.getByRole('region', { name: 'Working copy' });
  await copy.getByRole('button', { name: /Make a working copy from/ }).click();
  await expect(copy.getByRole('link', { name: 'Review changes' })).toBeVisible();
  return { sessionId, url: page.url().split('?')[0] as string };
}

/** The session copy on disk, found from Git's own worktree list of the project folder. */
function copyOf(original: string, sessionId: string) {
  return git(original, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9))
    .find((path) => path.endsWith(`/${sessionId}`)) as string;
}

async function replaceDocument(page: Page, text: string) {
  const editor = page.locator('.monaco-editor').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Unsaved changes$/ })
      .first(),
  ).toBeVisible();
}

async function commitAndPush(page: Page, path: string, message: string, branch: string) {
  await panelTab(page, 'Git');
  // The dock tab panel only hosts the pane, so its controls are found by their own names.
  const gitPane = page;
  await gitPane.getByRole('button', { name: 'Refresh', exact: true }).click();
  await gitPane.getByRole('button', { name: `Stage ${path}`, exact: true }).click();
  await expect(gitPane.locator(`[data-git-side="staged"][data-path="${path}"]`)).toBeVisible();
  await gitPane.getByRole('textbox', { name: 'Commit message', exact: true }).fill(message);
  await gitPane.getByRole('button', { name: 'Commit 1 file', exact: true }).click();
  await expect(gitPane.locator(`[data-git-side="staged"][data-path="${path}"]`)).toHaveCount(0);
  await gitPane.getByText('Branch & remote', { exact: true }).click();
  await gitPane.getByRole('textbox', { name: 'New branch name', exact: true }).fill(branch);
  await gitPane.getByRole('button', { name: 'Create branch', exact: true }).click();
  await expect(gitPane.getByRole('textbox', { name: 'New branch name', exact: true })).toHaveValue(
    '',
  );
  await gitPane.getByRole('button', { name: 'Push', exact: true }).click();
}

test('without a model: edit, task, preview, check, review, stage, commit and push from a session copy', async ({
  page,
  corral,
}) => {
  let csrf = '';
  page.on('response', (response) => {
    const token = response.headers()['x-corral-csrf'];
    if (token) csrf = token;
  });
  const { original, remote, before } = await project(page, corral, {
    check: 'App prints = node app.js',
  });
  const { sessionId, url } = await startSession(page);
  const copy = copyOf(original, sessionId);

  // Edit and save in a document tab.
  await panelTab(page, 'Files');
  await page.getByRole('button', { name: 'Open app.js', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'app.js', exact: true })).toBeVisible();
  await replaceDocument(page, 'console.log("two");\n');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Saved$/ })
      .first(),
  ).toBeVisible();
  expect(readFileSync(join(copy, 'app.js'), 'utf8')).toBe('console.log("two");\n');

  // A development task, started on request and previewed through its own port.
  await page.goto(`${url}?panel=tools`);
  const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
  await expect(tasks.getByText('serve', { exact: true })).toBeVisible();
  await tasks.getByRole('button', { name: 'Run serve', exact: true }).click();
  const listening = tasks.getByText(/listening \d+/);
  await expect(listening).toBeVisible();
  const port = Number((await listening.textContent())?.match(/listening (\d+)/)?.[1]);
  const api = (path: string, data?: unknown) =>
    page.request.post(`${corral.server.url}/api/v1/sessions/${sessionId}${path}`, {
      headers: { origin: corral.server.url, 'x-corral-csrf': csrf },
      data: data ?? {},
    });
  const { tasks: listed } = (await (
    await page.request.get(`${corral.server.url}/api/v1/sessions/${sessionId}/worktree/tasks`)
  ).json()) as { tasks: { operationId: string; script: string; state: string }[] };
  const serve = listed.find((task) => task.script === 'serve' && task.state === 'running');
  expect(serve).toBeTruthy();
  const preview = await api('/previews', { operationId: serve?.operationId, port });
  expect(preview.status()).toBe(201);
  const lease = (await preview.json()) as { leaseId: string };
  const delegation = (await (await api(`/previews/${lease.leaseId}/delegations`)).json()) as {
    target: { url: string; headers: Record<string, string> };
  };
  const served = await page.request.get(delegation.target.url, {
    headers: delegation.target.headers,
  });
  expect(await served.text()).toContain('hello from alpha');
  await tasks.getByRole('button', { name: 'Stop serve', exact: true }).click();
  await expect(tasks.getByRole('button', { name: 'Run serve', exact: true })).toBeVisible();

  // The registered check runs on the saved tree.
  await page.goto(`${url}?panel=checks`);
  await page.getByRole('button', { name: 'Run App prints', exact: true }).click();
  await expect(
    page.getByTestId('check-result').first().getByText('Pass', { exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });

  // Review the change as Git sees it, then stage, commit and push.
  await panelTab(page, 'Git');
  await page.locator('[data-git-side="unstaged"][data-path="app.js"]').click();
  await expect(page.getByTestId('file-diff')).toBeVisible();
  await commitAndPush(page, 'app.js', 'Print two', 'feature/alpha');
  await expect
    .poll(() => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature/alpha'))
    .toBe('refs/heads/feature/alpha');
  expect(git(remote, 'log', '-1', '--format=%an|%ae|%s', 'feature/alpha')).toBe(
    'Alpha Person|alpha@example.test|Print two',
  );
  // The project folder's checkout, index and files are untouched.
  expect(git(original, 'rev-parse', 'HEAD')).toBe(before.head);
  expect(git(original, 'status', '--porcelain')).toBe(before.status);
  expect(corral.errors).toEqual([]);
});

function writerTeam(path: string) {
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: '0.1',
      id: 'alpha_writer',
      name: 'Alpha writer',
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

test('one deterministic agent request changes the copy, and the person commits and pushes it', async ({
  page,
  corral,
}) => {
  const { original, remote, before } = await project(page, corral);
  await page.getByRole('tab', { name: /^Teams/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles([writerTeam(join(corral.workspace, 'team.corral.json'))]);
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByRole('button', { name: /^Session details \(optional\)/ }).click();
  await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option', { name: 'Alpha writer', exact: true }).click();
  const { sessionId } = await startSession(page, false);
  await requestBox(page).fill('Write the notes');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.locator('[data-testid^="entry-"]').first();
  await expect(card.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 20_000 });
  const copy = copyOf(original, sessionId);
  // the session's lead calls the team's writer, whose node is team_writer_role.
  expect(readFileSync(join(copy, 'notes', 'team_writer_role.md'), 'utf8').length).toBeGreaterThan(
    0,
  );

  await commitAndPush(page, 'notes/team_writer_role.md', 'Add notes', 'feature/notes');
  await expect
    .poll(() => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature/notes'))
    .toBe('refs/heads/feature/notes');
  expect(git(remote, 'show', '--name-only', '--format=%s', 'feature/notes')).toBe(
    'Add notes\n\nnotes/team_writer_role.md',
  );
  expect(git(original, 'rev-parse', 'HEAD')).toBe(before.head);
  expect(git(original, 'status', '--porcelain')).toBe(before.status);
  expect(corral.errors).toEqual([]);
});

test('a failed check, a disk conflict, the settings dialog, a bad branch name and a lost Git answer keep the work intact', async ({
  page,
  corral,
}) => {
  const { original, before } = await project(page, corral);
  const { sessionId, url } = await startSession(page);
  const copy = copyOf(original, sessionId);

  // A failed check lists its location; the row opens the exact line.
  await page.goto(`${url}?panel=checks`);
  await page.getByRole('button', { name: 'Run Typecheck', exact: true }).click();
  await expect(
    page.getByTestId('check-result').first().getByText('Fail', { exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.goto(`${url}?panel=problems`);
  const problems = page.getByRole('region', { name: 'Problems', exact: true });
  await problems.getByRole('button', { name: /src\/a\.ts:2:19/ }).click();
  await expect(page.getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();

  // Fixing the file makes that result one from an older tree.
  await replaceDocument(page, 'const a = 1;\nconst b: number = 2;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Saved$/ })
      .first(),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Problems', exact: true }).click();
  await problems.getByRole('button', { name: 'Refresh problems', exact: true }).click();
  await expect(problems.getByText('Outdated', { exact: true })).toBeVisible();

  // A change on disk while a draft is open is shown, and the draft is not overwritten.
  await page.getByRole('tab', { name: 'a.ts', exact: true }).click();
  writeFileSync(join(copy, 'src', 'a.ts'), 'const a = 1;\nconst b: number = 3;\n');
  await replaceDocument(page, 'const a = 1;\nconst b: number = 4;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText('The file changed on disk.', { exact: true })).toBeVisible();
  expect(readFileSync(join(copy, 'src', 'a.ts'), 'utf8')).toContain('= 3;');
  await page
    .getByRole('button', { name: 'Discard draft and use disk version', exact: true })
    .click();
  await expect(page.getByText('The document could not be saved. Your draft is kept.')).toHaveCount(
    0,
  );

  // The commit message survives a trip through the settings dialog.
  await panelTab(page, 'Git');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Stage src/a.ts', exact: true }).click();
  await expect(page.locator('[data-git-side="staged"][data-path="src/a.ts"]')).toBeVisible();
  const message = page.getByRole('textbox', { name: 'Commit message', exact: true });
  await message.fill('Fix b');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('[data-settings-dialog]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-settings-dialog]')).toHaveCount(0);
  await expect(message).toHaveValue('Fix b');

  // An invalid branch name is refused and creates nothing.
  await page.getByText('Branch & remote', { exact: true }).click();
  await page.getByRole('textbox', { name: 'New branch name', exact: true }).fill('bad..name');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'not a valid branch name' }),
  ).toBeVisible();
  expect(git(copy, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).not.toContain('bad');

  // The host commits, but the answer is lost; a reload reads the same receipt and sends nothing new.
  let posts = 0;
  await page.route('**/worktree/git/operations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Commit 1 file', exact: true }).click();
  await expect(page.getByText('The last Git change has no confirmed result yet.')).toBeVisible();
  expect(posts).toBe(1);
  await page.reload();
  await expect(page.locator('[data-git-side="staged"][data-path="src/a.ts"]')).toHaveCount(0);
  await expect(page.getByText('The last Git change has no confirmed result yet.')).toHaveCount(0);
  expect(posts).toBe(1);
  expect(
    git(copy, 'log', '--format=%s')
      .split('\n')
      .filter((line) => line === 'Fix b'),
  ).toHaveLength(1);

  expect(git(original, 'rev-parse', 'HEAD')).toBe(before.head);
  expect(git(original, 'status', '--porcelain')).toBe(before.status);
});
