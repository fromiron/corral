import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalView } from '@corral/contracts';
import type { Page } from '@playwright/test';
import {
  bottomDock,
  dockToggle,
  lastRunSucceeded,
  openDock,
  openPanelTab,
  requestBox,
  terminalAction,
  terminalScreen,
} from '../workbench.ts';
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

// The ⋯ menu's input row is one line: a row's second line is only an unavailable row's reason,
// and the composer's notice is what says the terminal holds the Paddock.
async function expectInputRowAlone(page: Page) {
  await terminalScreen(page).getByRole('button', { name: 'Terminal actions', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: /^(Release input|Take control|Take over input)$/ }),
  ).toBeVisible();
  await expect(menu).not.toContainText('free the Paddock');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
}

/** A terminal's tab in the bottom dock, by its name ("Terminal 1"). */
const dockTab = (page: Page, name: string) =>
  bottomDock(page)
    .getByRole('tablist', { name: 'Bottom dock tabs', exact: true })
    .getByRole('tab', { name, exact: true });

/** Closes a terminal's tab, which ends the terminal; a dialog asks when a command may be running. */
async function endByClosing(page: Page, name: string) {
  await bottomDock(page)
    .getByRole('button', { name: `Close ${name}`, exact: true })
    .click();
  const ask = page.getByRole('dialog', { name: 'End the terminal?', exact: true });
  if (await ask.isVisible().catch(() => false))
    await ask.getByRole('button', { name: 'End', exact: true }).click();
  await expect(dockTab(page, name)).toHaveCount(0);
}

/**
 * Makes a terminal from the empty dock's 터미널 row. With more than one shell the row lists them
 * (features/session-panel.md "+" 목록), and the first is chosen.
 */
