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
import { openTextSearch } from '../workbench.ts';
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

    // workbench.md (세션 목록과 검색: 접힌 머리글에 목적 앞부분을 표시한다): the new conversation's
    // details are a dialog; once it is closed, the menu item that opens it shows the purpose.
    test('collapsed objective has a visible summary', async ({ page, corral }) => {
      await corral.open('/');
      const more = page.getByRole('button', {
        name: m.Workspace.newConversationMenu,
        exact: true,
      });
      const details = page.getByRole('menuitem', {
        name: new RegExp(`^${m.Workspace.detailsFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      });
      await more.click();
      await details.click();
      await page
        .getByRole('textbox', { name: m.Sessions.objectiveLabel, exact: true })
        .fill('Objective-only summary');
      await page.keyboard.press('Escape');
      await more.click();
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
          page
            .getByTestId('app-sidebar')
            .locator(`a[href="/sessions/${session.sessionId}?compose=true"]`),
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
        projectId: 'default',
      });
      const staleNow = Date.now() - 120_000;
      await page.clock.setFixedTime(new Date(staleNow));
      // A project's teams are in the library (the old project address replaces itself there).
      await page.goto(`${corral.server.url}/library/teams?project=default`);
      await page.reload();
      const teams = page.getByRole('table', { name: m.Library.teams.list, exact: true });
      await teams.getByRole('button', { name: definition.name, exact: true }).click();
      await page
        .getByRole('region', { name: m.Library.teams.detail, exact: true })
        .getByRole('button', { name: m.Workspace.duplicate, exact: true })
        .click();
      await expect.poll(async () => ((await api(page, '/corrals')) as unknown[]).length).toBe(2);
      const corrals = (await api(page, '/corrals')) as {
        corralId: string;
        name: string;
        updatedAt: string;
      }[];
      const copy = corrals.find((item) => item.corralId !== team.corralId);
      expect(copy).toBeTruthy();
      expect(Date.parse(copy?.updatedAt ?? '')).toBeGreaterThan(staleNow);
      const row = teams
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: copy?.name ?? '', exact: true }) });
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
        await files.getByRole('treeitem', { name: 'README.md', exact: true }).click();
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
      test('shows the kept original-case body and preserves its source target', async ({
        page,
        corral,
      }) => {
        await corral.open('/');
        const team = await api(page, '/corrals', {
          definition: linearCorral(['first', 'second']),
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
        const dialog = await openTextSearch(page, '', m);
        await dialog.getByRole('textbox', { name: m.SessionSearch.query }).fill('needle');
        await expect(dialog.getByRole('switch', { name: m.SessionSearch.private })).toHaveAttribute(
          'aria-checked',
          'false',
        );
        await expect(dialog.locator('mark')).toHaveCount(0);
        await dialog.getByRole('switch', { name: m.SessionSearch.private }).click();
        // Run #2's success released Run #1's bodies and the search rows made from them
        // (api-contract.md, 산출물 본문 수명), so one original-case body is found, Run #2's.
        await expect(dialog.locator('mark')).toHaveText(['ＮｅＥｄＬｅ']);
        const found = dialog.getByRole('link').filter({ hasText: 'Original ﬃ ＮｅＥｄＬｅ CASE.' });
        await expect(found).toHaveCount(1);
        await expect(found).toContainText(`${locale === 'en' ? 'Run' : '실행'} #2`);
        const target = new URL((await found.getAttribute('href')) ?? '', page.url());
        expect(target.searchParams.has('result')).toBe(true);
        expect(target.searchParams.has('run')).toBe(true);
        const search = await api(page, '/sessions/search', {
          query: 'needle',
          includeTranscript: true,
        });
        expect(search.hits.map((item: { runNumber: number }) => item.runNumber)).toEqual([2]);
        const hit = search.hits[0];
        const source = (hit.sources ?? [hit]).find(
          (item: { artifactVersionId: string | null }) => item.artifactVersionId,
        );
        const projection = corral.server.coordinator.getSnapshot(hit.runId).projection;
        // The body found is the first step's result, not the run's default result.
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
