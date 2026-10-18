import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';

// An isolated app-data directory: this test never opens a person's Corral workspace.
const desktop = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'corral-desktop-smoke-'));
const binary = process.argv[2];
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const hostTools = join(data, 'host-tools');
mkdirSync(hostTools);
const excluded = new Set(['node', 'nodejs', 'npm', 'npx', 'pnpm', 'pnpx', 'corepack', 'fnm']);
for (const name of readdirSync('/usr/bin'))
  if (!excluded.has(name)) symlinkSync(join('/usr/bin', name), join(hostTools, name));
assert(!existsSync(join(hostTools, 'node')) && !existsSync(join(hostTools, 'pnpm')));
env.PATH = hostTools;
env.LANG = 'en_US.UTF-8';
delete env.ELECTRON_RUN_AS_NODE;
const launch = () =>
  _electron.launch({
    ...(binary ? { executablePath: resolve(binary) } : {}),
    args: [...(binary ? [] : [desktop]), `--data-dir=${data}`, '--mock-only'],
    env,
    chromiumSandbox: true,
    timeout: 30000,
  });
let application: Awaited<ReturnType<typeof launch>> | null = null;
try {
  console.log('Launching isolated app');
  application = await launch();
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  console.log('Window attached');
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  // CR-017: the system draws the window buttons over the top bar; Studio draws none of its own.
  await expect(page.getByRole('button', { name: 'Close window' })).toHaveCount(0);
  console.log(
    'Window controls overlay:',
    await page.evaluate(
      () =>
        (navigator as unknown as { windowControlsOverlay?: { visible: boolean } })
          .windowControlsOverlay?.visible ?? 'unsupported',
    ),
  );
  // Double-clicking the empty top bar maximizes, as a system title bar does.
  await page.getByRole('banner').dispatchEvent('dblclick');
  await expect
    .poll(() =>
      application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized()),
    )
    .toBe(true);
  await promisify(execFile)(
    binary ? resolve(binary) : application.process().spawnfile,
    [...(binary ? [] : [desktop]), `--data-dir=${data}`, '--mock-only'],
    { env, timeout: 10000 },
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isMaximized(),
    ),
    true,
    'second launch preserves the existing window',
  );
  await page.getByRole('banner').dispatchEvent('dblclick');
  // CR-017: a native menu item runs the page's own command (the palette here).
  await application.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined =>
      items.find((item) => item.label === 'Command palette') ??
      items.flatMap((item) => (item.submenu ? [find(item.submenu.items)] : [])).find(Boolean);
    find(Menu.getApplicationMenu()?.items ?? [])?.click();
  });
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('region', { name: 'Start from a template' })
    .getByRole('article')
    .filter({ hasText: 'Single agent' })
    .getByRole('button', { name: 'Edit this team' })
    .click();
  await page.getByRole('link', { name: 'Project home', exact: true }).click();
  await page.getByText('Session details (optional)', { exact: true }).click();
  await page.getByLabel('Purpose').fill('Desktop packaged smoke');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page
    .getByRole('combobox', { name: 'Request', exact: true })
    .fill('Write a short desktop smoke note.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible();
  await application.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { confirmationCount: number };
    state.confirmationCount = 0;
    dialog.showMessageBox = async () => {
      state.confirmationCount++;
      return { response: 0, checkboxChecked: false };
    };
  });
  const closeWindow = () =>
    application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closeWindow();
  await expect
    .poll(() =>
      application?.evaluate(
        () => (globalThis as unknown as { confirmationCount: number }).confirmationCount,
      ),
    )
    .toBe(1);
  assert.equal(application.process().exitCode, null, 'Keep running does not close the app');
  await page.getByRole('button', { name: 'Resume run', exact: true }).click();
  await expect(
    page.getByTestId('chat-timeline').getByText('Succeeded', { exact: false }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  // CR-017: the window follows the page's theme.
  await expect
    .poll(() =>
      application?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase(),
      ),
    )
    .toBe('#151615');
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Request', exact: true })
    .fill('A draft preserved across restart');
  mkdirSync(join(desktop, 'release'), { recursive: true });
  await page.screenshot({ path: join(desktop, 'release/desktop-smoke.png') });
  const closed = application.waitForEvent('close');
  await closeWindow();
  await closed;
  console.log('Launching isolated app');
  application = await launch();
  const restored = await application.firstWindow();
  await restored.waitForURL(/\/sessions\/session_/, { timeout: 30000 });
  await expect(
    restored.getByTestId('chat-timeline').getByText('Succeeded', { exact: false }),
  ).toBeVisible();
  await expect(restored.getByRole('combobox', { name: 'Request', exact: true })).toHaveValue(
    'A draft preserved across restart',
  );
  await expect(restored.locator('html')).toHaveAttribute('data-theme', 'dark');
  const frame = await restored.evaluate(() => ({
    node: typeof (window as unknown as { require?: unknown }).require,
    bridge: typeof (window as unknown as { corralDesktop?: unknown }).corralDesktop,
  }));
  assert.deepEqual(frame, { node: 'undefined', bridge: 'object' });
  await restored.getByRole('button', { name: 'Send', exact: true }).click();
  await restored.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(restored.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible();
  const pid = await application.evaluate(() => process.pid);
  assert(pid);
  const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  const sidecar = children.find((child) => {
    try {
      const args = readFileSync(`/proc/${child}/cmdline`, 'utf8').split('\0');
      return (
        args.some((arg) => arg.endsWith('/server/sidecar.mjs')) &&
        args.includes(join(data, 'workspaces/default'))
      );
    } catch {
      return false;
    }
  });
  assert(sidecar, 'only this test app owns the selected sidecar');
  console.log('Checking sidecar recovery');
  process.kill(sidecar, 'SIGKILL');
  await restored.waitForURL('corral://startup/');
  await restored.getByRole('button', { name: 'Try again', exact: true }).click();
  await restored.waitForURL(/\/sessions\/session_/, { timeout: 30000 });
  await expect(
    restored
      .getByTestId('chat-timeline')
      .getByRole('note')
      .filter({ hasText: 'Not finished (Interrupted)' }),
  ).toBeVisible();
  await expect(restored.getByRole('button', { name: 'Resume run', exact: true })).toHaveCount(0);
  await restored.getByRole('combobox', { name: 'Request', exact: true }).fill('Quit while paused');
  await restored.getByRole('button', { name: 'Send', exact: true }).click();
  await restored.getByRole('button', { name: 'Pause run', exact: true }).click();
  await expect(restored.getByRole('button', { name: 'Resume run', exact: true })).toBeVisible();
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const stopped = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await stopped;
  console.log('Active-run quit accepted; checking failed startup');
  const stateFile = join(data, 'desktop.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const blocked = join(data, 'blocked-workspace');
  writeFileSync(blocked, 'not a directory');
  writeFileSync(stateFile, JSON.stringify({ ...state, workspace: blocked, route: '/' }));
  console.log('Launching isolated app');
  application = await launch();
  const recovery = await application.firstWindow();
  await expect(
    recovery.getByRole('heading', { name: 'Could not open this workspace' }),
  ).toBeVisible({ timeout: 30000 });
  rmSync(blocked);
  mkdirSync(blocked);
  await recovery.getByRole('button', { name: 'Try again', exact: true }).click();
  await recovery.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  await application.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, state.workspace);
  await recovery.evaluate(() => {
    void (
      window as unknown as { corralDesktop: { openWorkspace: () => Promise<void> } }
    ).corralDesktop.openWorkspace();
  });
  await expect(
    recovery.getByTestId('app-sidebar').getByRole('link', { name: /^Desktop packaged smoke/ }),
  ).toBeVisible({
    timeout: 30000,
  });
  await recovery
    .getByTestId('app-sidebar')
    .getByRole('link', { name: /^Desktop packaged smoke/ })
    .click();
  await expect(
    recovery
      .getByTestId('chat-timeline')
      .getByRole('note')
      .filter({ hasText: 'Not finished (Interrupted)' }),
  ).toHaveCount(2);
  console.log('Checking renderer recovery');
  const rendererPid = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
  );
  assert(rendererPid);
  const crashed = recovery.waitForEvent('crash');
  process.kill(rendererPid, 'SIGKILL');
  await crashed;
  // Playwright marks the crashed target permanently; inspect the recovered renderer through Electron.
  await expect
    .poll(
      () =>
        application?.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (!contents || contents.isLoading() || contents.getURL() !== 'corral://startup/')
            return null;
          return contents.executeJavaScript('document.getElementById("title")?.textContent');
        }),
      { timeout: 15000 },
    )
    .toBe('Could not open this workspace');
  await application.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
      'document.getElementById("retry").click()',
    );
  });
  await expect
    .poll(
      () =>
        application?.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]?.webContents;
          if (
            !contents ||
            contents.isLoading() ||
            !contents.getURL().includes('/sessions/session_')
          )
            return false;
          return contents.executeJavaScript(
            'document.querySelector("[data-testid=chat-timeline]")?.textContent.includes("Interrupted") ?? false',
          );
        }),
      { timeout: 30000 },
    )
    .toBe(true);
  assert.deepEqual(errors, []);
  console.log(
    'DW-07 passed: isolated desktop, SQLite history, draft/theme/route, single instance, quit decisions, renderer/sidecar recovery, startup retry and workspace reopening; no host Node/pnpm.',
  );
} finally {
  console.log('Cleaning up isolated app');
  const force = setTimeout(() => application?.process().kill('SIGKILL'), 5000);
  try {
    await application
      ?.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await application?.close().catch(() => {});
  } finally {
    clearTimeout(force);
  }
  rmSync(data, { recursive: true, force: true });
}
