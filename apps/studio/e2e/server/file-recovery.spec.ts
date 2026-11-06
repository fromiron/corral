import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { expect, test } from './harness.ts';

async function api(page: Page, path: string, method = 'GET', body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          'x-corral-csrf': csrfToken,
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

for (const locale of ['en', 'ko'] as const) {
  test(`file recovery confirms revert, preserves external edits, and disables unchanged restores (${locale})`, async ({
    page,
    corral,
  }) => {
    const m = locale === 'en' ? en : ko;
    const original = mkdtempSync(join(tmpdir(), 'corral-e2e-recovery-'));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
          { cwd: original },
        );
      git('init', '-q');
      for (const name of ['a.txt', 'b.txt']) writeFileSync(join(original, name), 'before\n');
      git('add', '.');
      git('commit', '-qm', 'fixture');
      await page.addInitScript(
        (language) => localStorage.setItem('corral:locale', language),
        locale,
      );
      await corral.open('/');
      await api(page, '/projects/default/workspace', 'PUT', { path: original });
      await api(page, '/projects/default/workspace', 'PATCH', { trusted: true });
      const { session } = await api(page, '/sessions', 'POST', {
        projectId: 'default',
        title: 'File recovery',
      });
      const sessionId = session.sessionId as string;
      await api(page, `/sessions/${sessionId}/worktree`, 'POST');
      for (const [index, path] of ['a.txt', 'b.txt'].entries()) {
        const document = await api(page, `/sessions/${sessionId}/worktree/document?path=${path}`);
        await api(page, `/sessions/${sessionId}/worktree/documents`, 'POST', {
          kind: 'save',
          operationId: `write_${index}`,
          target: document.target,
          path,
          baseHash: document.version.sha256,
          text: 'applied\n',
          editVersion: 1,
        });
      }
      await page.goto(`${corral.server.url}/sessions/${sessionId}/review`);
      await page.getByRole('button', { name: m.Review.approve, exact: true }).click();
      await page.getByRole('button', { name: m.Review.plan, exact: true }).click();
      await expect(page.getByTestId('integration-plan')).toContainText('a.txt');
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'Apply 2 files' : '파일 2개 반영',
          exact: true,
        })
        .click();
      const integration = page.getByTestId('integration').first();
      await expect(integration).toContainText(m.Review.integrationState.applied);
      writeFileSync(join(original, 'b.txt'), 'external edit\n');
      await integration.getByRole('button', { name: m.Review.revert, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(m.Review.confirmRevertNote);
      await expect(dialog).toContainText('a.txt');
      await dialog.screenshot({
        path: test.info().outputPath(`revert-confirmation-${locale}.png`),
      });
      expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('applied\n');
      await dialog.getByRole('button', { name: m.Review.cancelRevert, exact: true }).click();
      expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('applied\n');
      await integration.getByRole('button', { name: m.Review.revert, exact: true }).click();
      await dialog.getByRole('button', { name: m.Review.confirmRevert, exact: true }).click();
      await expect(integration).toContainText(m.Review.integrationState.partlyReverted);
      await expect(integration).toContainText(m.Review.fileOutcome.revert_conflict);
      expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('before\n');
      expect(readFileSync(join(original, 'b.txt'), 'utf8')).toBe('external edit\n');
      for (const label of ['First checkpoint', 'Second checkpoint']) {
        await api(page, `/sessions/${sessionId}/checkpoints`, 'POST', {
          checkpointId: label.startsWith('First') ? 'checkpoint_first' : 'checkpoint_second',
          label,
        });
      }
      await page.goto(`${corral.server.url}/sessions/${sessionId}?panel=changes`);
      await page.getByRole('button', { name: m.Workbench.backToGit, exact: true }).click();
      const checkpoints = page.getByRole('region', { name: m.Checkpoints.heading, exact: true });
      const second = checkpoints
        .getByTestId('checkpoint-row')
        .filter({ hasText: 'Second checkpoint' });
      await expect(
        checkpoints.getByTestId('checkpoint-row').filter({ hasText: 'First checkpoint' }),
      ).toBeVisible();
      await expect(second).toContainText(m.Checkpoints.unchanged);
      await expect(second.locator('time')).toBeVisible();
      await second.getByRole('button', { name: m.Checkpoints.preview, exact: true }).click();
      const preview = checkpoints.getByRole('region', { name: m.Checkpoints.preview, exact: true });
      await expect(preview).toContainText(m.Checkpoints.alreadyMatches);
      await preview.screenshot({
        path: test.info().outputPath(`unchanged-checkpoint-${locale}.png`),
      });
      await expect(
        preview.getByRole('button', { name: m.Checkpoints.restore, exact: true }),
      ).toBeDisabled();
      const history = await api(page, `/sessions/${sessionId}/checkpoints`);
      expect(history.restores).toHaveLength(0);
      expect(
        history.checkpoints.some(
          (item: { label: string }) => item.label === 'Before integration revert',
        ),
      ).toBe(true);
    } finally {
      rmSync(original, { recursive: true, force: true });
    }
  });
}
