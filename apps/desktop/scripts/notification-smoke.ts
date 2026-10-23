import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, expect } from '@playwright/test';
import { selectSessionTeam, startSession, teamFromTemplate } from '../../studio/e2e/workbench.ts';

type FixtureWindow = Window & {
  corralDesktop?: {
    notify(
      title: string,
      body: string,
      target?: { kind: string; sessionId: string; runId: string | null },
    ): Promise<boolean>;
    retry(): Promise<void>;
    onNotification(callback: () => void): () => void;
  };
};

// Only native display is intercepted. Real Notification click -> preload -> current Studio.
// Models use mock-only and all workspace/app data belongs to this short-lived fixture.
const data = mkdtempSync(join(tmpdir(), 'corral-notification-smoke-'));
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
env.LANG = 'en_US.UTF-8';
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({
  args: [resolve(import.meta.dirname, '..'), `--data-dir=${data}`, '--mock-only'],
  env,
  timeout: 30000,
});
try {
  await application.evaluate(({ Notification, dialog }) => {
    const state = globalThis as unknown as { notes: Electron.Notification[]; errors: string[] };
    state.notes = [];
    state.errors = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      state.notes.push(this);
    };
    dialog.showErrorBox = (title, message) => {
      state.errors.push(`${title}: ${message}`);
    };
  });
  const page = await application.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  await teamFromTemplate(page, 'Research team');
  await startSession(page, 'Notification target fixture');
  const sessionId = new URL(page.url()).pathname.split('/').at(-1);
  assert(sessionId);
  await selectSessionTeam(page, 'Research team');
  await page
    .getByRole('combobox', { name: 'Request', exact: true })
    .fill('Make a short review fixture.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('action-required')).toBeVisible({ timeout: 30000 });
  // The bridge payload is deliberately generic: no session title, request or result text.
  const target = await page.evaluate(async (session) => {
    const response = await fetch('/api/v1/projects/default/inbox');
    const items = (await response.json()) as {
      kind: string;
      sessionId: string;
      runId: string | null;
    }[];
    const item = items.find((value) => value.sessionId === session && value.kind === 'decision');
    if (!item?.runId) throw new Error('Fixture decision missing');
    return { kind: 'decision' as const, sessionId: item.sessionId, runId: item.runId };
  }, sessionId);
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  const before = page.url();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  assert(
    await page.evaluate(
      (target) =>
        (window as FixtureWindow).corralDesktop?.notify(
          'Action needed',
          'A request needs your attention.',
          target,
        ),
      target,
    ),
  );
  await application.evaluate(() => {
    (globalThis as unknown as { notes: Electron.Notification[] }).notes.at(-1)?.emit('click');
  });
  await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(target.runId);
  await expect(page.getByTestId('compact-run').locator('[data-testid^="approval-"]')).toBeVisible();
  assert.equal(new URL(page.url()).pathname, `/sessions/${sessionId}`);
  await page.screenshot({ path: '/tmp/corral-notification-target.png' });
  const documentIdentity = await page.evaluate(() => performance.timeOrigin);
  // A target removed from the current inbox must not send a late click to the latest Run.
  await page
    .getByTestId('compact-run')
    .getByRole('button', { name: 'Cancel whole run', exact: true })
    .click();
  await page
    .getByTestId('compact-run')
    .getByRole('button', { name: 'Confirm whole run cancellation', exact: true })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(async (runId) => {
        const response = await fetch('/api/v1/projects/default/inbox');
        return ((await response.json()) as { kind: string; runId: string | null }[]).some(
          (item) => item.kind === 'decision' && item.runId === runId,
        );
      }, target.runId),
    )
    .toBe(false);
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await application.evaluate(() => {
    (globalThis as unknown as { notes: Electron.Notification[] }).notes.at(-1)?.emit('click');
  });
  await page.waitForTimeout(250);
  assert.equal(page.url(), before);
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    documentIdentity,
    'notification navigation preserves the renderer and unsaved models',
  );
  // Existing two-argument callers still restore the window without inventing a destination.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  assert(
    await page.evaluate(() =>
      (window as FixtureWindow).corralDesktop?.notify('Corral', 'Legacy notification'),
    ),
  );
  await application.evaluate(() => {
    (globalThis as unknown as { notes: Electron.Notification[] }).notes.at(-1)?.emit('click');
  });
  assert.equal(page.url(), before);
  const restarting = page.waitForURL('corral://startup/');
  await page.evaluate(() => {
    void (window as FixtureWindow).corralDesktop?.retry();
  });
  await restarting;
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  await expect(page.getByRole('link', { name: 'All projects', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = window as unknown as { staleClicks: number };
    state.staleClicks = 0;
    (window as FixtureWindow).corralDesktop?.onNotification?.(() => {
      state.staleClicks++;
    });
  });
  await application.evaluate(() => {
    (globalThis as unknown as { notes: Electron.Notification[] }).notes[0]?.emit('click');
  });
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => (window as unknown as { staleClicks: number }).staleClicks),
    0,
    'old sidecar notifications never reach a restarted workspace',
  );
  assert.deepEqual(
    await application.evaluate(() => (globalThis as unknown as { errors: string[] }).errors),
    [],
  );
  console.log(
    'TC-DESK-010 H/N/F PASS: native click opens the exact pending Run and approval; resolved target stays put; legacy focus, SPA document and restart boundary survive. No OS notification displayed.',
  );
} finally {
  await application
    .evaluate(({ app, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      app.quit();
    })
    .catch(() => {});
  await application.close();
  rmSync(data, { recursive: true, force: true });
}
