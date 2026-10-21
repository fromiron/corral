import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';
import {
  panelTab,
  requestBox,
  startSession,
  teamFromTemplate,
} from '../../studio/e2e/workbench.ts';

// Real packaged window, native menu and persisted server. Only model replies use the
// already-supported mock mode; no production workspace or provider credential is opened.
const desktop = resolve(import.meta.dirname, '..');
const binary = resolve(process.argv[2] ?? join(desktop, 'release/win-unpacked/corral.exe'));
const data = mkdtempSync(join(tmpdir(), 'corral-native-smoke-'));
const original = join(data, 'preview-repository');
mkdirSync(original);
let forbiddenRequests = 0;
const canary = createServer((_request, response) => {
  forbiddenRequests++;
  response.end('A preview must not reach this unrelated origin.');
});
await new Promise<void>((done) => canary.listen(0, '127.0.0.1', done));
canary.unref();
const canaryAddress = canary.address();
assert(canaryAddress && typeof canaryAddress === 'object');
const forbiddenUrl = `http://127.0.0.1:${canaryAddress.port}/outside`;
const gitPath =
  process.env.CORRAL_TEST_GIT ??
  execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)[0];
if (!gitPath || !isAbsolute(gitPath)) throw new Error('Installed Git executable is required');
const git = (...args: string[]) =>
  execFileSync(
    gitPath,
    [
      '-c',
      'user.name=Native verification',
      '-c',
      'user.email=verification@example.invalid',
      ...args,
    ],
    { cwd: original, windowsHide: true },
  );
git('init', '-q');
writeFileSync(
  join(original, 'index.html'),
  `<!doctype html><link rel="stylesheet" href="/style.css"><h1>Native interactive preview</h1><button onclick="document.querySelector('p').textContent='Count: 1'">Add</button><p>Count: 0</p><a href="${forbiddenUrl}">Leave preview</a>`,
);
writeFileSync(join(original, 'style.css'), 'h1 { color: rgb(25, 90, 40); }');
git('add', '.');
git('commit', '-q', '-m', 'Native preview fixture');
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'win32')
  env.PATH = `${join(process.env.SystemRoot ?? 'C:/Windows', 'System32')};${dirname(gitPath)}`;
if (process.platform === 'linux') {
  const hostTools = join(data, 'host-tools');
  mkdirSync(hostTools);
  const excluded = new Set(['node', 'nodejs', 'npm', 'npx', 'pnpm', 'pnpx', 'corepack', 'fnm']);
  for (const name of readdirSync('/usr/bin'))
    if (!excluded.has(name)) symlinkSync(join('/usr/bin', name), join(hostTools, name));
  env.PATH = hostTools;
}
const launch = () =>
  _electron.launch({
    executablePath: binary,
    args: [
      `--data-dir=${data}`,
      '--mock-only',
      '--lang=en-US',
      '--use-fake-device-for-media-stream',
    ],
    env,
    timeout: 60000,
  });
