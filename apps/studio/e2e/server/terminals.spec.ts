import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalView } from '@corral/contracts';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

async function api(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          'x-corral-csrf': session.csrfToken,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      return response.json();
    },
    { path, method, body },
  );
}

test.use({ replyDelayMs: 2000 });
test('terminal guidance follows observed active, uncertain and ended ownership without releasing it', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const project = await api(page, '/projects', 'POST', { name: 'Unvisited terminal project' });
  const projectId = project.project.projectId as string;
  const created = await api(page, '/sessions', 'POST', {
    projectId,
    title: 'Observed terminal owner',
  });
  const sessionId = created.session.sessionId as string;
  // This is an explicit read-response fixture. Actual OS cleanup is covered by the PTY flow below.
  let terminal: TerminalView = {
    terminalId: 'terminal_fixture',
    generation: 'generation_fixture',
    shellId: 'bash',
    state: 'uncertain',
    target: {
      hostId: 'fixture',
      projectId,
      bindingId: 'binding_fixture',
      sessionId,
      copyGeneration: 1,
    },
    initialCols: 80,
    initialRows: 24,
    cols: 80,
    rows: 24,
    lastSequence: 0,
    replayAvailable: true,
    controllerGeneration: 0,
    controller: null,
    exitCode: null,
    error: null,
  };
  const mutations: string[] = [];
  const attention = () =>
    terminal.state === 'uncertain'
      ? [
          {
            kind: 'uncertain_terminal',
            sessionId,
            sessionTitle: 'Observed terminal owner',
            runId: null,
            terminalId: terminal.terminalId,
            detail: null,
          },
        ]
      : [];
  let projectInboxRead = false;
  await page.route('**/api/v1/terminals/attention', (route) =>
    route.fulfill({ json: attention() }),
  );
  await page.route(`**/api/v1/projects/${projectId}/inbox`, (route) => {
    projectInboxRead = true;
    return route.fulfill({ json: attention() });
  });
  await page.route(`**/api/v1/sessions/${sessionId}/terminals**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      mutations.push(request.method());
      await route.abort();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname.endsWith('/events')) {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'status', terminal })}\n\n`,
      });
    } else {
      await route.fulfill({
        json: url.pathname.endsWith('/terminals')
          ? {
              target: terminal.target,
              available: true,
              reason: null,
              shells: [{ id: 'bash', label: 'Bash' }],
              terminals: [terminal],
            }
          : terminal,
      });
    }
  });
  // The global attention query must find this session before its project or terminal was opened.
  await page.reload();
  const sidebar = page.getByTestId('app-sidebar');
  const attentionLink = sidebar.getByRole('link', {
    name: /Observed terminal owner Terminal needs attention/,
  });
  const terminalPath = `/sessions/${sessionId}?panel=terminal&terminal=${terminal.terminalId}`;
  await expect(attentionLink).toBeVisible();
  await expect(attentionLink).toHaveAttribute('href', terminalPath);
  expect(projectInboxRead).toBe(false);
  expect(corral.server.coordinator.listRuns()).toEqual([]);
  await attentionLink.click();
  await expect(page).toHaveURL(`${corral.server.url}${terminalPath}`);
  const panel = page.getByTestId('terminal-panel');
  await expect(panel).toBeVisible();
  await sidebar.getByRole('link', { name: 'Unvisited terminal project', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'Pending actions (1)', exact: true });
  await expect(inbox).toContainText(
    'Observed terminal owner · Terminal termination needs confirmation',
  );
  await page.getByRole('combobox', { name: 'Session status', exact: true }).click();
  await page.getByRole('option', { name: 'Needs attention', exact: true }).click();
  const sessionRow = page
    .getByRole('list', { name: 'Sessions', exact: true })
    .getByRole('link', { name: /Observed terminal owner/ });
  await expect(sessionRow).toBeVisible();
  await expect(sessionRow).toContainText('Terminal needs attention');
  await expect(sessionRow).toHaveAttribute('href', terminalPath);
  await expect(inbox.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute(
    'href',
    terminalPath,
  );
  await inbox.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(`${corral.server.url}${terminalPath}`);
  await expect(panel).toBeVisible();
  terminal = { ...terminal, state: 'running' };
  await panel.getByRole('button', { name: 'Refresh terminals' }).click();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  const notice = page.getByTestId('terminal-writer-notice');
  await expect(notice).toContainText('A terminal is holding this working copy');
  await notice.getByRole('link', { name: 'Open terminal controls' }).click();
  await expect(panel).toContainText('Releasing input only disconnects this view’s keyboard');
  terminal = {
    ...terminal,
    state: 'uncertain',
    replayAvailable: false,
    error: 'Legacy terminal observation is missing',
    diagnostic: { phase: 'recovery', code: 'host_restart_required' },
  };
  await panel.getByRole('button', { name: 'Refresh terminals' }).click();
  const recovery = panel.getByTestId('terminal-recovery-guidance');
  await expect(recovery).toContainText('restart its operating system');
  await expect(recovery).toContainText('Restarting only the Corral app is insufficient');
  await expect(panel.getByRole('button', { name: 'Stop and verify', exact: true })).toBeEnabled();
  await expect(
    panel.getByText('Legacy terminal observation is missing', { exact: true }),
  ).toBeHidden();
  await page.evaluate(() => localStorage.setItem('corral:locale', 'ko'));
  await page.reload();
  await expect(recovery).toContainText('운영체제를 재시작');
  await expect(panel.getByRole('button', { name: '종료하고 확인', exact: true })).toBeEnabled();
  await panel.screenshot({ path: test.info().outputPath('terminal-recovery-ko.png') });
  await page.evaluate(() => localStorage.setItem('corral:locale', 'en'));
  await page.reload();
  await expect(
    page.getByRole('tab').getByRole('img', { name: 'Terminal termination needs confirmation' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(notice).toContainText('termination has not been confirmed');
  await notice.screenshot({ path: test.info().outputPath('terminal-uncertain-notice.png') });
  await notice.getByRole('link', { name: 'Open terminal controls' }).click();
  const { diagnostic: _diagnostic, ...ended } = terminal;
  terminal = { ...ended, state: 'exited', exitCode: 0, error: null };
  await panel.getByRole('button', { name: 'Refresh terminals' }).click();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('terminal ownership explains refusal and explicit stop restores sending without a reload', async ({
  page,
  corral,
}) => {
  test.skip(process.platform !== 'linux', 'PTY cleanup is qualified on Linux');
  const original = mkdtempSync(join(tmpdir(), 'corral-e2e-terminal-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    git('init', '-q');
    writeFileSync(join(original, 'README.md'), 'terminal fixture\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/');
    await api(page, '/projects/default/workspace', 'PUT', { path: original });
    await api(page, '/projects/default/workspace', 'PATCH', { trusted: true });
    const created = await api(page, '/sessions', 'POST', {
      projectId: 'default',
      title: 'Terminal recovery',
    });
    const sessionId = created.session.sessionId as string;
    await corral.open(`/sessions/${sessionId}`);
    const openTerminal = page
      .getByRole('banner')
      .getByRole('button', { name: 'Terminal', exact: true });
    await openTerminal.click();
    const panel = page.getByTestId('terminal-panel');
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await page.getByRole('button', { name: /Make a working copy from/ }).click();
    await openTerminal.click();
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(panel.getByText('Running', { exact: true })).toBeVisible();
    const input = panel.getByRole('textbox', { name: 'Terminal output and input' });
    await input.pressSequentially('sleep 120');
    await input.press('Enter');
    await panel.getByRole('button', { name: 'Release input', exact: true }).click();
    await expect(panel).toContainText('Releasing input only disconnects this view’s keyboard');
    await expect(panel.getByRole('button', { name: 'Stop terminal', exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(page.getByTestId('terminal-writer-notice')).toContainText(
      'A terminal is holding this working copy',
    );
    await page
      .getByTestId('terminal-writer-notice')
      .screenshot({ path: test.info().outputPath('terminal-before-send.png') });
    await expect(
      page
        .getByTestId('terminal-writer-notice')
        .getByRole('link', { name: 'Open terminal controls' }),
    ).toBeVisible();
    await requestBox(page).fill('Summarize the fixture');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const refusal = page.getByTestId('refusal').last();
    await expect(refusal).toHaveAttribute('data-kind', 'terminal');
    const sidebarSession = page
      .getByTestId('app-sidebar')
      .getByRole('link', { name: /Terminal recovery/ });
    await expect(sidebarSession).toBeVisible();
    await expect(
      page.getByTestId('app-sidebar').getByRole('img', { name: 'Failed', exact: true }),
    ).toHaveCount(0);
    await expect(refusal).toContainText('A terminal is holding this working copy');
    await expect(refusal.getByText(/working copy terminal writer/)).not.toBeVisible();
    await refusal.getByRole('link', { name: 'Open terminal controls' }).click();
    await panel.getByRole('button', { name: 'Stop terminal', exact: true }).click();
    await expect(panel.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(sidebarSession).toBeVisible();
    await expect(panel.getByText('Exit code 0', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(page.getByTestId('terminal-writer-notice')).toHaveCount(0);
    await expect(requestBox(page)).toHaveValue('Summarize the fixture');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await openTerminal.click();
    await expect(
      panel.getByText('Wait for the current Run to finish, then create a terminal.'),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'New terminal', exact: true })).toBeEnabled({
      timeout: 20000,
    });
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await expect(
      page.getByTestId('chat-timeline').getByText('Succeeded', { exact: true }),
    ).toBeVisible();
    await expect(sidebarSession).toBeVisible();
    await expect(
      page.getByTestId('app-sidebar').getByRole('img', { name: 'Failed', exact: true }),
    ).toHaveCount(0);
  } finally {
    rmSync(original, { recursive: true, force: true });
  }
});

test('a rapid keyboard burst survives a real HTTP 429 with ordered PTY input and a live tab indicator', async ({
  page,
  corral,
}) => {
  test.skip(process.platform !== 'linux', 'PTY cleanup is qualified on Linux');
  const original = mkdtempSync(join(tmpdir(), 'corral-e2e-terminal-burst-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    git('init', '-q');
    writeFileSync(join(original, 'README.md'), 'terminal burst fixture\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/');
    await api(page, '/projects/default/workspace', 'PUT', { path: original });
    await api(page, '/projects/default/workspace', 'PATCH', { trusted: true });
    const created = await api(page, '/sessions', 'POST', {
      projectId: 'default',
      title: 'Terminal burst',
    });
    const sessionId = created.session.sessionId as string;
    await api(page, `/sessions/${sessionId}/worktree`, 'POST');
    await corral.open(`/sessions/${sessionId}?panel=terminal`);
    const panel = page.getByTestId('terminal-panel');
    await panel.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(panel.getByText('This view controls input.', { exact: true })).toBeVisible();
    const indicator = page.getByRole('tab').getByRole('img', { name: 'Terminal running' });
    await expect(indicator).toBeInViewport();
    const terminalList = await api(page, `/sessions/${sessionId}/terminals`, 'GET');
    const terminalId = terminalList.terminals[0].terminalId as string;
    const input = panel.getByRole('textbox', { name: 'Terminal output and input' });
    await input.click();
    // Malformed input consumes the same pre-dispatch limiter without touching the PTY.
    const primed = await page.evaluate(
      async ({ sessionId, terminalId }) => {
        const session = await (await fetch('/api/v1/session')).json();
        return Promise.all(
          Array.from(
            { length: 3 },
            async () =>
              (
                await fetch(`/api/v1/sessions/${sessionId}/terminals/${terminalId}/input`, {
                  method: 'POST',
                  headers: {
                    'x-corral-csrf': session.csrfToken,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({ data: 'x'.repeat(90_000) }),
                })
              ).status,
          ),
        );
      },
      { sessionId, terminalId },
    );
    expect(primed).toContain(429);
    const responses: number[] = [];
    page.on('response', (response) => {
      if (
        response.url().endsWith(`/terminals/${terminalId}/input`) &&
        response.request().postDataJSON()?.data
      )
        responses.push(response.status());
    });
    const payload = `burst-${'a0123456789'.repeat(100)}`;
    await Promise.all([
      input.pressSequentially(`printf '%s' '${payload}' > burst.txt\r`),
      expect(
        panel.getByText(
          'Input is arriving too quickly. It is kept in order and will resume shortly.',
        ),
      ).toBeVisible(),
    ]);
    await expect
      .poll(async () => {
        try {
          return (await api(page, `/sessions/${sessionId}/worktree/document?path=burst.txt`, 'GET'))
            .content?.text;
        } catch {
          return undefined;
        }
      })
      .toBe(payload);
    expect(responses).toContain(429);
    expect(responses.length).toBeLessThan(payload.length / 2);
    await expect(
      panel.getByText('The last input acknowledgement was lost. Input is paused.'),
    ).toHaveCount(0);
    await input.pressSequentially("printf 'continued' > continued.txt\r");
    await expect
      .poll(async () => {
        try {
          return (
            await api(page, `/sessions/${sessionId}/worktree/document?path=continued.txt`, 'GET')
          ).content?.text;
        } catch {
          return undefined;
        }
      })
      .toBe('continued');
    await panel.getByRole('button', { name: 'Stop terminal', exact: true }).click();
    await expect(panel.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(indicator).toHaveCount(0);
    await corral.restart();
    await corral.open(`/sessions/${sessionId}?panel=terminal`);
    await expect(panel).toContainText('This terminal has ended; you can create a new terminal.');
    await expect(panel).not.toContainText('Stop this terminal before creating another');
  } finally {
    rmSync(original, { recursive: true, force: true });
  }
});