async function makeTerminalFromDock(page: Page) {
  const row = bottomDock(page).getByRole('button', { name: 'Terminal', exact: true });
  await expect(row).toBeVisible();
  await row.click();
  const shells = page.getByRole('menu', { name: 'Terminal', exact: true });
  const listed = await shells
    .waitFor({ state: 'visible', timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  if (listed) await shells.getByRole('menuitem').first().click();
}

/** Closes the bottom dock with its button. */
async function closeDock(page: Page) {
  await dockToggle(page).click();
  await expect(dockToggle(page)).toHaveAttribute('aria-pressed', 'false');
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
    foreground: 'unknown',
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
  // A terminal with no tab opens in the bottom dock; the address goes back to the panel's look.
  const panel = terminalScreen(page);
  await expect(panel).toBeVisible();
  await expect(dockTab(page, 'Terminal 1')).toHaveAttribute('aria-selected', 'true');
  await sidebar.getByRole('link', { name: 'Unvisited terminal project', exact: true }).click();
  // The project header counts the item; Needs you lists it (docs/specs/features/inbox.md).
  const summary = page.getByRole('link', { name: '1 pending', exact: true });
  await expect(summary).toBeVisible();
  const sessionRow = page
    .getByRole('list', { name: 'Needs attention', exact: true })
    .getByRole('link', { name: /Observed terminal owner/ });
  await expect(sessionRow).toBeVisible();
  await expect(sessionRow).toContainText('Terminal needs attention');
  await expect(sessionRow).toHaveAttribute('href', terminalPath);
  await summary.click();
  // Only this project has an item, so the row does not name it (inbox.md: "프로젝트 이름은
  // 목록에 프로젝트가 둘 이상일 때만 보인다").
  await page
    .getByRole('list', { name: 'Waiting for you', exact: true })
    .getByRole('button', {
      name: 'Observed terminal owner · Terminal exit needs checking',
      exact: true,
    })
    .click();
  const open = page
    .getByRole('region', { name: 'Observed terminal owner', exact: true })
    .getByRole('link', { name: 'Open terminal', exact: true });
  await expect(open).toHaveAttribute('href', terminalPath);
  await open.click();
  await expect(panel).toBeVisible();
  terminal = { ...terminal, state: 'running' };
  await terminalAction(page, 'Refresh terminals');
  await closeDock(page);
  const notice = page.getByTestId('terminal-writer-notice');
  await expect(notice).toContainText('A terminal is holding this Paddock');
  await notice.getByRole('link', { name: 'Open terminal controls' }).click();
  await expect(panel).toBeVisible();
  await expectInputRowAlone(page);
  terminal = {
    ...terminal,
    state: 'uncertain',
    replayAvailable: false,
    error: 'Legacy terminal observation is missing',
    diagnostic: { phase: 'recovery', code: 'host_restart_required' },
  };
  await terminalAction(page, 'Refresh terminals');
  const recovery = panel.getByTestId('terminal-recovery-guidance');
  await expect(recovery).toContainText('restart its operating system');
  await expect(recovery).toContainText('Restarting only the Corral app is insufficient');
  // Closing the tab is what checks termination again; the tab says the state.
  await expect(dockTab(page, 'Terminal 1')).toHaveAccessibleDescription('Termination unconfirmed');
  await expect(
    panel.getByText('Legacy terminal observation is missing', { exact: true }),
  ).toBeHidden();
  await page.evaluate(() => localStorage.setItem('corral:locale', 'ko'));
  await page.reload();
  await expect(recovery).toContainText('운영체제를 재시작');
  await expect(
    page
      .getByRole('region', { name: '하단 도크', exact: true })
      .getByRole('tab', { name: '터미널 1', exact: true }),
  ).toHaveAccessibleDescription('종료 확인 필요');
  await panel.screenshot({ path: test.info().outputPath('terminal-recovery-ko.png') });
  await page.evaluate(() => localStorage.setItem('corral:locale', 'en'));
  await page.reload();
  await expect(dockTab(page, 'Terminal 1')).toHaveAccessibleDescription('Termination unconfirmed');
  await closeDock(page);
  await expect(notice).toContainText('termination has not been confirmed');
  await notice.screenshot({ path: test.info().outputPath('terminal-uncertain-notice.png') });
  await notice.getByRole('link', { name: 'Open terminal controls' }).click();
  const { diagnostic: _diagnostic, ...ended } = terminal;
  terminal = { ...ended, state: 'exited', exitCode: 0, error: null };
  await terminalAction(page, 'Refresh terminals');
  await closeDock(page);
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
    // No Paddock yet: the empty dock says so in one line, with the way to set one up.
    await openDock(page);
    await expect(bottomDock(page)).toContainText('This conversation has no Paddock');
    await expect(
      bottomDock(page).getByRole('button', { name: 'Set up a Paddock', exact: true }),
    ).toBeVisible();
    await openPanelTab(page, 'Changes');
    await page.getByRole('button', { name: /Make a Paddock from/ }).click();
    // The list is read again once the Paddock is made: the dock's body lists 터미널.
    await makeTerminalFromDock(page);
    await expect(dockTab(page, 'Terminal 1')).toHaveAccessibleDescription('Running');
    const panel = terminalScreen(page);
    const input = panel.getByRole('textbox', { name: 'Terminal output and input' });
    await input.pressSequentially('sleep 120');
    await input.press('Enter');
    await terminalAction(page, /Release input/);
    await expectInputRowAlone(page);
    await closeDock(page);
    await expect(page.getByTestId('terminal-writer-notice')).toContainText(
      'A terminal is holding this Paddock',
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
    // Said once, on the refused message's meta line; the composer does not say it again.
    const refusal = page
      .locator('[data-chat-item]')
      .filter({ hasText: 'Summarize the fixture' })
      .getByTestId('entry-status');
    await expect(refusal).toContainText('A terminal is holding this Paddock');
    await expect(page.getByTestId('refusal')).toHaveCount(0);
    const sidebarSession = page
      .getByTestId('app-sidebar')
      .getByRole('link', { name: /Terminal recovery/ });
    await expect(sidebarSession).toBeVisible();
    await expect(
      page.getByTestId('app-sidebar').getByRole('img', { name: 'Failed', exact: true }),
    ).toHaveCount(0);
    await expect(refusal).toContainText('A terminal is holding this Paddock');
    await expect(refusal.getByText(/working copy terminal writer/)).not.toBeVisible();
    await refusal.getByRole('link', { name: 'Open terminal controls' }).click();
    await expect(panel).toBeVisible();
    // Closing its tab ends the terminal; `sleep 120` is running, so it asks first.
    await endByClosing(page, 'Terminal 1');
    await expect(sidebarSession).toBeVisible();
    await closeDock(page);
    await expect(page.getByTestId('terminal-writer-notice')).toHaveCount(0);
    await expect(requestBox(page)).toHaveValue('Summarize the fixture');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // While the run goes, the empty dock's 터미널 row is unusable and says why; it becomes usable
    // when the run ends, and makes nothing by itself.
    await openDock(page);
    const blocked = bottomDock(page).getByRole('button', { name: /^Terminal/ });
    await expect(blocked).toContainText(
      'Wait for the current Run to finish, then create a terminal.',
    );
    await expect(blocked).toHaveAttribute('aria-disabled', 'true');
    await expect(blocked).not.toHaveAttribute('aria-disabled', 'true', { timeout: 20000 });
    await expect(dockTab(page, 'Terminal 2')).toHaveCount(0);
    await closeDock(page);
    await expect(lastRunSucceeded(page)).toBeVisible({ timeout: 20_000 });
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
    // panel=terminal with no live terminal makes one in the bottom dock.
    await corral.open(`/sessions/${sessionId}?panel=terminal`);
    const panel = terminalScreen(page);
    await expect(panel).toBeVisible();
    // The terminal draws in the monospace family of the token, with its ligatures off.
    const drawn = await panel
      .locator('.xterm-rows')
      .evaluate((rows) => getComputedStyle(rows))
      .then(({ fontFamily, fontFeatureSettings }) => ({ fontFamily, fontFeatureSettings }));
    expect(drawn.fontFamily.startsWith('"JetBrains Mono"')).toBe(true);
    expect(drawn.fontFeatureSettings).toContain('"liga" 0');
    expect(drawn.fontFeatureSettings).toContain('"calt" 0');
    await panel.getByRole('button', { name: 'Terminal actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /Release input/ })).toBeVisible();
    await page.keyboard.press('Escape');
    const indicator = dockTab(page, 'Terminal 1');
    await expect(indicator).toHaveAccessibleDescription('Running');
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
    // Closing its tab ends the terminal (asking if a command may still run).
    await endByClosing(page, 'Terminal 1');
    await expect(indicator).toHaveCount(0);
    await corral.restart();
    // After the restart the ended terminal holds nothing: the dock opens to its list, whose
    // 터미널 row makes a new one (the toggle itself makes none).
    await corral.open(`/sessions/${sessionId}`);
    await openDock(page);
    await expect(dockTab(page, 'Terminal 2')).toHaveCount(0);
    await makeTerminalFromDock(page);
    await expect(dockTab(page, 'Terminal 2')).toHaveAccessibleDescription('Running');
    await expect(bottomDock(page)).not.toContainText('Stop this terminal before creating another');
  } finally {
    rmSync(original, { recursive: true, force: true });
  }
});

test('the bottom dock opens at its 240px under an empty conversation, whose centered composer leaves the message area room', async ({
  page,
  corral,
}) => {
  await corral.open('/');
  const created = await api(page, '/sessions', 'POST', {
    projectId: 'default',
    title: 'Dock room',
  });
  await corral.open(`/sessions/${created.session.sessionId as string}`);
  await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
  await openDock(page);
  const dock = bottomDock(page);
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  expect(Math.round(box?.height ?? 0)).toBe(240);
  // The composer stays whole above it.
  await expect(requestBox(page)).toBeInViewport();
});