let application: Awaited<ReturnType<typeof launch>> | null = null;
let failedFlow = false;
const pendingRequests = new Map<unknown, string>();
let runRequest: unknown;
async function observeNativeErrors() {
  await application?.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      nativeSmokeErrors: { title: string; message: string }[];
    };
    state.nativeSmokeErrors = [];
    // Observe native error dialogs so a failed product flow reports its actual error
    // instead of indefinitely blocking the isolated test behind an OS modal.
    dialog.showErrorBox = (title, message) => state.nativeSmokeErrors.push({ title, message });
  });
}
async function waitForQuit(pending: Promise<unknown>) {
  try {
    await pending;
  } catch (error) {
    const errors = await application
      ?.evaluate(
        () => (globalThis as unknown as { nativeSmokeErrors: unknown[] }).nativeSmokeErrors,
      )
      .catch(() => []);
    throw new Error(`Native quit did not complete: ${JSON.stringify(errors)}`, { cause: error });
  }
}
async function closePalette(page: import('@playwright/test').Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  // Visibility precedes React's focus effect; keyboard input must target the actual field.
  await expect(dialog.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}
async function nativeMenu(label: string, checked?: boolean) {
  if (!application) throw new Error('Application missing');
  await application.evaluate(
    ({ Menu }, selection) => {
      const localized: Record<string, string> = {
        'Command palette': '명령 팔레트',
        'Close window to tray': '창을 닫으면 트레이로 숨기기',
        'Also keep awake while paused or awaiting input': '일시정지·응답 대기 중에도 절전 방지',
        Quit: '종료',
        'Remote hosts…': '원격 호스트…',
      };
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined =>
        items.find(
          (item) => item.label === selection.label || item.label === localized[selection.label],
        ) ??
        items.flatMap((item) => (item.submenu ? [find(item.submenu.items)] : [])).find(Boolean);
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item?.enabled) throw new Error(`Native menu missing: ${selection.label}`);
      if (selection.checked === undefined || item.checked !== selection.checked) item.click();
    },
    { label, checked },
  );
}
try {
  application = await launch();
  await observeNativeErrors();
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(`Native renderer error: ${error.message}`);
  });
  page.on('request', (request) => {
    pendingRequests.set(request, `${request.method()} ${new URL(request.url()).pathname}`);
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/runs')
      runRequest = request.postDataJSON();
  });
  page.on('requestfinished', (request) => pendingRequests.delete(request));
  page.on('requestfailed', (request) => pendingRequests.delete(request));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60000 });
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  if (await page.getByRole('button', { name: '설정', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('combobox', { name: '언어', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  }
  // Exercise the real permission callback with Chromium's synthetic device. No
  // microphone audio is captured and no provider connection is opened by this check.
  await application.evaluate(({ dialog }) => {
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = (async (...args: Parameters<typeof previous>) => {
      const options = args.at(-1) as Electron.MessageBoxOptions;
      if (['Microphone access', '마이크 사용'].includes(options.title ?? '')) {
        dialog.showMessageBox = previous;
        return { response: 1, checkboxChecked: false };
      }
      return Reflect.apply(previous, dialog, args);
    }) as typeof previous;
  });
  assert.equal(
    await page.evaluate(async () => {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const count = media.getAudioTracks().length;
      for (const track of media.getTracks()) track.stop();
      return count;
    }),
    1,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: true });
        for (const track of media.getTracks()) track.stop();
        return 'unexpected camera grant';
      } catch (error) {
        return (error as Error).name;
      }
    }),
    'NotAllowedError',
  );
  console.log('Native permission boundary: synthetic audio allowed after consent; camera denied.');
  await page.getByRole('tab', { name: /^Project folder/ }).click();
  const folder = page.getByRole('tabpanel', { name: 'Project folder' });
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, original);
  await folder.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await expect(folder.getByText(original, { exact: true })).toBeVisible();
  await folder.getByRole('button', { name: 'Link folder', exact: true }).click();
  const trust = folder.getByRole('checkbox', { name: /Trust this repository/ });
  const trustResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith('/projects/default/workspace'),
  );
  const [trustedResponse] = await Promise.all([
    trustResponse,
    (async () => {
      await trust.focus();
      await trust.press('Space');
    })(),
  ]);
  assert.equal(trustedResponse.status(), 200);
  await expect(trust).toBeChecked({ timeout: 30000 });
  await teamFromTemplate(page);
  await startSession(page, 'Native package validation');
  await panelTab(page, 'Files');
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const workingCopy = page.getByRole('region', { name: 'Working copy' });
  await expect(workingCopy).toBeVisible({ timeout: 30000 });
  const createCopy = workingCopy.getByRole('button', { name: /Make a working copy from/ });
  if (await createCopy.isVisible()) {
    await createCopy.click();
    await expect(
      workingCopy.getByRole('link', { name: 'Review changes', exact: true }),
    ).toBeVisible({ timeout: 30000 });
  }
  console.log('Native folder picker, trust and real Git working copy are ready.');
  await requestBox(page).fill('Write a brief native package validation note.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('chat-timeline').getByText('Succeeded')).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open index.html', exact: true }).click();
  await page.getByRole('button', { name: 'Open preview', exact: true }).click();
  const staticFrame = page.frameLocator('[data-testid="file-preview-frame"]');
  await expect(
    staticFrame.getByRole('heading', { name: 'Native interactive preview' }),
  ).toBeVisible();
  await staticFrame.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(staticFrame.getByText('Count: 0', { exact: true })).toBeVisible();
  const previewUrl = await page.getByTestId('file-preview-frame').getAttribute('src');
  assert(previewUrl);
  await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  await expect
    .poll(() =>
      application
        ?.context()
        .pages()
        .some((item) => item.url() === previewUrl),
    )
    .toBe(true);
  const interactive = application
    .context()
    .pages()
    .find((item) => item.url() === previewUrl);
  assert(interactive, 'native WebContentsView is exposed as the real preview page');
  await expect(interactive.getByRole('heading', { name: 'Native interactive preview' })).toHaveCSS(
    'color',
    'rgb(25, 90, 40)',
  );
  await interactive.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(interactive.getByText('Count: 1', { exact: true })).toBeVisible();
  assert.equal(
    await interactive.evaluate(() => 'corralDesktop' in window || 'require' in window),
    false,
  );
  const jars = await application.evaluate(async ({ webContents }, target) => {
    const all = webContents.getAllWebContents();
    const preview = all.find((contents) => contents.getURL() === target);
    const studio = all.find((contents) => /^http:\/\/127\.0\.0\.1:\d+\//.test(contents.getURL()));
    if (!preview || !studio) throw new Error('Both actual content surfaces are required');
    return {
      isolated: preview.session !== studio.session,
      preview: await preview.session.cookies.get({}),
    };
  }, previewUrl);
  assert.equal(jars.isolated, true);
  assert.deepEqual(jars.preview, []);
  const blocked = application.evaluate(({ webContents }, target) => {
    const preview = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === target);
    if (!preview) throw new Error('Preview is missing');
    return new Promise<boolean>((done) =>
      preview.once('will-navigate', (event) => done(event.defaultPrevented)),
    );
  }, previewUrl);
  await interactive
    .getByRole('link', { name: 'Leave preview', exact: true })
    .click({ noWaitAfter: true });
  assert.equal(await blocked, true);
  assert.equal(forbiddenRequests, 0);
  // Chromium reports a scheduled navigation even when Electron prevents it.
  // Read the actual native surface rather than waiting for an intentionally absent commit.
  const retained = await application.evaluate(async ({ webContents }, target) => {
    const preview = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === target);
    if (!preview) throw new Error('Preview navigated away from its lease');
    return {
      url: preview.getURL(),
      count: await preview.executeJavaScript("document.querySelector('p').textContent"),
      image: (await preview.capturePage()).toPNG().toString('base64'),
    };
  }, previewUrl);
  assert.equal(retained.url, previewUrl);
  assert.equal(retained.count, 'Count: 1');
  mkdirSync(join(desktop, 'release'), { recursive: true });
  writeFileSync(
    join(desktop, 'release/native-interactive-preview.png'),
    Buffer.from(retained.image, 'base64'),
  );
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect.poll(() => interactive.isClosed()).toBe(true);
  console.log(
    'Native interactive preview: JS/CSS, cookie isolation, blocked navigation and lease closure passed.',
  );
  await requestBox(page).fill('Draft preserved across a packaged restart');
  const route = new URL(page.url()).pathname;
  await nativeMenu('Command palette');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await closePalette(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  const edit = page.getByRole('button', {
    name: 'Change shortcut for Command palette',
    exact: true,
  });
  await edit.click();
  await edit.press('Control+Shift+k');
  await expect(edit).toHaveText('Ctrl+Shift+K');
  await expect
    .poll(() =>
      application?.evaluate(({ Menu }) => {
        const all = (items: Electron.MenuItem[]): Electron.MenuItem[] =>
          items.flatMap((item) => [item, ...(item.submenu ? all(item.submenu.items) : [])]);
        return all(Menu.getApplicationMenu()?.items ?? []).find((item) =>
          ['Command palette', '명령 팔레트'].includes(item.label),
        )?.accelerator;
      }),
    )
    .toBe('CommandOrControl+Shift+K');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await closePalette(page);
  await page.getByRole('link', { name: 'Back to work', exact: true }).click();
  const managerOpened = application.waitForEvent('window');
  await nativeMenu('Remote hosts…');
  const manager = await managerOpened;
  await manager.waitForURL('corral://hosts/');
  await expect(manager.locator('input[name="sshAlias"]')).toBeVisible();
  await expect(manager.locator('input[name="bootstrapUrl"]')).toHaveAttribute('type', 'password');
  mkdirSync(join(desktop, 'release'), { recursive: true });
  await manager.screenshot({ path: join(desktop, 'release/native-remote-hosts.png') });
  assert.equal(
    await manager.evaluate(
      () => typeof (window as unknown as { corralDesktop?: unknown }).corralDesktop,
    ),
    'undefined',
  );
  await manager.close();
  console.log('Native shortcut remap and isolated remote-host manager passed.');
  await nativeMenu('Close window to tray', true);
  await nativeMenu('Also keep awake while paused or awaiting input', true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect
    .poll(() =>
      application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    )
    .toBe(false);
  assert.equal(application.process().exitCode, null, 'closing to tray retains the real host');
  // A second real process uses Electron's single-instance lock to restore the hidden window.
  await promisify(execFile)(binary, [`--data-dir=${data}`, '--mock-only', '--lang=en-US'], {
    env,
    timeout: 10000,
    windowsHide: true,
  });
  await expect
    .poll(() =>
      application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    )
    .toBe(true);
  mkdirSync(join(desktop, 'release'), { recursive: true });
  await page.screenshot({ path: join(desktop, `release/native-smoke-${process.platform}.png`) });
  const closed = application.waitForEvent('close', { timeout: 20000 });
  await nativeMenu('Quit');
  await waitForQuit(closed);
  const saved = JSON.parse(readFileSync(join(data, 'desktop.json'), 'utf8'));
  assert.equal(saved.closeToTray, true);
  assert.equal(saved.keepAwakeWhileWaiting, true);
  application = await launch();
  await observeNativeErrors();
  const restored = await application.firstWindow();
  await restored.waitForURL((url) => url.pathname === route, { timeout: 60000 });
  await expect(requestBox(restored)).toHaveValue('Draft preserved across a packaged restart');
  await expect(restored.getByTestId('chat-timeline').getByText('Succeeded')).toBeVisible();
  await restored.keyboard.press('Control+Shift+k');
  await expect(restored.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await closePalette(restored);
  await restored.getByRole('button', { name: 'Settings', exact: true }).click();
  await restored.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  await restored.getByRole('button', { name: 'Reset shortcuts', exact: true }).click();
  await restored.keyboard.press('Control+k');
  await expect(restored.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await closePalette(restored);
  await restored.getByRole('link', { name: 'Back to work', exact: true }).click();
  assert.deepEqual(errors, []);
  // A WebContentsView's blank native parent must not stall the unsaved-edit probe.
  await panelTab(restored, 'Files');
  await restored.getByRole('button', { name: 'Open index.html', exact: true }).click();
  await restored.getByRole('button', { name: 'Open preview', exact: true }).click();
  await restored.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  await expect
    .poll(() =>
      application
        ?.context()
        .pages()
        .some((item) => item.url().startsWith('http://127.0.0.2:')),
    )
    .toBe(true);
  const done = application.waitForEvent('close', { timeout: 20000 });
  await nativeMenu('Quit');
  await waitForQuit(done);
  application = null;
  console.log(
    'TC-ABS-007-H TC-ABS-004-H PASS: packaged window, UI request, isolated interactive preview, shortcut remap, remote-host form, persisted history/draft, tray, second-instance restore, restart; no host Node/pnpm.',
  );
} catch (error) {
  failedFlow = true;
  console.error('Native smoke flow failure:', error);
  const nativeErrors = await application
    ?.evaluate(() => (globalThis as unknown as { nativeSmokeErrors?: unknown[] }).nativeSmokeErrors)
    .catch(() => []);
  if (nativeErrors?.length) console.error(JSON.stringify(nativeErrors));
  const failed = application
    ?.context()
    .pages()
    .find((item) => /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url()));
  if (failed) {
    const state = await failed
      .evaluate(async () => {
        const response = await fetch('/api/v1/runs', { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return { status: response.status };
        const runs = (await response.json()) as { runId: string; status: string }[];
        const read = async (path: string) => {
          const result = await fetch(path, { signal: AbortSignal.timeout(3000) });
          return { status: result.status, body: await result.json() };
        };
        const corrals = (await (await fetch('/api/v1/corrals')).json()) as { corralId: string }[];
        return {
          runs,
          snapshots: await Promise.all(
            runs.map((run) => read(`/api/v1/runs/${run.runId}/snapshot`)),
          ),
          corrals: await Promise.all(
            corrals.map((corral) => read(`/api/v1/corrals/${corral.corralId}`)),
          ),
        };
      })
      .catch(() => 'Server readback unavailable');
    const report = {
      state,
      runRequest,
      pendingRequests: [...pendingRequests.values()],
      workspace: data,
    };
    mkdirSync(resolve(desktop, '../../test-results'), { recursive: true });
    writeFileSync(
      resolve(desktop, '../../test-results/native-smoke-runtime-readback.json'),
      JSON.stringify(report, null, 2),
    );
    console.error(
      'Native failure readback saved; pending requests:',
      JSON.stringify(report.pendingRequests),
    );
    mkdirSync(join(desktop, 'release'), { recursive: true });
    await failed
      .screenshot({ path: join(desktop, 'release/native-smoke-failure.png') })
      .catch(() => {});
  }
  throw error;
} finally {
  if (application) {
    await application
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      })
      .catch(() => {});
    await nativeMenu('Quit').catch(() => {});
    if (application.process().exitCode === null) {
      // Test failure cleanup only. This is never counted as a successful native quit.
      await application.evaluate(({ app }) => app.exit(1)).catch(() => {});
    }
    await application.close().catch(() => {});
  }
  const resolved = resolve(data);
  const fromTemp = relative(resolve(tmpdir()), resolved);
  assert(
    !isAbsolute(fromTemp) &&
      !fromTemp.startsWith('..') &&
      fromTemp.startsWith('corral-native-smoke-'),
  );
  if (failedFlow && process.env.CORRAL_NATIVE_RETAIN_FAILED === '1')
    console.log(`Retained isolated failed fixture: ${resolved}`);
  else rmSync(resolved, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  await new Promise<void>((done, reject) =>
    canary.close((error) => (error ? reject(error) : done())),
  );
}
