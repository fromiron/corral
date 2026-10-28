import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkSession } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { runResults } from '../../../../packages/react/src/run/results.ts';
import { expect, test } from './harness.ts';

async function api(page: Page, path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'x-corral-csrf': csrfToken, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
      if (response.status === 204) return null;
      const value = await response.json();
      return value.session ?? value.record ?? value;
    },
    { path, body, method },
  );
}

for (const locale of ['en', 'ko'] as const) {
  const m = locale === 'en' ? en : ko;
  test.describe(`session followups ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(
        (language) => localStorage.setItem('corral:locale', language),
        locale,
      );
    });

    test('collapsed objective has a visible summary', async ({ page, corral }) => {
      await corral.open('/');
      const details = page.getByRole('button', {
        name: new RegExp(m.Navigation.sessionDetails.replace(/[()]/g, '\\$&')),
      });
      await details.click();
      await page
        .getByRole('textbox', { name: m.Sessions.objectiveLabel, exact: true })
        .fill('Objective-only summary');
      await details.click();
      await expect(details).toContainText('Objective-only summary');
    });

    test('archived project rows restore both meetings and ordinary sessions', async ({
      page,
      corral,
    }) => {
      await corral.open('/');
      const sessions: WorkSession[] = [];
      for (const meeting of [false, true]) {
        const session = await api(page, '/sessions', {
          projectId: 'default',
          title: meeting ? 'Archived meeting' : 'Archived work',
          ...(meeting
            ? {
                meeting: {
                  version: 1,
                  participants: [
                    { participantId: 'one', name: 'One', prompt: '', modelProfile: 'model-a' },
                    { participantId: 'two', name: 'Two', prompt: '', modelProfile: 'model-b' },
                  ],
                  secretary: { modelProfile: 'model-a' },
                },
              }
            : {}),
        });
        sessions.push(
          await api(
            page,
            `/sessions/${session.sessionId}`,
            { archived: true, expectedRevision: session.revision },
            'PATCH',
          ),
        );
      }
      await page.reload();
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'Show archived (2)' : '보관한 세션 보기(2)',
        })
        .click();
      for (const session of sessions) {
        const row = page
          .getByRole('list', { name: m.Sessions.heading, exact: true })
          .getByRole('listitem')
          .filter({ hasText: session.title });
        await row.getByRole('button', { name: new RegExp(m.Sessions.restoreSession) }).click();
        await expect(
          page.getByTestId('app-sidebar').locator(`a[href="/sessions/${session.sessionId}"]`),
        ).toBeVisible();
        expect((await api(page, `/sessions/${session.sessionId}`)).archivedAt).toBeNull();
      }
    });

    test('new team timestamps never read as future against a stale browser clock', async ({
      page,
      corral,
    }) => {
      await corral.open('/');
      const definition = linearCorral(['writer']);
      const team = await api(page, '/corrals', {
        definition,
        layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
        projectId: 'default',
      });
      const staleNow = Date.now() - 120_000;
      await page.clock.setFixedTime(new Date(staleNow));
      await page.goto(`${corral.server.url}/projects/default#corrals`);
      await page.reload();
      await page.getByRole('button', { name: m.Workspace.duplicate, exact: true }).click();
      const corrals = (await api(page, '/corrals')) as { corralId: string; updatedAt: string }[];
      const copy = corrals.find((item) => item.corralId !== team.corralId);
      expect(copy).toBeTruthy();
      expect(Date.parse(copy?.updatedAt ?? '')).toBeGreaterThan(staleNow);
      const row = page
        .getByRole('list', { name: m.Workspace.heading, exact: true })
        .getByRole('listitem')
        .filter({ has: page.locator(`a[href="/corrals/${copy?.corralId}/edit"]`) });
      await expect(row).toContainText(m.Sessions.justNow);
      await test.info().attach('timestamp-comparison', {
        body: JSON.stringify({ staleNow, updatedAt: copy?.updatedAt }),
        contentType: 'application/json',
      });
    });

    test('Files keeps setup guidance visible while browsing without a working copy', async ({
      page,
      corral,
    }) => {
      const folder = mkdtempSync(join(tmpdir(), 'corral-session-file-guidance-'));
      try {
        execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', folder]);
        writeFileSync(join(folder, 'README.md'), 'Read-only original contents\n');
        execFileSync('git', ['-C', folder, 'add', 'README.md']);
        execFileSync('git', [
          '-C',
          folder,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-qm',
          'fixture',
        ]);
        await corral.open('/');
        await api(page, '/projects/default/workspace', { path: folder }, 'PUT');
        const session = await api(page, '/sessions', {
          projectId: 'default',
          title: 'File guidance',
        });
        await page.goto(`${corral.server.url}/sessions/${session.sessionId}?panel=files`);
        const files = page.getByTestId('file-panel');
        const setup = files.getByRole('link', { name: m.Sessions.prepareWorkingCopy });
        await expect(setup).toBeVisible();
        await expect(
          files.getByText(
            locale === 'en'
              ? 'Read-only: this session has no working copy.'
              : '작업 사본이 없어 읽기 전용입니다.',
          ),
        ).toBeVisible();
        await files.getByRole('button', { name: /README\.md/ }).click();
        await expect(
          files.getByText('Read-only original contents', { exact: false }),
        ).toBeVisible();
        await expect(setup).toBeVisible();
        await setup.click();
        await expect(page).toHaveURL(/panel=changes/);
        expect((await api(page, `/sessions/${session.sessionId}/worktree`)).worktree).toBeNull();
        expect((await api(page, '/projects/default/workspace')).binding.trusted).toBe(false);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    test.describe('folded search', () => {
      test.use({
        agentReply: {
          reply: (_turn, input) =>
            input.role.name === 'first'
              ? 'Original ﬃ ＮｅＥｄＬｅ CASE. No real model was called.'
              : 'Final control result without the searched text.',
        },
      });
      test('shows one original-case body per run and preserves each source target', async ({
        page,
        corral,
      }) => {
        await corral.open('/');
        const team = await api(page, '/corrals', {
          definition: linearCorral(['first', 'second']),
          layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
          projectId: 'default',
        });
        const session = await api(page, '/sessions', {
          projectId: 'default',
          title: 'Search fixture',
          corralId: team.corralId,
        });
        await page.goto(`${corral.server.url}/sessions/${session.sessionId}`);
        for (let i = 1; i <= 2; i++) {
          await page
            .getByRole('combobox', { name: locale === 'en' ? 'Request' : '요청', exact: true })
            .fill(`Start request ${i}`);
          await page
            .getByRole('button', { name: locale === 'en' ? 'Send' : '보내기', exact: true })
            .click();
          await expect
            .poll(
              () =>
                corral.server.coordinator.listRuns().filter((run) => run.status === 'succeeded')
                  .length,
            )
            .toBe(i);
          await page.reload();
        }
        await page
          .getByTestId('app-sidebar')
          .getByRole('button', { name: m.SessionSearch.title })
          .click();
        const dialog = page.getByRole('dialog', { name: m.SessionSearch.title });
        await dialog.getByRole('textbox', { name: m.SessionSearch.query }).fill('needle');
        await expect(dialog.getByRole('switch', { name: m.SessionSearch.private })).toHaveAttribute(
          'aria-checked',
          'false',
        );
        await expect(dialog.locator('mark')).toHaveCount(0);
        await dialog.getByRole('switch', { name: m.SessionSearch.private }).click();
        await expect(dialog.locator('details')).toHaveCount(2);
        await expect(dialog.locator('mark')).toHaveText(['ＮｅＥｄＬｅ', 'ＮｅＥｄＬｅ']);
        for (let number = 1; number <= 2; number++) {
          const row = dialog
            .locator('details')
            .filter({ hasText: `${locale === 'en' ? 'Run' : '실행'} #${number}` });
          await expect(row).toContainText('Original ﬃ ＮｅＥｄＬｅ CASE.');
          await row.locator('summary').click();
          const links = row.getByRole('link');
          expect(await links.count()).toBeGreaterThan(1);
          const targets = await links.evaluateAll((items) =>
            items.map((item) => (item as HTMLAnchorElement).href),
          );
          expect(targets.some((href) => new URL(href).searchParams.has('result'))).toBe(true);
          expect(targets.every((href) => new URL(href).searchParams.has('run'))).toBe(true);
        }
        const search = await api(page, '/sessions/search', {
          query: 'needle',
          includeTranscript: true,
        });
        const hit = search.hits.find((item: { runNumber: number }) => item.runNumber === 1);
        const source = hit.sources.find(
          (item: { artifactVersionId: string | null }) => item.artifactVersionId,
        );
        const projection = corral.server.coordinator.getSnapshot(hit.runId).projection;
        expect(source.artifactVersionId).not.toBe(runResults(projection).defaultId);
        await dialog.screenshot({ path: test.info().outputPath(`search-${locale}.png`) });
        await dialog.locator(`a[href*="${source.artifactVersionId}"]`).click();
        await expect(page.getByTestId('result-body')).toContainText(
          'Original ﬃ ＮｅＥｄＬｅ CASE.',
        );
        await expect(page.getByTestId('result-body')).not.toContainText('Final control result');
      });
    });
  });
}
