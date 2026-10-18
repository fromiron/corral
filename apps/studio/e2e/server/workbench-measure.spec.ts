import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

// 02-UX-Spec §11 measurement, run once on request (not part of the regular suite):
//   CORRAL_WORKBENCH_PERF=1 pnpm exec playwright test --project=server e2e/server/workbench-measure.spec.ts
// Targets (§11): warm session switch p95 ≤ 300 ms; choosing a changed file p95 ≤ 500 ms for a
// 200 KB text file among 300 changes. Plus no serious axe findings on the workbench screens.
// Local steps only; no model call is involved. Results are printed for docs/Performance.md.

test.skip(!process.env.CORRAL_WORKBENCH_PERF, 'measurement run: set CORRAL_WORKBENCH_PERF=1');

const SAMPLES = 20;
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number;
};

async function api(page: Page, path: string, method = 'GET', body?: unknown) {
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
      return response.status === 204 ? null : response.json();
    },
    { path, method, body },
  );
}

const serious = async (page: Page, exclude: string[] = []) => {
  let builder = new AxeBuilder({ page });
  for (const selector of exclude) builder = builder.exclude(selector);
  const violations = (await builder.analyze()).violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (violations.length)
    console.log(
      'WORKBENCH_AXE',
      JSON.stringify(
        violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            html: n.html,
            summary: n.failureSummary,
          })),
        })),
      ),
    );
  return violations.map((v) => `${v.id}: ${v.nodes.length} nodes`);
};

const bigText = (changeEvery: number | null) =>
  Array.from({ length: 4000 }, (_, i) =>
    changeEvery !== null && i % changeEvery === 0
      ? `changed ${i}`
      : `line ${String(i).padStart(5, '0')} ${'x'.repeat(38)}`,
  ).join('\n');

