import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, expect, type Page } from '@playwright/test';

// One real Desktop feedback loop. The sidecar's existing mock mode never calls a provider;
// the explicit document save below is fixture input, not a claim that a model edited code.
const desktop = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'corral-p20-smoke-'));
const original = join(data, 'preview-repository');
mkdirSync(original);
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((done, reject) => probe.close((error) => (error ? reject(error) : done())));
writeFileSync(
  join(original, 'package.json'),
  JSON.stringify({
    name: 'corral-preview-feedback-fixture',
    private: true,
    scripts: { dev: 'node server.cjs' },
  }),
);
writeFileSync(join(original, 'headline.txt'), 'P20 preview before feedback');
writeFileSync(
  join(original, 'style.css'),
  'body{margin:40px;background:#f7f8f5;font:18px system-ui}h1{color:rgb(20,90,65)}button{padding:12px 24px;font:inherit}',
);
writeFileSync(
  join(original, 'index.html'),
  `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/style.css"><title>P20 owned preview</title></head><body><h1 id="headline">P20 preview before feedback</h1><button id="add">Add</button><p id="count">Count: 0</p><script>
let count=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent='Count: '+(++count);
setInterval(()=>fetch('/headline.txt',{cache:'no-store'}).then(r=>r.text()).then(text=>document.querySelector('#headline').textContent=text),250);
</script></body></html>`,
);
writeFileSync(
  join(original, 'server.cjs'),
  `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const files={'/':['index.html','text/html'],'/style.css':['style.css','text/css'],'/headline.txt':['headline.txt','text/plain']};
http.createServer((req,res)=>{const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,file[0])));}).listen(${port},'127.0.0.1',()=>console.log('P20_READY'));
`,
);
const git = (...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=P20 fixture',
      '-c',
      'user.email=p20@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: original,
      stdio: 'ignore',
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    },
  );
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-qm', 'Preview feedback fixture');
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
delete env.ELECTRON_RUN_AS_NODE;
env.LANG = 'en_US.UTF-8';
const application = await _electron.launch({
  ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}),
  args: [desktop, `--data-dir=${data}`, '--mock-only', '--lang=en-US'],
  env,
  timeout: 30000,
});
let page: Page | undefined;
let stage = 'startup';
let sessionId = '';
let failed = true;
const rendererErrors: string[] = [];
const runRequests: {
  mode?: string;
  references?: {
    kind: string;
    provenance?: { kind: string; leaseId?: string; sourceRevision?: null };
    text?: string;
  }[];
}[] = [];

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  assert(page);
  // Electron owns the Studio cookie partition; APIRequestContext does not share that jar.
  const response = await page.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch('/api/v1/session', { signal: AbortSignal.timeout(10000) });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const reply = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          'x-corral-csrf': csrfToken,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      return {
        ok: reply.ok,
        status: reply.status,
        body: reply.status === 204 ? undefined : await reply.json(),
      };
    },
    { path, method, body },
  );
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.body as T;
}
function phase(value: string) {
  stage = value;
  console.log(`P20: ${value}`);
}
async function previewPage(url: string) {
  await expect
    .poll(
      () =>
        application
          .context()
          .pages()
          .some((candidate) => candidate.url() === url),
      { timeout: 10000 },
    )
    .toBe(true);
  const found = application
    .context()
    .pages()
    .find((candidate) => candidate.url() === url);
  assert(found, 'The actual WebContentsView page is required');
  found.setDefaultTimeout(10000);
  return found;
}
try {
  page = await application.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(15000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/runs')
      runRequests.push(request.postDataJSON());
  });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  if (await page.getByRole('button', { name: '설정', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('combobox', { name: '언어', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  }

  phase('isolated fixture setup');
  const definition = JSON.parse(
    readFileSync(resolve(desktop, '../../examples/eval/single-agent.corral.json'), 'utf8'),
  );
  definition.id = 'p20_feedback_team';
  definition.name = 'Preview feedback fixture';
  const team = await api<{ record: { corralId: string } }>('/corrals', 'POST', {
    definition,
    projectId: 'default',
    layout: {
      nodes: { answer: { x: 80, y: 120 }, output: { x: 360, y: 120 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
  await api('/projects/default/workspace', 'PUT', { path: original });
  await api('/projects/default/workspace', 'PATCH', { trusted: true });
  const created = await api<{ session: { sessionId: string } }>('/sessions', 'POST', {
    projectId: 'default',
    title: 'Preview feedback core',
    corralId: team.record.corralId,
  });
  sessionId = created.session.sessionId;
  await api(`/sessions/${sessionId}/worktree`, 'POST');
  const development = await api<{ target: Record<string, unknown> }>(
    `/sessions/${sessionId}/worktree/development`,
  );
  await api(`/sessions/${sessionId}/worktree/development`, 'POST', {
    operationId: 'p20_development',
    target: development.target,
  });
  await page.goto(`${new URL(page.url()).origin}/sessions/${sessionId}?panel=tools`);
  await expect(page.getByTestId('workbench-tasks')).toBeVisible();
  await page.getByRole('button', { name: 'Run dev', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dev', exact: true })).toBeVisible();
  const tasks = await api<{ tasks: { operationId: string; state: string; pid?: number }[] }>(
    `/sessions/${sessionId}/worktree/tasks`,
  );
  const task = tasks.tasks.find((item) => item.state === 'running');
  assert(task);
  await expect
    .poll(
      async () =>
        (
          await api<{ text: string }>(
            `/sessions/${sessionId}/worktree/tasks/${task.operationId}/output?offset=0`,
          )
        ).text,
      { timeout: 15000 },
    )
    .toContain('P20_READY');
  await page.getByRole('spinbutton', { name: 'Port', exact: true }).fill(String(port));
  const opening = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/previews`,
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  const opened = await opening;
  assert(opened.ok(), `Preview start failed: HTTP ${opened.status()}`);
  const lease = (await opened.json()) as { leaseId: string; url: string; state: string };
  assert.equal(lease.state, 'ready');
  let preview = await previewPage(lease.url);

  phase('actual preview CSS, JavaScript and isolation');
  await expect(preview.getByRole('heading', { name: 'P20 preview before feedback' })).toHaveCSS(
    'color',
    'rgb(20, 90, 65)',
  );
  await preview.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(preview.getByText('Count: 1', { exact: true })).toBeVisible();
  assert.equal(
    await preview.evaluate(
      () => 'corralDesktop' in window || 'corralRemote' in window || 'require' in window,
    ),
    false,
  );
  const isolated = await application.evaluate(
    async ({ webContents }, urls) => {
      const all = webContents.getAllWebContents();
      const studio = all.find((contents) => contents.getURL() === urls.studio);
      const preview = all.find((contents) => contents.getURL() === urls.preview);
      if (!studio || !preview) return false;
      return (
        studio.session !== preview.session && (await preview.session.cookies.get({})).length === 0
      );
    },
    { studio: page.url(), preview: lease.url },
  );
  assert(isolated, 'Preview has its own empty cookie jar');
  await preview.screenshot({ path: '/tmp/corral-p20-preview.png' });

  phase('native close and reopen the same active lease');
  await application.evaluate(({ BrowserWindow }, url) => {
    const owner = BrowserWindow.getAllWindows().find((window) =>
      window.contentView.children.some((child) => {
        const contents = (child as Electron.WebContentsView).webContents;
        return contents && !contents.isDestroyed() && contents.getURL() === url;
      }),
    );
    if (!owner) throw new Error('Preview owner window missing');
    owner.close();
  }, lease.url);
  await expect.poll(() => preview.isClosed(), { timeout: 5000 }).toBe(true);
  await page.evaluate(
    async ({ sessionId, leaseId }) => {
      await (
        window as unknown as {
          corralDesktop: { openPreview(sessionId: string, leaseId: string): Promise<void> };
        }
      ).corralDesktop.openPreview(sessionId, leaseId);
    },
    { sessionId, leaseId: lease.leaseId },
  );
  preview = await previewPage(lease.url);
  await expect(preview.getByRole('heading', { name: 'P20 preview before feedback' })).toBeVisible();

  phase('user capture, review and attachment confirmation');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Capture preview feedback', exact: true }).click();
  await expect(
    page.getByText(
      'In the preview, right-click an element or focus it and press Shift+F10. Press Escape to cancel.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        application.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === url)
              ?.listenerCount('context-menu') ?? 0,
          lease.url,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
  await preview
    .getByRole('heading', { name: 'P20 preview before feedback' })
    .click({ button: 'right' });
  const review = page.getByRole('dialog', { name: 'Review preview feedback', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText('P20 preview before feedback');
  await expect(review.locator('img')).toBeVisible();
  await page.screenshot({ path: '/tmp/corral-p20-review.png', animations: 'disabled' });
  await review.getByRole('button', { name: 'Attach to request', exact: true }).click();
  await expect(review).toHaveCount(0);
  await page.screenshot({ path: '/tmp/corral-p20-attached.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Request options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Request options', exact: true });
  await options
    .getByRole('checkbox', { name: 'Review only · no file changes', exact: true })
    .check();
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  const request = page.getByRole('combobox', { name: 'Request', exact: true });
  await request.fill(
    'Review this selected preview heading. The test will apply the fixture change explicitly afterward.',
  );
  phase('image capability refusal preserves both attachments');
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/runs',
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const response = await sent;
  assert.equal(
    response.status(),
    403,
    'The existing simulated model has no image-input capability',
  );
  const refused = (await response.json()) as {
    runId: string | null;
    receipt: { error?: { code: string; message: string } };
  };
  assert.equal(refused.runId, null);
  assert.equal(refused.receipt.error?.code, 'CAPABILITY_DENIED');
  assert.match(refused.receipt.error?.message ?? '', /image input support/);
  assert.equal(runRequests.length, 1, 'One image request was refused without creating a Run');
  assert.equal(runRequests[0]?.mode, 'mock');
  const references = runRequests[0]?.references ?? [];
  const text = references.find((item) => item.kind === 'text_attachment');
  assert.equal(text?.provenance?.kind, 'preview');
  assert.equal(text?.provenance?.leaseId, lease.leaseId);
  assert.equal(text?.provenance?.sourceRevision, null);
  assert(text?.text?.includes('P20 preview before feedback'));
  assert.equal(references.filter((item) => item.kind === 'image_attachment').length, 1);
  await expect(
    page.getByRole('button', { name: 'Remove image preview.png', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove preview-feedback.json', exact: true }),
  ).toHaveCount(1);
  await page.screenshot({ path: '/tmp/corral-p20-refused.png', animations: 'disabled' });
  phase('one text-only mock Run after explicitly removing the unsupported image');
  await page.getByRole('button', { name: 'Remove image preview.png', exact: true }).click();
  const retry = page.waitForResponse(
    (reply) =>
      reply.request().method() === 'POST' && new URL(reply.url()).pathname === '/api/v1/runs',
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const accepted = await retry;
  assert(accepted.ok(), `Text-only mock request failed: HTTP ${accepted.status()}`);
  const run = (await accepted.json()) as { runId: string | null };
  assert(run.runId);
  assert.equal(
    runRequests.length,
    2,
    'One refused image request and one successful text-only request',
  );
  assert.equal(runRequests[1]?.mode, 'mock');
  const acceptedReferences = runRequests[1]?.references ?? [];
  assert.equal(acceptedReferences.filter((item) => item.kind === 'image_attachment').length, 0);
  assert.deepEqual(
    acceptedReferences.find((item) => item.kind === 'text_attachment'),
    text,
  );
  await expect
    .poll(
      async () =>
        (await api<{ runId: string; status: string }[]>('/runs')).find(
          (item) => item.runId === run.runId,
        )?.status,
      { timeout: 15000 },
    )
    .toBe('succeeded');

  phase('explicit file save updates the same live preview');
  const document = await api<{ target: Record<string, unknown>; version: { sha256: string } }>(
    `/sessions/${sessionId}/worktree/document?path=headline.txt`,
  );
  const saved = await api<{ state: string }>(`/sessions/${sessionId}/worktree/documents`, 'POST', {
    operationId: 'p20_save_headline',
    kind: 'save',
    target: document.target,
    path: 'headline.txt',
    baseHash: document.version.sha256,
    editVersion: 1,
    text: 'P20 preview after feedback',
  });
  assert.equal(saved.state, 'succeeded');
  await expect(preview.getByRole('heading', { name: 'P20 preview after feedback' })).toBeVisible();
  assert.equal(preview.url(), lease.url);
  assert.equal(readFileSync(join(original, 'headline.txt'), 'utf8'), 'P20 preview before feedback');
  await preview.screenshot({ path: '/tmp/corral-p20-updated.png' });

  phase('task stop closes its preview automatically');
  await page.bringToFront();
  const toolsTab = page.getByRole('tab', { name: 'Tasks & preview', exact: true });
  await toolsTab.getByText('Tasks & preview', { exact: true }).click();
  await page.getByRole('button', { name: 'Stop dev', exact: true }).click();
  await expect.poll(() => preview.isClosed(), { timeout: 10000 }).toBe(true);
  const stopped = await api<{ tasks: { operationId: string; cleanupConfirmed?: boolean }[] }>(
    `/sessions/${sessionId}/worktree/tasks`,
  );
  assert.equal(
    stopped.tasks.find((item) => item.operationId === task.operationId)?.cleanupConfirmed,
    true,
  );
  await api(`/sessions/${sessionId}/worktree/development/p20_development/finish`, 'POST', {
    target: development.target,
  });
  assert.deepEqual(rendererErrors, []);
  failed = false;
  console.log(
    'P20 core preview feedback smoke passed: one image-capability refusal preserved attachments; one text-only mock Run succeeded. Screenshots: /tmp/corral-p20-{preview,review,attached,refused,updated}.png',
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: '/tmp/corral-p20-failure.png' }).catch(() => {});
    const controls = await page
      .locator('button,[role=dialog],[role=alert]')
      .allTextContents()
      .catch(() => []);
    writeFileSync(
      '/tmp/corral-p20-failure.json',
      JSON.stringify({ stage, controls, rendererErrors }, null, 2),
      { mode: 0o600 },
    );
  }
  console.error(`P20 failed at: ${stage}`);
  throw error;
} finally {
  if (page && sessionId && !page.isClosed()) {
    const tasks = await api<{ tasks: { operationId: string; state: string }[] }>(
      `/sessions/${sessionId}/worktree/tasks`,
    ).catch(() => ({ tasks: [] }));
    for (const task of tasks.tasks.filter((item) => item.state === 'running'))
      await api(`/sessions/${sessionId}/worktree/tasks/${task.operationId}/stop`, 'POST').catch(
        () => {},
      );
  }
  await application
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    })
    .catch(() => {});
  await application.close().catch(() => {});
  if (failed && process.env.CORRAL_P20_RETAIN_FAILED === '1')
    console.log(`Retained isolated fixture: ${data}`);
  else rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
