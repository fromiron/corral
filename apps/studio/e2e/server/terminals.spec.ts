import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

async function api(page: Page, path: string, method: string, body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'x-corral-csrf': session.csrfToken, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      return response.json();
    },
    { path, method, body },
  );
}

test.use({ replyDelayMs: 2000 });
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
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
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