test('[§11] workbench timings and accessibility on a fixed workload', async ({ page, corral }) => {
  test.setTimeout(300_000);
  const throttled: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 429) throttled.push(new URL(response.url()).pathname);
  });
  const original = mkdtempSync(join(tmpdir(), 'corral-e2e-measure-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
        cwd: original,
      });
    git('init', '-q');
    writeFileSync(join(original, 'big.txt'), bigText(null));
    git('add', '.');
    git('commit', '-q', '-m', 'first');

    await corral.open('/');
    await api(page, '/projects/default/workspace', 'PUT', { path: original });
    await api(page, '/projects/default/workspace', 'PATCH', { trusted: true });
    const a = await api(page, '/sessions', 'POST', { projectId: 'default', title: 'Session A' });
    await api(page, '/sessions', 'POST', { projectId: 'default', title: 'Session B' });
    const sessionA = a.session.sessionId as string;
    // §11 fixture size: 30 projects and 500 sessions, all sessions in this project's sidebar.
    // Written straight into the workspace database: the API's request-rate limit is a
    // security boundary and is not lifted for a fixture.
    const require = createRequire(
      join(import.meta.dirname, '..', '..', '..', 'server', 'package.json'),
    );
    const Database = require('better-sqlite3');
    const db = new Database(join(corral.workspace, '.corral', 'corral.db'));
    const now = new Date().toISOString();
    db.transaction(() => {
      const project = db.prepare(
        `INSERT INTO projects (id, name, description, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, '', 1, ?, ?, NULL)`,
      );
      for (let i = 0; i < 29; i++) project.run(`project_fill${i}`, `Project ${i}`, now, now);
      const session = db.prepare(
        `INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision,
           created_at, updated_at, archived_at, entries_json)
         VALUES (?, 'default', NULL, ?, '', 0, 1, ?, ?, NULL, '[]')`,
      );
      for (let i = 0; i < 498; i++)
        session.run(`session_fill${i}`, `Filler session ${i}`, now, now);
    })();
    db.close();
    const made = await api(page, `/sessions/${sessionA}/worktree`, 'POST');
    expect(made.worktree, JSON.stringify(made)).toBeTruthy();

    // 300 new files and the 200 KB file with every 10th line changed, beside Corral.
    const root = `${corral.workspace}-worktrees`;
    const copy = join(root, readdirSync(root)[0] as string, sessionA);
    mkdirSync(join(copy, 'gen'), { recursive: true });
    for (let i = 0; i < 300; i++)
      writeFileSync(join(copy, 'gen', `file-${i}.ts`), `export const value${i} = ${i};\n`);
    writeFileSync(join(copy, 'big.txt'), bigText(10));

    const findings: Record<string, string[]> = {};
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Sessions', exact: true }).first(),
    ).toBeVisible();
    findings.project = await serious(page);

    const sidebar = page.getByRole('navigation', { name: 'Projects and sessions' });
    await page
      .getByTestId('app-sidebar')
      .getByRole('searchbox', { name: 'Search all sessions' })
      .fill('Session A');
    await sidebar.getByRole('link', { name: 'Session A' }).click();
    await page
      .getByTestId('app-sidebar')
      .getByRole('searchbox', { name: 'Search all sessions' })
      .fill('');
    await expect(page.getByRole('heading', { level: 2, name: 'Session A' })).toBeVisible();
    findings.session = await serious(page);

    await page.getByRole('link', { name: 'Open the review screen' }).click();
    const big = page.getByRole('button', { name: /big\.txt/ });
    await expect(big).toBeVisible({ timeout: 60_000 });
    findings.review = await serious(page);

    // Diff display: alternate a small file and the big one; time the big one.
    const small = page.getByRole('button', { name: /gen\/file-1\.ts/ });
    const diffTimes: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      await small.click();
      await expect(page.getByTestId('file-diff')).toContainText('gen/file-1.ts');
      const started = Date.now();
      await big.click();
      await expect(
        page
          .getByTestId('file-diff')
          .locator('[data-line-type="change-addition"]')
          .filter({ hasText: 'changed 0' })
          .first(),
      ).toBeVisible();
      diffTimes.push(Date.now() - started);
    }
    findings.reviewWithDiff = await serious(page);

    // Session switch (warm): between the two sessions from the sidebar.
    await page.getByRole('link', { name: '← Session A' }).click();
    const switchTimes: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const to = i % 2 === 0 ? 'Session B' : 'Session A';
      const started = Date.now();
      await sidebar.getByRole('link', { name: to }).click();
      await expect(page.getByRole('heading', { level: 2, name: to })).toBeVisible();
      switchTimes.push(Date.now() - started);
    }

    // Long tasks while the sidebar is resized from the keyboard (§11: input delay while resizing).
    const longTasks = await page.evaluate(async () => {
      const seen: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) seen.push(entry.duration);
      });
      observer.observe({ type: 'longtask', buffered: false });
      const splitter = document.querySelector<HTMLElement>('[role="separator"]');
      splitter?.focus();
      for (let i = 0; i < 20; i++) {
        splitter?.dispatchEvent(
          new KeyboardEvent('keydown', { key: i < 10 ? 'ArrowRight' : 'ArrowLeft', bubbles: true }),
        );
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      await new Promise((r) => setTimeout(r, 200));
      observer.disconnect();
      return seen;
    });

    const result = {
      resizeLongTasks: longTasks.length,
      resizeLongestMs: Math.round(Math.max(0, ...longTasks)),
      sessionsInSidebar: 500,
      diffP95Ms: p95(diffTimes),
      diffMaxMs: Math.max(...diffTimes),
      switchP95Ms: p95(switchTimes),
      switchMaxMs: Math.max(...switchTimes),
      samples: SAMPLES,
      findings,
    };
    console.log(`WORKBENCH_MEASURE ${JSON.stringify(result)}`);
    expect(throttled).toEqual([]);
    expect(findings).toEqual({ project: [], session: [], review: [], reviewWithDiff: [] });
    expect(result.diffP95Ms, 'diff display p95').toBeLessThanOrEqual(500);
    expect(result.switchP95Ms, 'session switch p95').toBeLessThanOrEqual(300);
  } finally {
    rmSync(original, { recursive: true, force: true });
  }
});
